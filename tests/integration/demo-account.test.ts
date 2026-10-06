import { describe, it, expect } from "vitest";

import { TESTNET } from "@/lib/config/networks";
import { runDemoSetup, type DemoStepId, type DemoStepResult } from "@/lib/wallet/demo-account";

// live testnet run of the practice-account setup. every soroban step goes
// through the demo signing guard and the on-chain router, so this proves the
// guard accepts the real prepared transactions and that the liquidity deposit,
// sized from the live reserves, lands.
describe("integration: demo account setup (testnet)", () => {
  it("runs every step, including the soroswap swap and liquidity deposit", async () => {
    const results = new Map<DemoStepId, DemoStepResult>();
    const out = await runDemoSetup({
      network: TESTNET,
      onStart: () => {},
      onFinish: (r) => results.set(r.id, r),
    });

    const notDone = [...results.values()].filter((r) => r.status !== "done");
    expect(notDone, JSON.stringify(notDone, null, 2)).toEqual([]);
    for (const id of ["blend-supply", "soroswap-swap", "soroswap-lp", "sep41-allowance"] as const) {
      expect(results.get(id)?.txHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await out.connector.getPublicKey()).toBe(out.publicKey);
  }, 600_000);
});
