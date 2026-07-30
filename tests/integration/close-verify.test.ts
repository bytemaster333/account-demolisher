import { describe, it, expect, vi } from "vitest";
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// close-verify is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { verifyCloseTx } from "@/server/close-verify";
import { TESTNET } from "@/lib/config/networks";

// End-to-end proof of the verifiable close ledger: create a REAL account_merge on
// live testnet, then confirm verifyCloseTx accepts it and derives the reclaimed
// XLM + op breakdown from public Horizon data. This is what backs the claim that
// the close count is auditable rather than self-reported.

async function friendbot(pubkey: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(pubkey)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pubkey}: ${res.status}`);
}

describe("integration: verifyCloseTx against a live testnet account_merge", () => {
  it("accepts a real merge and reports reclaimed XLM + the account_merge op", async () => {
    const server = new Horizon.Server(TESTNET.horizon, { allowHttp: false });
    const source = Keypair.random();
    const dest = Keypair.random();

    await Promise.all([friendbot(source.publicKey()), friendbot(dest.publicKey())]);

    const account = await server.loadAccount(source.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.accountMerge({ destination: dest.publicKey() }))
      .setTimeout(120)
      .build();
    tx.sign(source);

    const submit = await server.submitTransaction(tx);
    const hash = submit.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const result = await verifyCloseTx(TESTNET, hash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.close.network).toBe("testnet");
    expect(result.close.ops.accountMerge).toBe(1);
    expect(result.close.ledger).toBeGreaterThan(0);
    // the merged source held ~10,000 test XLM, so the destination was credited > 0
    expect(BigInt(result.close.reclaimedStroops)).toBeGreaterThan(0n);

    // a fabricated hash must NOT verify (anti-inflation guarantee, live path)
    const fake = await verifyCloseTx(TESTNET, "f".repeat(64));
    expect(fake.ok).toBe(false);
  });
});
