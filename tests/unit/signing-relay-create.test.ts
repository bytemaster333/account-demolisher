// createPlan and the /api/plan routes, against real envelopes and a real
// Horizon.AccountResponse. only the Horizon network call is replaced.

import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAccount = vi.fn();
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({ loadAccount }),
}));

import { closeMarkerOperations } from "@/lib/metrics/close-marker";
import { POST as publishRoute } from "@/app/api/plan/route";
import { POST as signRoute } from "@/app/api/plan/[id]/sign/route";
import {
  __resetRelayForTests,
  addSignature,
  createPlan,
  getPlan,
  subscribe,
} from "@/server/signing-relay";

const NET = Networks.TESTNET;
const HOUR = 3600;

interface AccountShape {
  readonly kp: Keypair;
  readonly sequence: string;
  readonly cosigners: readonly Keypair[];
  readonly thresholds?: { low: number; med: number; high: number };
}

function accountResponse(a: AccountShape): Horizon.AccountResponse {
  const signers = [
    ...a.cosigners.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    { key: a.kp.publicKey(), weight: 1, type: "ed25519_public_key" },
  ];
  const t = a.thresholds ?? { low: 1, med: 2, high: 2 };
  return new Horizon.AccountResponse({
    id: a.kp.publicKey(),
    account_id: a.kp.publicKey(),
    sequence: a.sequence,
    balances: [],
    signers,
    thresholds: { low_threshold: t.low, med_threshold: t.med, high_threshold: t.high },
  } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildClose(
  a: AccountShape,
  opts: {
    seq?: string;
    minTime?: number;
    maxTime?: number;
    memo?: string;
    extraOps?: readonly xdr.Operation[];
  } = {},
): Transaction {
  const b = new TransactionBuilder(new Account(a.kp.publicKey(), opts.seq ?? a.sequence), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: opts.minTime ?? 0, maxTime: opts.maxTime ?? nowSec() + 72 * HOUR - 60 },
  });
  for (const op of opts.extraOps ?? []) b.addOperation(op);
  b.addOperation(Operation.accountMerge({ destination: Keypair.random().publicKey() }));
  if (opts.memo !== undefined) b.addMemo(Memo.text(opts.memo));
  return b.build();
}

function signedBy(tx: Transaction, ...kps: Keypair[]): string {
  const copy = TransactionBuilder.fromXdr(tx.toXdr(), NET) as Transaction;
  for (const kp of kps) copy.sign(kp);
  return copy.toXdr();
}

function newAccount(cosigners = 1): AccountShape {
  return {
    kp: Keypair.random(),
    sequence: "1000",
    cosigners: Array.from({ length: cosigners }, () => Keypair.random()),
  };
}

beforeEach(() => {
  loadAccount.mockReset();
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
});

afterEach(() => {
  __resetRelayForTests();
  vi.unstubAllEnvs();
});

