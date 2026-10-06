import { describe, it, expect, vi } from "vitest";
import {
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

// close-verify is server-only; stub the guard so it imports under vitest's node env
vi.mock("server-only", () => ({}));

import { verifyCloseTx } from "@/server/close-verify";
import { TESTNET } from "@/lib/config/networks";
import { closeMarkerOperations } from "@/lib/metrics/close-marker";

// end-to-end proof of the close ledger: create real merges on live testnet, one
// carrying the close marker and one without, and confirm verifyCloseTx counts
// only the marked one and derives the reclaimed XLM from public Horizon data.

const server = new Horizon.Server(TESTNET.horizon, { allowHttp: false });

async function friendbot(pubkey: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}?addr=${encodeURIComponent(pubkey)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pubkey}: ${res.status}`);
}

async function mergeWith(ops: readonly xdr.Operation[]): Promise<string> {
  const source = Keypair.random();
  const dest = Keypair.random();
  await Promise.all([friendbot(source.publicKey()), friendbot(dest.publicKey())]);
  const account = await server.loadAccount(source.publicKey());
  const b = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  }).setTimeout(120);
  for (const op of ops) b.addOperation(op);
  b.addOperation(Operation.accountMerge({ destination: dest.publicKey() }));
  const tx = b.build();
  tx.sign(source);
  const submit = await server.submitTransaction(tx);
  return submit.hash;
}

describe("integration: verifyCloseTx against live testnet merges", () => {
  it("counts a merge carrying the close marker", async () => {
    const hash = await mergeWith(closeMarkerOperations());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const result = await verifyCloseTx(TESTNET, hash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.close.network).toBe("testnet");
    expect(result.close.ops.accountMerge).toBe(1);
    expect(result.close.ops.total).toBe(3);
    expect(result.close.ledger).toBeGreaterThan(0);
    // the merged source held ~10,000 test XLM, so the destination was credited > 0
    expect(BigInt(result.close.reclaimedStroops)).toBeGreaterThan(0n);
  });

  it("refuses a real merge without the marker and a made-up hash", async () => {
    const hash = await mergeWith([]);
    const unmarked = await verifyCloseTx(TESTNET, hash);
    expect(unmarked).toMatchObject({ ok: false, retryable: false });
    if (!unmarked.ok) expect(unmarked.reason).toMatch(/close marker/);

    const fake = await verifyCloseTx(TESTNET, "f".repeat(64));
    expect(fake.ok).toBe(false);
  });
});
