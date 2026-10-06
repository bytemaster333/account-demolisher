import { describe, it, expect } from "vitest";
import {
  Address,
  Operation,
  StrKey,
  scValToNative,
  xdr,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  AquariusAPIPoolProvider,
  AquariusEventScanPoolProvider,
  AquariusPartialPoolsError,
} from "@/lib/adapters/aquarius/pools";
import { MAINNET_CONCENTRATED_POOLS } from "@/lib/adapters/aquarius/concentrated-pools";
import { getAquariusRouterId } from "@/lib/adapters/aquarius/client";
import { MAINNET } from "@/lib/config/networks";
import { i128 } from "@/lib/soroban/scval";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 2));
const SHARE_OK = StrKey.encodeContract(Buffer.alloc(32, 11));
const SHARE_BROKEN = StrKey.encodeContract(Buffer.alloc(32, 12));
const POOL_OK = StrKey.encodeContract(Buffer.alloc(32, 21));
const POOL_BROKEN = StrKey.encodeContract(Buffer.alloc(32, 22));
const UNPINNED_CONC = StrKey.encodeContract(Buffer.alloc(32, 23));
const PINNED_CONC = MAINNET_CONCENTRATED_POOLS[0]!;
const IDX_OK = "1".repeat(64);
const IDX_BROKEN = "2".repeat(64);

// a soroban rpc stand-in that answers simulateTransaction from the invoked
// contract + function, the way the real server returns a retval
function simServer(answer: (contract: string, fn: string, args: xdr.ScVal[]) => xdr.ScVal) {
  return {
    simulateTransaction: async (tx: Transaction) => {
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
      const contract = Address.fromScAddress(call.contractAddress).toString();
      try {
        const retval = answer(contract, call.functionName.toString(), call.args);
        return { latestLedger: 1, minResourceFee: "0", result: { retval, auth: [] }, events: [] };
      } catch (e) {
        return { latestLedger: 1, error: (e as Error).message, events: [] };
      }
    },
  } as unknown as rpc.Server;
}

function page(results: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ count: results.length, next: null, previous: null, results }),
  } as unknown as Response;
}

function entry(index: string, address: string, poolType: string, tokens = [TOKEN_A, TOKEN_B]) {
  return { index, address, pool_type: poolType, tokens_addresses: tokens };
}

// share_id resolves per pool index; balance answers per share token
function restServer() {
  return simServer((contract, fn, args) => {
    if (fn === "share_id") {
      const idx = Buffer.from(scValToNative(args[1]!) as Uint8Array).toString("hex");
      return new Address(idx === IDX_OK ? SHARE_OK : SHARE_BROKEN).toScVal();
    }
    if (fn === "balance" && contract === SHARE_OK) return i128(500n);
    throw new Error(`HostError: ${contract}.${fn} trapped`);
  });
}

function restProvider(results: unknown[], server = restServer()) {
  return new AquariusAPIPoolProvider({
    server,
    network: MAINNET,
    fetchImpl: (async () => page(results)) as unknown as typeof fetch,
  });
}

describe("Aquarius REST provider", () => {
  it("returns standard pools and lists concentrated pools without reading router shares for them", async () => {
    const scan = await restProvider([
      entry(PINNED_CONC.poolIndex, PINNED_CONC.address, "concentrated", [...PINNED_CONC.tokens]),
      entry(IDX_OK, POOL_OK, "constant_product"),
    ]).scanUserPools(USER);
    expect(scan.errors).toEqual([]);
    expect(scan.concentratedAddresses).toEqual([PINNED_CONC.address]);
    expect(scan.standard).toEqual([
      {
        poolIndex: IDX_OK,
        poolAddress: POOL_OK,
        poolType: "constant_product",
        tokens: [TOKEN_A, TOKEN_B],
        shareBalance: 500n,
      },
    ]);
  });

  it("keeps the readable pools when one entry fails, and reports the failed one", async () => {
    const provider = restProvider([
      entry(IDX_BROKEN, POOL_BROKEN, "constant_product"),
      entry(IDX_OK, POOL_OK, "stable"),
    ]);
    const scan = await provider.scanUserPools(USER);
    expect(scan.standard.map((p) => p.poolAddress)).toEqual([POOL_OK]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]).toMatch(new RegExp(POOL_BROKEN));
    // the list-returning form fails closed rather than returning a partial list,
    // but hands over the pools it did read so the caller can still exit them
    const err = await provider.getUserPools(USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AquariusPartialPoolsError);
    expect((err as Error).message).toMatch(new RegExp(POOL_BROKEN));
    expect((err as Error).message).toMatch(/trapped/);
    expect((err as AquariusPartialPoolsError).partialPools.map((p) => p.poolAddress)).toEqual([
      POOL_OK,
    ]);
  });

  it("reports a concentrated pool that is not pinned (no in-app exit for it)", async () => {
    const scan = await restProvider([entry(IDX_OK, UNPINNED_CONC, "concentrated")]).scanUserPools(
      USER,
    );
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]).toMatch(/not on the pinned mainnet list/);
  });

  it("gives up on an API that never answers instead of hanging the close", async () => {
    const provider = new AquariusAPIPoolProvider({
      server: restServer(),
      network: MAINNET,
      timeoutMs: 30,
      // never settles and ignores the abort signal
      fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    await expect(provider.getUserPools(USER)).rejects.toThrow(/timed out after 30ms/);
  });

  it("passes an abort signal to fetch", async () => {
    let signal: AbortSignal | undefined;
    const provider = new AquariusAPIPoolProvider({
      server: restServer(),
      network: MAINNET,
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return page([]);
      }) as unknown as typeof fetch,
    });
    await provider.getUserPools(USER);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("Aquarius event scan", () => {
  function scanServer(onGetEvents: (req: rpc.Api.GetEventsRequest) => rpc.Api.GetEventsResponse) {
    return {
      getLatestLedger: async () => ({ id: "x", sequence: 1_000_000, protocolVersion: 23 }),
      getEvents: async (req: rpc.Api.GetEventsRequest) => onGetEvents(req),
    } as unknown as rpc.Server;
  }

  it("asks the rpc only for this user's router deposit and withdraw events", async () => {
    const requests: rpc.Api.GetEventsRequest[] = [];
    const server = scanServer((req) => {
      requests.push(req);
      return {
        events: [],
        cursor: "",
        latestLedger: 1_000_000,
      } as unknown as rpc.Api.GetEventsResponse;
    });
    await new AquariusEventScanPoolProvider({ server, network: MAINNET }).getUserPools(USER);
    expect(requests).toHaveLength(1);
    const filter = requests[0]!.filters[0]!;
    expect(filter.contractIds).toEqual([getAquariusRouterId(MAINNET)]);
    const userXdr = new Address(USER).toScVal().toXdr("base64");
    expect(filter.topics).toEqual([
      [xdr.ScVal.scvSymbol("deposit").toXdr("base64"), "*", userXdr],
      [xdr.ScVal.scvSymbol("withdraw").toXdr("base64"), "*", userXdr],
    ]);
  });

  it("reports an incomplete scan when the page cap is hit with the cursor still advancing", async () => {
    let n = 0;
    const server = scanServer(() => {
      n += 1;
      return {
        events: [],
        cursor: `c${n}`,
        latestLedger: 1_000_000,
      } as unknown as rpc.Api.GetEventsResponse;
    });
    await expect(
      new AquariusEventScanPoolProvider({ server, network: MAINNET, maxPages: 3 }).getUserPools(
        USER,
      ),
    ).rejects.toThrow(/3-page cap/);
    expect(n).toBe(3);
  });
});