describe("createPlan", () => {
  it("publishes a valid close and serves the signer set it was checked against", async () => {
    const a = newAccount(2);
    loadAccount.mockResolvedValue(
      accountResponse({ ...a, thresholds: { low: 1, med: 3, high: 2 } }),
    );
    // the account's sequence is 1000, so the next transaction uses 1001
    const tx = buildClose(a);
    expect(tx.sequence).toBe("1001");
    const res = await createPlan("testnet", signedBy(tx, a.kp));
    expect(res).toEqual({ ok: true, id: Buffer.from(tx.hash()).toString("hex") });
    const plan = getPlan(res.ok ? res.id : "")!;
    expect(plan.account).toBe(a.kp.publicKey());
    expect(plan.thresholds).toEqual({ low: 1, med: 3, high: 2 });
    expect(new Set(plan.signers.map((s) => s.key))).toEqual(
      new Set([a.kp.publicKey(), ...a.cosigners.map((k) => k.publicKey())]),
    );
  });

  it("rejects a transaction without an upper time bound", async () => {
    const a = newAccount();
    loadAccount.mockResolvedValue(accountResponse(a));
    const res = await createPlan("testnet", signedBy(buildClose(a, { maxTime: 0 }), a.kp));
    expect(res).toMatchObject({ ok: false, code: "NO_EXPIRY" });
  });

  it("rejects a transaction that expires more than 72 hours out", async () => {
    const a = newAccount();
    loadAccount.mockResolvedValue(accountResponse(a));
    const res = await createPlan(
      "testnet",
      signedBy(buildClose(a, { maxTime: nowSec() + 10 * 24 * HOUR }), a.kp),
    );
    expect(res).toMatchObject({ ok: false, code: "EXPIRY_TOO_FAR" });
  });

  it("rejects expired, about-to-expire and not-yet-valid transactions", async () => {
    const a = newAccount();
    loadAccount.mockResolvedValue(accountResponse(a));
    const past = await createPlan(
      "testnet",
      signedBy(buildClose(a, { maxTime: nowSec() - 60 }), a.kp),
    );
    expect(past).toMatchObject({ ok: false, code: "EXPIRED" });
    const soon = await createPlan(
      "testnet",
      signedBy(buildClose(a, { maxTime: nowSec() + 5 * 60 }), a.kp),
    );
    expect(soon).toMatchObject({ ok: false, code: "EXPIRED" });
    const later = await createPlan(
      "testnet",
      signedBy(buildClose(a, { minTime: nowSec() + HOUR }), a.kp),
    );
    expect(later).toMatchObject({ ok: false, code: "NOT_YET_VALID" });
  });

  it("rejects a transaction that doesn't use the account's next sequence number", async () => {
    const a = newAccount();
    loadAccount.mockResolvedValue(accountResponse(a));
    // Account(…, "1004") builds sequence 1005, but the account is at 1000
    const res = await createPlan("testnet", signedBy(buildClose(a, { seq: "1004" }), a.kp));
    expect(res).toMatchObject({ ok: false, code: "STALE_SEQUENCE" });
  });

  it("caps open requests per account", async () => {
    const a = newAccount();
    loadAccount.mockResolvedValue(accountResponse(a));
    for (let i = 0; i < 3; i++) {
      const ok = await createPlan("testnet", signedBy(buildClose(a, { memo: `r${i}` }), a.kp));
      expect(ok.ok).toBe(true);
    }
    const fourth = await createPlan("testnet", signedBy(buildClose(a, { memo: "r3" }), a.kp));
    expect(fourth).toMatchObject({ ok: false, code: "ACCOUNT_LIMIT" });
  });

  it("filling the testnet budget does not block mainnet requests", async () => {
    for (let i = 0; i < 100; i++) {
      const a = newAccount(0);
      loadAccount.mockResolvedValueOnce(accountResponse(a));
      const ok = await createPlan("testnet", signedBy(buildClose(a), a.kp));
      expect(ok.ok).toBe(true);
    }
    const extra = newAccount(0);
    loadAccount.mockResolvedValueOnce(accountResponse(extra));
    expect(await createPlan("testnet", signedBy(buildClose(extra), extra.kp))).toMatchObject({
      ok: false,
      code: "CAPACITY",
    });

    const main = newAccount(0);
    loadAccount.mockResolvedValueOnce(accountResponse(main));
    const mainTx = new TransactionBuilder(new Account(main.kp.publicKey(), main.sequence), {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
      timebounds: { minTime: 0, maxTime: nowSec() + 72 * HOUR - 60 },
    })
      .addOperation(Operation.accountMerge({ destination: Keypair.random().publicKey() }))
      .build();
    mainTx.sign(main.kp);
    expect((await createPlan("mainnet", mainTx.toXdr())).ok).toBe(true);
  });

  it("refuses networks the relay doesn't serve", async () => {
    const a = newAccount();
    const res = await createPlan("futurenet", signedBy(buildClose(a), a.kp));
    expect(res).toMatchObject({ ok: false, code: "BAD_NETWORK" });
    expect(loadAccount).not.toHaveBeenCalled();
  });

  it("stores only verified signer signatures, so junk can't block co-signers", async () => {
    const a = newAccount(1);
    loadAccount.mockResolvedValue(accountResponse(a));
    const tx = buildClose(a);
    const padded = TransactionBuilder.fromXdr(signedBy(tx, a.kp), NET) as Transaction;
    for (let i = 0; i < 5; i++) {
      padded.signatures.push(
        new xdr.DecoratedSignature({
          hint: Buffer.from([9, 9, 9, i]),
          signature: Buffer.alloc(64, i + 7),
        }),
      );
    }
    const res = await createPlan("testnet", padded.toXdr());
    expect(res.ok).toBe(true);
    const id = res.ok ? res.id : "";
    expect(TransactionBuilder.fromXdr(getPlan(id)!.xdr, NET).signatures).toHaveLength(1);
    const signed = addSignature(id, signedBy(tx, a.cosigners[0]!));
    expect(signed.ok).toBe(true);
    if (signed.ok)
      expect(TransactionBuilder.fromXdr(signed.plan.xdr, NET).signatures).toHaveLength(2);
  });

  it("a concurrent re-publish merges into the record instead of replacing it", async () => {
    const a = newAccount(1);
    const tx = buildClose(a);
    const initial = signedBy(tx, a.kp);
    let release1: (v: Horizon.AccountResponse) => void = () => {};
    let release2: (v: Horizon.AccountResponse) => void = () => {};
    loadAccount
      .mockImplementationOnce(() => new Promise((r) => (release1 = r)))
      .mockImplementationOnce(() => new Promise((r) => (release2 = r)));

    const p1 = createPlan("testnet", initial);
    const p2 = createPlan("testnet", initial);
    release1(accountResponse(a));
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    const id = r1.ok ? r1.id : "";

    const seen: string[] = [];
    subscribe(
      id,
      (p) => seen.push(p.xdr),
      () => {},
      "203.0.113.5",
    );
    expect(addSignature(id, signedBy(tx, a.cosigners[0]!)).ok).toBe(true);

    release2(accountResponse(a));
    expect((await p2).ok).toBe(true);
    expect(TransactionBuilder.fromXdr(getPlan(id)!.xdr, NET).signatures).toHaveLength(2);
    // the subscriber is still attached to the live record
    expect(addSignature(id, signedBy(tx, a.kp)).ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});

describe("worst-case bundle size (M-46)", () => {
  // 97 credit/credit offer cancels + the close marker pair + the merge = 100 ops,
  // with a 28-byte text memo: the largest envelope the close builder can emit
  function worstCase(a: AccountShape): Transaction {
    const issuer = Keypair.random().publicKey();
    const ops: xdr.Operation[] = [];
    for (let i = 0; i < 97; i++) {
      ops.push(
        Operation.manageSellOffer({
          selling: new Asset("ABCDEFGHIJKL", issuer),
          buying: new Asset("MNOPQRSTUVWX", issuer),
          amount: "0",
          price: { n: 123456789, d: 987654321 },
          offerId: String(9_000_000_000 + i),
        }),
      );
    }
    ops.push(...closeMarkerOperations());
    return buildClose(a, { extraOps: ops, memo: "a".repeat(28) });
  }

  it("publishes and collects signatures up to the 20-signature limit", async () => {
    const a = newAccount(20);
    loadAccount.mockResolvedValue(accountResponse(a));
    const tx = worstCase(a);
    expect(tx.operations).toHaveLength(100);

    const published = await createPlan("testnet", signedBy(tx, a.kp));
    expect(published.ok).toBe(true);
    const id = published.ok ? published.id : "";

    let last = "";
    for (let i = 0; i < 19; i++) {
      const res = addSignature(id, signedBy(tx, a.cosigners[i]!));
      expect(res.ok).toBe(true);
      if (res.ok) last = res.plan.xdr;
    }
    const final = TransactionBuilder.fromXdr(last, NET);
    expect(final.signatures).toHaveLength(20);
    // well above the old 12,000-char cap that blocked later co-signers
    expect(last.length).toBeGreaterThan(12_000);

    const overflow = addSignature(id, signedBy(tx, a.cosigners[19]!));
    expect(overflow).toMatchObject({ ok: false, code: "TOO_MANY_SIGNATURES" });
    if (!overflow.ok) expect(overflow.reason).toMatch(/at most 20 signatures/);
  });

  it("both plan routes accept a body of about 20 KiB", async () => {
    const a = newAccount(20);
    loadAccount.mockResolvedValue(accountResponse(a));
    const tx = worstCase(a);
    const signers = [a.kp, ...a.cosigners.slice(0, 18)];
    const bigXdr = signedBy(tx, ...signers);
    const body = JSON.stringify({ network: "testnet", xdr: bigXdr });
    expect(body.length).toBeGreaterThan(16_384);

    const pub = await publishRoute(
      new Request("http://localhost/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
        body,
      }),
    );
    expect(pub.status).toBe(200);
    const { id } = (await pub.json()) as { id: string };

    const full = signedBy(tx, ...signers, a.cosigners[18]!);
    const sign = await signRoute(
      new Request(`http://localhost/api/plan/${id}/sign`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
        body: JSON.stringify({ xdr: full }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(sign.status).toBe(200);
  });
});

describe("/api/plan rate limiting (H-35)", () => {
  it("one client exhausting its bucket does not throttle a different client", async () => {
    const hit = (ip: string): Promise<Response> =>
      publishRoute(
        new Request("http://localhost:3000/api/plan", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: "{}",
        }),
      );
    let limited = false;
    for (let i = 0; i < 15; i++) {
      if ((await hit("192.0.2.77")).status === 429) limited = true;
    }
    expect(limited).toBe(true);
    expect((await hit("192.0.2.78")).status).toBe(400);
  });

  it("fails with a configuration error instead of sharing one bucket when hops is 0", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await publishRoute(
      new Request("http://localhost:3000/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.80" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(500);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
