// a small in-memory horizon for the mediator tests. it speaks the real horizon
// json shapes over a stubbed global fetch, so the sdk's own client, parsing and
// error wrapping run unchanged, and it routes /api/mediator/* to the real route
// handlers so the forward is validated and co-signed by the production code.

import {
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

const BASE_RESERVE = 5_000_000n;

export interface FakeAccount {
  balance: bigint; // stroops
  seq: bigint;
  lastModified: number;
}

interface OpRecord {
  id: string;
  type: string;
  source_account: string;
  into?: string;
  transaction_hash: string;
  transaction_successful: boolean;
}

export type SubmitScript =
  | { readonly kind: "apply" }
  // apply the tx but answer like a 504 gateway timeout
  | { readonly kind: "apply-then-504" }
  // never include it, answer 504
  | { readonly kind: "drop-504" }
  | { readonly kind: "reject"; readonly codes: { transaction: string; operations?: string[] } }
  // answer 200 without a hash, but apply it
  | { readonly kind: "apply-no-hash" }
  // answer 200 without a hash and never include it
  | { readonly kind: "drop-no-hash" };

type RouteHandler = (req: Request) => Response | Promise<Response>;

export class FakeHorizon {
  ledger = 1000;
  // how far the network's clock runs ahead of this process's Date.now(); a
  // positive value is a client clock that is slow. elapse() moves it forward
  // the way a test's injected sleep passes time
  ledgerClockAheadMs = 0;
  readonly accounts = new Map<string, FakeAccount>();
  readonly ops = new Map<string, OpRecord[]>();
  readonly txs = new Map<string, { ledger: number; successful: boolean }>();
  // accounts that existed once, so their history answers 200 after a merge
  private readonly known = new Set<string>();
  feeChargedP90 = "100";
  feeChargedMode = "100";
  ledgerCapacityUsage = "0.1";
  // per-op inclusion fee the network currently demands
  surgeFeePerOp = 100n;
  readonly submitScript: SubmitScript[] = [];
  // per-account queue of stale snapshots served before the real state
  readonly staleViews = new Map<string, FakeAccount[]>();
  readonly submitted: Transaction[] = [];
  readonly requests: string[] = [];
  // runs once, right before the next submission is applied
  beforeNextSubmit: (() => void) | null = null;
  // native balance text served for an account in place of its real balance
  readonly balanceText = new Map<string, string>();
  private opCounter = 1;

  constructor(
    private readonly routes: {
      sign: { GET: RouteHandler; POST: RouteHandler };
      reissue: RouteHandler;
    },
  ) {}

  // close time (unix seconds) of the latest ledger
  ledgerCloseTime(): number {
    return Math.floor((Date.now() + this.ledgerClockAheadMs) / 1000);
  }

  elapse(ms: number): void {
    this.ledgerClockAheadMs += ms;
  }

  createAccount(id: string, balance: bigint): void {
    this.ledger += 1;
    this.accounts.set(id, { balance, seq: BigInt(this.ledger) << 32n, lastModified: this.ledger });
    this.known.add(id);
  }

  // record an account_merge of `from` into `into` in a new ledger, as the close does
  mergeInto(from: string, into: string): string {
    this.ledger += 1;
    const src = this.accounts.get(from);
    const dst = this.accounts.get(into);
    if (!src || !dst) throw new Error("fake: merge between unknown accounts");
    dst.balance += src.balance;
    dst.lastModified = this.ledger;
    this.accounts.delete(from);
    const hash = randomHash();
    this.addOp([from, into], { type: "account_merge", source_account: from, into }, hash);
    this.txs.set(hash, { ledger: this.ledger, successful: true });
    return hash;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (raw.startsWith("/api/mediator/")) {
      const url = `http://app.test${raw}`;
      const req = new Request(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), "x-forwarded-for": "10.7.7.7" },
      });
      this.requests.push(`${req.method} ${raw.split("?")[0]}`);
      if (raw.startsWith("/api/mediator/reissue")) return this.routes.reissue(req);
      return req.method === "GET" ? this.routes.sign.GET(req) : this.routes.sign.POST(req);
    }
    const url = new URL(raw);
    if (url.host !== "horizon-testnet.stellar.org") throw new Error(`fake: unexpected host ${raw}`);
    const method = init?.method?.toUpperCase() ?? "GET";
    this.requests.push(`${method} ${url.pathname}`);
    if (method === "POST" && url.pathname === "/transactions") {
      return this.submit(String(init?.body ?? ""));
    }
    return this.get(url);
  };

  private get(url: URL): Response {
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if ((m = /^\/accounts\/(G[A-Z2-7]{55})$/u.exec(path))) return this.account(m[1]!);
    if ((m = /^\/accounts\/(G[A-Z2-7]{55})\/operations$/u.exec(path))) {
      const id = m[1]!;
      if (!this.known.has(id)) return notFound();
      const records = [...(this.ops.get(id) ?? [])].reverse();
      return Response.json({
        _links: { self: { href: url.href }, next: { href: url.href }, prev: { href: url.href } },
        _embedded: { records },
      });
    }
    if ((m = /^\/transactions\/([0-9a-f]{64})$/u.exec(path))) {
      const tx = this.txs.get(m[1]!);
      if (!tx) return notFound();
      return Response.json({
        hash: m[1],
        ledger: tx.ledger,
        successful: tx.successful,
        _links: { ledger: { href: `https://horizon-testnet.stellar.org/ledgers/${tx.ledger}` } },
      });
    }
    if (path === "/fee_stats") {
      return Response.json({
        last_ledger: String(this.ledger),
        last_ledger_base_fee: "100",
        ledger_capacity_usage: this.ledgerCapacityUsage,
        fee_charged: { p90: this.feeChargedP90, mode: this.feeChargedMode },
        max_fee: { p90: "1000000" },
      });
    }
    if (path === "/ledgers") {
      return Response.json({
        _links: { self: { href: url.href }, next: { href: url.href }, prev: { href: url.href } },
        _embedded: {
          records: [
            {
              sequence: this.ledger,
              closed_at: new Date(this.ledgerCloseTime() * 1000).toISOString(),
              base_reserve_in_stroops: Number(BASE_RESERVE),
            },
          ],
        },
      });
    }
    throw new Error(`fake: unexpected GET ${url.href}`);
  }

  private account(id: string): Response {
    const queue = this.staleViews.get(id);
    const live = this.accounts.get(id);
    const view = queue && queue.length > 0 ? queue.shift()! : live;
    if (!view) return notFound();
    return Response.json({
      id,
      account_id: id,
      sequence: view.seq.toString(),
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
      last_modified_ledger: view.lastModified,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: {},
      balances: [
        {
          asset_type: "native",
          balance: this.balanceText.get(id) ?? fromStroops(view.balance),
          buying_liabilities: "0.0000000",
          selling_liabilities: "0.0000000",
        },
      ],
      signers: [{ key: id, weight: 1, type: "ed25519_public_key" }],
      data: {},
    });
  }

  private submit(body: string): Response {
    const xdr = decodeURIComponent(body.replace(/^tx=/u, ""));
    const tx = TransactionBuilder.fromXdr(xdr, Networks.TESTNET) as Transaction;
    this.submitted.push(tx);
    const hook = this.beforeNextSubmit;
    this.beforeNextSubmit = null;
    hook?.();
    const script = this.submitScript.shift() ?? { kind: "apply" };
    if (script.kind === "reject") return txFailed(script.codes);
    if (script.kind === "drop-504") return gatewayTimeout();
    if (script.kind === "drop-no-hash") return Response.json({ successful: true });

    const outcome = this.apply(tx);
    if (outcome !== null) return txFailed(outcome);
    const hash = Buffer.from(tx.hash()).toString("hex");
    if (script.kind === "apply-then-504") return gatewayTimeout();
    if (script.kind === "apply-no-hash") return Response.json({ successful: true });
    return Response.json({ hash, ledger: this.ledger, successful: true, envelope_xdr: xdr });
  }

  // another tab's forward: pay out and merge the mediator into `into` in a new
  // ledger, under a transaction this test never submitted
  forwardElsewhere(mediator: string, into: string): string {
    this.ledger += 1;
    const src = this.accounts.get(mediator);
    const dst = this.accounts.get(into);
    if (!src || !dst) throw new Error("fake: forward between unknown accounts");
    dst.balance += src.balance;
    dst.lastModified = this.ledger;
    this.accounts.delete(mediator);
    const hash = randomHash();
    this.addOp([mediator, into], { type: "payment", source_account: mediator }, hash);
    this.addOp([mediator, into], { type: "account_merge", source_account: mediator, into }, hash);
    this.txs.set(hash, { ledger: this.ledger, successful: true });
    return hash;
  }

  // returns result codes on refusal, null when applied
  private apply(tx: Transaction): { transaction: string; operations?: string[] } | null {
    const source = this.accounts.get(tx.source);
    if (!source) return { transaction: "tx_no_source_account" };
    if (BigInt(tx.sequence) !== source.seq + 1n) return { transaction: "tx_bad_seq" };
    const ops = BigInt(tx.operations.length);
    if (BigInt(tx.fee) < this.surgeFeePerOp * ops) return { transaction: "tx_insufficient_fee" };
    const kp = Keypair.fromPublicKey(tx.source);
    const hash = tx.hash();
    if (!tx.signatures.some((s) => kp.verify(hash, s.signature))) {
      return { transaction: "tx_bad_auth" };
    }
    const maxTime = Number(tx.timeBounds?.maxTime ?? "0");
    // the network judges maxTime against its own close time
    if (maxTime !== 0 && this.ledgerCloseTime() > maxTime) return { transaction: "tx_too_late" };

    const charged = this.surgeFeePerOp * ops;
    const minBalance = 2n * BASE_RESERVE;
    let balance = source.balance - charged;
    const pay = tx.operations[0];
    const merge = tx.operations[1];
    if (pay?.type !== "payment" || merge?.type !== "accountMerge") {
      throw new Error("fake: only the forward shape is modelled");
    }
    const amount = toStroops(pay.amount);
    if (balance - amount < minBalance) {
      return { transaction: "tx_failed", operations: ["op_underfunded", "op_success"] };
    }
    balance -= amount;
    this.ledger += 1;
    const dest = this.accounts.get(pay.destination);
    if (dest) {
      dest.balance += amount + balance;
      dest.lastModified = this.ledger;
    }
    this.accounts.delete(tx.source);
    const txHash = Buffer.from(hash).toString("hex");
    this.addOp(
      [tx.source, pay.destination],
      { type: "payment", source_account: tx.source },
      txHash,
    );
    this.addOp(
      [tx.source, merge.destination],
      { type: "account_merge", source_account: tx.source, into: merge.destination },
      txHash,
    );
    this.txs.set(txHash, { ledger: this.ledger, successful: true });
    this.lastForward = { amount, mergeRemainder: balance, memo: tx.memo, feeBid: BigInt(tx.fee) };
    return null;
  }

  lastForward: {
    amount: bigint;
    mergeRemainder: bigint;
    memo: Transaction["memo"];
    feeBid: bigint;
  } | null = null;

  private addOp(
    accounts: string[],
    op: Omit<OpRecord, "id" | "transaction_hash" | "transaction_successful">,
    hash: string,
  ): void {
    const id = ((BigInt(this.ledger) << 32n) + BigInt(this.opCounter++)).toString();
    const record: OpRecord = { ...op, id, transaction_hash: hash, transaction_successful: true };
    for (const a of new Set(accounts)) {
      if (!StrKey.isValidEd25519PublicKey(a)) continue;
      const list = this.ops.get(a) ?? [];
      list.push(record);
      this.ops.set(a, list);
      this.known.add(a);
    }
  }
}

function notFound(): Response {
  return Response.json(
    {
      type: "https://stellar.org/horizon-errors/not_found",
      title: "Resource Missing",
      status: 404,
    },
    { status: 404 },
  );
}

function gatewayTimeout(): Response {
  return Response.json(
    { type: "https://stellar.org/horizon-errors/timeout", title: "Timeout", status: 504 },
    { status: 504 },
  );
}

function txFailed(codes: { transaction: string; operations?: string[] }): Response {
  return Response.json(
    {
      type: "https://stellar.org/horizon-errors/transaction_failed",
      title: "Transaction Failed",
      status: 400,
      extras: { result_codes: codes },
    },
    { status: 400 },
  );
}

function randomHash(): string {
  return Buffer.from(Keypair.random().rawPublicKey()).toString("hex");
}

export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole ?? "0") * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
}

export function fromStroops(stroops: bigint): string {
  return `${(stroops / 10_000_000n).toString()}.${(stroops % 10_000_000n).toString().padStart(7, "0")}`;
}

export const XLM = 10_000_000n;
export { BASE_RESERVE };
