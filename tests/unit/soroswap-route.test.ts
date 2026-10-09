import { describe, it, expect } from "vitest";
import {
  Account,
  Address,
  Asset,
  Operation,
  StrKey,
  scValToNative,
  xdr,
  type FeeBumpTransaction,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  NoSoroswapRouteError,
  buildSwapToXLM,
  quoteRouteToXLM,
} from "@/lib/adapters/soroswap/swap";
import type { SoroswapPairInfo } from "@/lib/adapters/soroswap/discovery";
import { MAINNET } from "@/lib/config/networks";
import { SimulationError, type simulateRead } from "@/lib/soroban/simulate";
import { i128 } from "@/lib/soroban/scval";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const XLM = Asset.native().contractId(MAINNET.passphrase);
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 1));
const USDC = StrKey.encodeContract(Buffer.alloc(32, 2));
const AQUA = StrKey.encodeContract(Buffer.alloc(32, 3));
const DEAD = StrKey.encodeContract(Buffer.alloc(32, 4));
const server = {} as unknown as rpc.Server;

function pair(a: string, b: string, r0 = 1_000n, r1 = 1_000n): SoroswapPairInfo {
  return {
    pair: StrKey.encodeContract(Buffer.alloc(32, 99)),
    token0: a,
    token1: b,
    reserve0: r0,
    reserve1: r1,
  };
}

// quotes router_get_amounts_out per path; a path missing from the table traps
// like a missing pair does on chain
function quotes(table: Record<string, bigint[]>, calls: string[] = []): typeof simulateRead {
  return (async (_s: unknown, _c: string, fn: string, args: xdr.ScVal[]) => {
    if (fn !== "router_get_amounts_out") throw new Error(`unexpected ${fn}`);
    const path = (scValToNative(args[1]!) as string[]).join(">");
    calls.push(path);
    const amounts = table[path];
    if (amounts === undefined) {
      throw new SimulationError("sim failed", "HostError: Error(Storage, MissingValue)", []);
    }
    return { retval: xdr.ScVal.scvVec(amounts.map((a) => i128(a))) };
  }) as unknown as typeof simulateRead;
}

const asset = { kind: "contract" as const, contractId: TOKEN };

describe("quoteRouteToXLM", () => {
  it("routes through a hop when the token has no XLM pair", async () => {
    const route = await quoteRouteToXLM(
      server,
      { assetIn: asset, amountIn: 100n, network: MAINNET, sourcePublicKey: USER },
      {
        loadPairs: async () => [pair(TOKEN, USDC), pair(USDC, XLM)],
        simulateRead: quotes({ [`${TOKEN}>${USDC}>${XLM}`]: [100n, 95n, 900n] }),
      },
    );
    expect(route).toEqual({ path: [TOKEN, USDC, XLM], amounts: [100n, 95n, 900n] });
  });

  it("picks the candidate with the most XLM out and skips empty pairs", async () => {
    const calls: string[] = [];
    const route = await quoteRouteToXLM(
      server,
      { assetIn: asset, amountIn: 100n, network: MAINNET, sourcePublicKey: USER },
      {
        loadPairs: async () => [
          pair(TOKEN, XLM),
          pair(TOKEN, USDC),
          pair(USDC, XLM),
          pair(TOKEN, AQUA),
          pair(AQUA, XLM),
          pair(TOKEN, DEAD),
          pair(DEAD, XLM, 0n, 5n),
        ],
        simulateRead: quotes(
          {
            [`${TOKEN}>${XLM}`]: [100n, 500n],
            [`${TOKEN}>${USDC}>${XLM}`]: [100n, 90n, 800n],
            [`${TOKEN}>${AQUA}>${XLM}`]: [100n, 70n, 600n],
          },
          calls,
        ),
      },
    );
    expect(route.path).toEqual([TOKEN, USDC, XLM]);
    expect(calls).not.toContain(`${TOKEN}>${DEAD}>${XLM}`);
  });

  it("throws NoSoroswapRouteError when the pair graph has no path", async () => {
    await expect(
      quoteRouteToXLM(
        server,
        { assetIn: asset, amountIn: 100n, network: MAINNET, sourcePublicKey: USER },
        { loadPairs: async () => [pair(USDC, XLM)], simulateRead: quotes({}) },
      ),
    ).rejects.toBeInstanceOf(NoSoroswapRouteError);
  });

  it("throws NoSoroswapRouteError with the router's answers when every candidate fails", async () => {
    const err = await quoteRouteToXLM(
      server,
      { assetIn: asset, amountIn: 100n, network: MAINNET, sourcePublicKey: USER },
      { loadPairs: async () => [pair(TOKEN, XLM)], simulateRead: quotes({}) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoSoroswapRouteError);
    expect((err as NoSoroswapRouteError).reasons[0]).toMatch(/MissingValue/);
  });

  it("does not read a transport failure as 'no route'", async () => {
    await expect(
      quoteRouteToXLM(
        server,
        { assetIn: asset, amountIn: 100n, network: MAINNET, sourcePublicKey: USER },
        {
          loadPairs: async () => [pair(TOKEN, XLM)],
          simulateRead: (async () => {
            throw new Error("fetch failed");
          }) as unknown as typeof simulateRead,
        },
      ),
    ).rejects.toThrow(/fetch failed/);
  });
});

describe("buildSwapToXLM with a route", () => {
  function captured() {
    let seen: Transaction | undefined;
    return {
      deps: {
        server,
        sourceAccount: new Account(USER, "5") as unknown as Horizon.AccountResponse,
        assemble: async (_s: rpc.Server, tx: Transaction | FeeBumpTransaction) => {
          seen = tx as Transaction;
          return tx;
        },
      },
      tx: () => seen!,
    };
  }
  const base = {
    assetIn: asset,
    amountIn: "100",
    amountOutMin: "891",
    userAddress: USER,
    deadline: 2_000_000_000,
    ledgerCloseTime: 1_999_999_700,
    network: MAINNET,
  };

  it("encodes a multi-hop path in order", async () => {
    const c = captured();
    await buildSwapToXLM({ ...base, path: [TOKEN, USDC, XLM] }, c.deps);
    const op = c.tx().operations[0] as Operation.InvokeHostFunction;
    const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
    expect(call.functionName.toString()).toBe("swap_exact_tokens_for_tokens");
    const path = xdr
      .expectUnionVariant(call.args[2]!, "scvVec")
      .vec!.map((t) => Address.fromScVal(t).toString());
    expect(path).toEqual([TOKEN, USDC, XLM]);
  });

  it("rejects a path that does not run from the token to XLM", async () => {
    const c = captured();
    await expect(buildSwapToXLM({ ...base, path: [USDC, XLM] }, c.deps)).rejects.toThrow(
      /start at the input token/,
    );
    await expect(buildSwapToXLM({ ...base, path: [TOKEN, USDC] }, c.deps)).rejects.toThrow(
      /end at XLM/,
    );
    await expect(
      buildSwapToXLM({ ...base, path: [TOKEN, USDC, AQUA, XLM] }, c.deps),
    ).rejects.toThrow(/2 to 3 tokens/);
  });
});
