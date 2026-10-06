import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { runDemoSetup, type DemoStepId, type DemoStepResult } from "@/lib/wallet/demo-account";

// a horizon that knows only the accounts friendbot funded and refuses the
// trustlines transaction (the one that creates the two demo issuers), the way
// testnet answers when that submit fails
const horizon = vi.hoisted(() => ({
  existing: new Set<string>(),
  loaded: [] as string[],
  submittedOps: [] as string[][],
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  class FakeHorizonServer {
    constructor(readonly serverUrl: string) {}
    async loadAccount(id: string) {
      horizon.loaded.push(id);
      if (!horizon.existing.has(id)) {
        throw new sdk.NotFoundError("Not Found", { status: 404, data: { status: 404 } });
      }
      return new sdk.Account(id, "100");
    }
    async submitTransaction(tx: Transaction) {
      const types = tx.operations.map((op) => op.type);
      horizon.submittedOps.push(types);
      if (types.includes("createAccount")) {
        throw {
          response: {
            status: 400,
            data: { extras: { result_codes: { transaction: "tx_failed" } } },
          },
        };
      }
      return { hash: Buffer.from(tx.hash()).toString("hex") };
    }
  }
  return { ...sdk, Horizon: { ...sdk.Horizon, Server: FakeHorizonServer } };
});

afterEach(() => {
  vi.unstubAllGlobals();
  horizon.existing.clear();
  horizon.loaded = [];
  horizon.submittedOps = [];
});

class StopAfterCredits extends Error {}

describe("demo credit balances after a failed trustlines step (I-18)", () => {
  it("skips minting with the issuer guard instead of a horizon not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        horizon.existing.add(new URL(url).searchParams.get("addr")!);
        return new Response("{}", { status: 200 });
      }),
    );
    const finished = new Map<DemoStepId, DemoStepResult>();
    await expect(
      runDemoSetup({
        network: TESTNET,
        // the steps after the credit balances talk to soroban rpc; stop before them
        onStart: (id) => {
          if (id === "claimable-balance") throw new StopAfterCredits();
        },
        onFinish: (r) => finished.set(r.id, r),
      }),
    ).rejects.toBeInstanceOf(StopAfterCredits);

    expect(finished.get("trustlines")).toMatchObject({
      status: "failed",
      error: 'status 400; codes {"transaction":"tx_failed"}',
    });
    expect(finished.get("credit-balances")).toEqual({
      id: "credit-balances",
      status: "skipped",
      error: "credit-balances: trustlines step didn't produce issuer keypairs",
    });
    // no mint was attempted from an issuer that was never created
    const [demoAccount] = [...horizon.existing];
    expect(horizon.loaded.every((id) => id === demoAccount)).toBe(true);
    expect(horizon.submittedOps.some((ops) => ops.includes("payment"))).toBe(false);
  });
});
