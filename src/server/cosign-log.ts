import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Transaction } from "@stellar/stellar-sdk";

import { encodeMemoCommitment, type MediatorNetworkId } from "@/lib/mediator/forward-terms";
import { appendLineDurably } from "@/server/durable-append";

// append-only record of every forward the mediator co-signs, so the operator can
// show exactly what it signed, and when, even for a forward that never reached
// the ledger. one json line per signature in cosign.jsonl, next to the metrics
// files.
//
// it holds only what the signed envelope itself carries (and what lands on chain
// once it is submitted). never the flow token or its nonce: with the master seed
// those derive the mediator key, so a copy of this file must not help anyone
// move a balance that still sits in a mediator.

export const COSIGN_LOG_FILE = "cosign.jsonl";

export interface CosignRecord {
  readonly signedAt: number; // unix ms
  readonly network: MediatorNetworkId;
  readonly txHash: string; // hex
  readonly mediator: string;
  readonly destination: string;
  readonly memoXdr: string;
  readonly amount: string; // the payment leg, in XLM
  readonly fee: string; // stroops
  readonly maxTime: string; // unix seconds
}

// the forward has passed the validator, so it is exactly a native payment and a
// merge to one destination, with time bounds
export function cosignRecordFor(
  tx: Transaction,
  network: MediatorNetworkId,
  signedAt: number,
): CosignRecord {
  const payment = tx.operations[0];
  if (payment?.type !== "payment") {
    throw new Error("cosign log: operation 0 of a validated forward is not a payment");
  }
  return {
    signedAt,
    network,
    txHash: Buffer.from(tx.hash()).toString("hex"),
    mediator: tx.source,
    destination: payment.destination,
    memoXdr: encodeMemoCommitment(tx.memo),
    amount: payment.amount,
    fee: tx.fee,
    maxTime: tx.timeBounds?.maxTime ?? "0",
  };
}

// overridable with METRICS_DB_DIR, the same data directory the metrics use
function logDir(): string {
  return process.env.METRICS_DB_DIR || path.join(process.cwd(), "data");
}

// appends from concurrent requests are serialized, so the torn-tail check in
// appendLineDurably never races another append in this process
let queue: Promise<unknown> = Promise.resolve();

// resolves once the line is on disk; rejects when it could not be written, and
// the caller then must not hand out the signature
export function appendCosignRecord(record: CosignRecord): Promise<void> {
  const run = queue.then(async () => {
    const dir = logDir();
    await fs.mkdir(dir, { recursive: true });
    await appendLineDurably(path.join(dir, COSIGN_LOG_FILE), JSON.stringify(record));
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
