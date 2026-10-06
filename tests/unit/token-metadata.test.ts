import { describe, expect, it } from "vitest";
import { Address, Operation, StrKey, xdr, type rpc, type Transaction } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { TOKEN_METADATA_CONCURRENCY, readTokenMetadata } from "@/lib/soroban/token-metadata";
import { TokenDecimalsOutOfRangeError } from "@/lib/soroban/sep41";

const SOURCE = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function token(i: number): string {
  const raw = Buffer.alloc(32);
  raw.writeUInt32BE(i + 1, 28);
  return StrKey.encodeContract(raw);
}

// answers symbol()/decimals() like a token contract would, after a short delay,
// and records how many simulations are running at once
function tokenServer(decimalsOf: (contract: string) => number = () => 7) {
  const stats = { inFlight: 0, peak: 0, calls: [] as string[] };
  const server = {
    simulateTransaction: async (tx: Transaction) => {
      stats.inFlight += 1;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        const op = tx.operations[0] as Operation.InvokeHostFunction;
        const call = xdr.expectUnionVariant(
          op.func,
          "hostFunctionTypeInvokeContract",
        ).invokeContract;
        const contract = Address.fromScAddress(call.contractAddress).toString();
        const fn = call.functionName.toString();
        stats.calls.push(`${contract}.${fn}`);
        const retval =
          fn === "symbol" ? xdr.ScVal.scvString("TKN") : xdr.ScVal.scvU32(decimalsOf(contract));
        return { latestLedger: 1, minResourceFee: "0", result: { retval, auth: [] }, events: [] };
      } finally {
        stats.inFlight -= 1;
      }
    },
  } as unknown as rpc.Server;
  return { server, stats };
}

describe("readTokenMetadata", () => {
  it("keeps at most a few simulations in flight however many rows ask at once", async () => {
    const { server, stats } = tokenServer();
    const ids = Array.from({ length: 1_000 }, (_, i) => token(i));
    const all = await Promise.all(ids.map((id) => readTokenMetadata(server, id, SOURCE, TESTNET)));
    expect(all).toHaveLength(1_000);
    expect(all[0]).toEqual({ symbol: "TKN", decimals: 7 });
    expect(stats.calls).toHaveLength(2_000);
    expect(stats.peak).toBeLessThanOrEqual(TOKEN_METADATA_CONCURRENCY);
    expect(stats.peak).toBeGreaterThan(1);
  });

  it("reads one contract once while the same rows ask for it again", async () => {
    const { server, stats } = tokenServer();
    const id = token(1);
    const [a, b] = await Promise.all([
      readTokenMetadata(server, id, SOURCE, TESTNET),
      readTokenMetadata(server, id, SOURCE, TESTNET),
    ]);
    expect(a).toEqual(b);
    await readTokenMetadata(server, id, SOURCE, TESTNET);
    expect(stats.calls).toEqual([`${id}.symbol`, `${id}.decimals`]);
  });

  it("does not run a queued read whose row went away", async () => {
    const { server, stats } = tokenServer();
    const busy = Array.from({ length: TOKEN_METADATA_CONCURRENCY }, (_, i) =>
      readTokenMetadata(server, token(100 + i), SOURCE, TESTNET),
    );
    const controller = new AbortController();
    const dropped = readTokenMetadata(server, token(999), SOURCE, TESTNET, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
    await Promise.all(busy);
    expect(stats.calls.some((c) => c.startsWith(token(999)))).toBe(false);
  });

  it("passes a hostile decimals answer through as an error, and frees its slot", async () => {
    const bad = token(5);
    const { server } = tokenServer((c) => (c === bad ? 4_294_967_295 : 7));
    await expect(readTokenMetadata(server, bad, SOURCE, TESTNET)).rejects.toBeInstanceOf(
      TokenDecimalsOutOfRangeError,
    );
    const rest = await Promise.all(
      Array.from({ length: TOKEN_METADATA_CONCURRENCY * 2 }, (_, i) =>
        readTokenMetadata(server, token(200 + i), SOURCE, TESTNET),
      ),
    );
    expect(rest.every((m) => m.decimals === 7)).toBe(true);
  });
});
