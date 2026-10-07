import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { RequestType } from "@blend-capital/blend-sdk";

import { defaultBlendPoolLoader, withBlendFailover } from "@/lib/adapters/blend/client";
import { I128_MAX } from "@/lib/adapters/blend/constants";
import { v2WithdrawRequest } from "@/lib/adapters/blend/exit";
import { BLEND_MAINNET_POOLS } from "@/lib/adapters/blend/pools";
import { MAINNET } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";

// read-only mainnet simulation of the request amounts the exit builders choose
// per pool version. a fresh account holds no position, so a request that gets
// past the amount math stops at the pool's own position check (a contract
// error); one that overflows traps in the vm before that check.
const server = getRpc(MAINNET);
const XLM_SAC = Asset.native().contractId(MAINNET.passphrase);

function poolId(name: string): string {
  const entry = BLEND_MAINNET_POOLS.find((p) => p.name === name);
  if (!entry) throw new Error(`no registry pool named ${name}`);
  return entry.pool_id;
}

async function simulateSubmit(
  pool: string,
  requestType: RequestType,
  amount: bigint,
  asset: string = XLM_SAC,
): Promise<string> {
  const user = Keypair.random().publicKey();
  const request = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("address", { type: "symbol" }),
      val: nativeToScVal(asset, { type: "address" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("amount", { type: "symbol" }),
      val: nativeToScVal(amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("request_type", { type: "symbol" }),
      val: nativeToScVal(requestType, { type: "u32" }),
    }),
  ]);
  const address = nativeToScVal(user, { type: "address" });
  const tx = new TransactionBuilder(new Account(user, "0"), {
    fee: "100",
    networkPassphrase: MAINNET.passphrase,
  })
    .addOperation(
      new Contract(pool).call("submit", address, address, address, xdr.ScVal.scvVec([request])),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationError(sim)) return "ok";
  return sim.error;
}

describe("integration: Blend request amounts per pool version (mainnet, read-only)", () => {
  const v1 = poolId("Fixed");
  // the order of magnitude the v1 builders send: a buffered underlying amount
  const finite = 100_1000000n;

  it("v1 traps on i128::MAX for withdraw, withdraw collateral and repay", async () => {
    for (const type of [RequestType.Withdraw, RequestType.WithdrawCollateral, RequestType.Repay]) {
      expect(await simulateSubmit(v1, type, I128_MAX)).toMatch(/Error\(WasmVm, /u);
    }
  });

  it("v1 reaches the position check with the finite amount the builders send", async () => {
    for (const type of [RequestType.Withdraw, RequestType.WithdrawCollateral, RequestType.Repay]) {
      const error = await simulateSubmit(v1, type, finite);
      expect(error).toMatch(/Error\(Contract, #\d+\)/u);
      expect(error).not.toMatch(/WasmVm/u);
    }
  });

  // a reserve whose b_rate fell below 1e12 overflows the bToken conversion on
  // i128::MAX (YieldBloxV2's XLM and USDC reserves did on 2026-10-07), so the
  // builders size the v2 request from each reserve's b_rate instead
  it("v2 withdraw requests the builders send never trap, in any reserve of any v2 pool", async () => {
    const v2Pools = BLEND_MAINNET_POOLS.filter((p) => p.version === "V2");
    expect(v2Pools.length).toBeGreaterThan(0);
    for (const entry of v2Pools) {
      const pool = await withBlendFailover(MAINNET, (n) =>
        defaultBlendPoolLoader.load(n, entry.pool_id),
      );
      expect(pool.version).toBe("V2");
      for (const reserve of pool.reserves.values()) {
        const amount = v2WithdrawRequest(reserve);
        for (const type of [RequestType.Withdraw, RequestType.WithdrawCollateral]) {
          const error = await simulateSubmit(entry.pool_id, type, amount, reserve.assetId);
          expect(error, `${entry.name} ${reserve.assetId} type ${type}`).not.toMatch(/WasmVm/u);
        }
      }
    }
  });
});
