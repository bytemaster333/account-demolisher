import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

vi.mock("server-only", () => ({}));

import { encodeMemoCommitment } from "@/lib/mediator/forward-terms";
import { COSIGN_LOG_FILE, appendCosignRecord, cosignRecordFor } from "@/server/cosign-log";

const MEDIATOR = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

function forward(memo: Memo = Memo.id("7")) {
  return new TransactionBuilder(new Account(MEDIATOR, "1"), {
    fee: "500",
    networkPassphrase: Networks.TESTNET,
    memo,
  })
    .addOperation(Operation.payment({ destination: DEST, asset: Asset.native(), amount: "12.5" }))
    .addOperation(Operation.accountMerge({ destination: DEST }))
    .setTimeout(180)
    .build();
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cosign-log-"));
  vi.stubEnv("METRICS_DB_DIR", dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("cosignRecordFor", () => {
  it("records what the signed envelope carries", () => {
    const tx = forward(Memo.text("deposit 9"));
    expect(cosignRecordFor(tx, "testnet", 1_700_000_000_000)).toEqual({
      signedAt: 1_700_000_000_000,
      network: "testnet",
      txHash: Buffer.from(tx.hash()).toString("hex"),
      mediator: MEDIATOR,
      destination: DEST,
      memoXdr: encodeMemoCommitment(Memo.text("deposit 9")),
      amount: "12.5000000",
      fee: "1000",
      maxTime: tx.timeBounds!.maxTime,
    });
  });

  it("writes the hash as 64 hex characters", () => {
    expect(cosignRecordFor(forward(), "testnet", 0).txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a transaction whose first operation is not a payment", () => {
    const tx = new TransactionBuilder(new Account(MEDIATOR, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.accountMerge({ destination: DEST }))
      .setTimeout(180)
      .build();
    expect(() => cosignRecordFor(tx, "testnet", 0)).toThrow(/not a payment/);
  });
});

describe("appendCosignRecord", () => {
  it("keeps every concurrent append as a whole line", async () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      cosignRecordFor(forward(Memo.id(String(i + 1))), "testnet", i),
    );
    await Promise.all(records.map((r) => appendCosignRecord(r)));
    const lines = (await fs.readFile(path.join(dir, COSIGN_LOG_FILE), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(20);
    expect(new Set(lines.map((l) => (JSON.parse(l) as { signedAt: number }).signedAt)).size).toBe(
      20,
    );
  });

  it("creates the data directory when it does not exist yet", async () => {
    vi.stubEnv("METRICS_DB_DIR", path.join(dir, "nested", "data"));
    await appendCosignRecord(cosignRecordFor(forward(), "mainnet", 5));
    const raw = await fs.readFile(path.join(dir, "nested", "data", COSIGN_LOG_FILE), "utf8");
    expect(JSON.parse(raw.trim())).toMatchObject({ network: "mainnet", signedAt: 5 });
  });

  it("rejects when the line can't be written, and still accepts the next one", async () => {
    const blocker = path.join(dir, "not-a-dir");
    await fs.writeFile(blocker, "x");
    vi.stubEnv("METRICS_DB_DIR", path.join(blocker, "data"));
    await expect(appendCosignRecord(cosignRecordFor(forward(), "testnet", 1))).rejects.toThrow();
    vi.stubEnv("METRICS_DB_DIR", dir);
    await appendCosignRecord(cosignRecordFor(forward(), "testnet", 2));
    const raw = await fs.readFile(path.join(dir, COSIGN_LOG_FILE), "utf8");
    expect(JSON.parse(raw.trim())).toMatchObject({ signedAt: 2 });
  });
});
