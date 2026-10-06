import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Memo } from "@stellar/stellar-sdk";

vi.mock("server-only", () => ({}));
process.env.MEDIATOR_SECRET = Keypair.random().secret();

import * as reissueRoute from "@/app/api/mediator/reissue/route";
import * as signRoute from "@/app/api/mediator/sign/route";
import { TESTNET } from "@/lib/config/networks";
import { startMediatorFlow } from "@/lib/mediator/client";
import { submitMediatorForward, type MediatorForwardInput } from "@/lib/mediator/forward";
import { encodeMemoCommitment } from "@/lib/mediator/forward-terms";
import { MEDIATOR_FLOW_TTL_MS } from "@/server/mediator-secret";

import { BASE_RESERVE, FakeHorizon, XLM } from "./mediator-horizon-fake";

const MEMO = { type: "id", value: "90210" } as const;

let fake: FakeHorizon;
let clockOffset = 0;
const sleeps: number[] = [];
const deps = {
  sleep: async (ms: number) => {
    sleeps.push(ms);
    clockOffset += ms;
  },
  now: () => Date.now() + clockOffset,
};

let user: string;
let cex: string;

async function mintedFlow(): Promise<{ flowToken: string; mediatorPublicKey: string }> {
  const flow = await startMediatorFlow(cex, { network: "testnet", memo: MEMO });
  if (!flow.ok) throw new Error(`mint failed: ${flow.code} ${flow.reason}`);
  return flow;
}

// the state after the close's merge: mediator funded with 2 XLM, then the
// user's 100 XLM account merged into it
async function mergedFlow(): Promise<MediatorForwardInput> {
  const flow = await mintedFlow();
  fake.createAccount(flow.mediatorPublicKey, 2n * XLM);
  fake.mergeInto(user, flow.mediatorPublicKey);
  return {
    mediatorPublicKey: flow.mediatorPublicKey,
    flowToken: flow.flowToken,
    destination: cex,
    memo: MEMO,
    network: TESTNET,
    closedAccount: user,
  };
}

beforeEach(() => {
  fake = new FakeHorizon({
    sign: { GET: signRoute.GET, POST: signRoute.POST },
    reissue: reissueRoute.POST,
  });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  signRoute.__resetRateLimiterForTests();
  reissueRoute.__resetRateLimiterForTests();
  clockOffset = 0;
  sleeps.length = 0;
  user = Keypair.random().publicKey();
  cex = Keypair.random().publicKey();
  fake.createAccount(user, 100n * XLM);
  fake.createAccount(cex, 1n * XLM);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("submitMediatorForward", () => {
  it("pays everything above the minimum balance and the fee, with the committed memo", async () => {
    const input = await mergedFlow();
    const result = await submitMediatorForward(input, deps);
    expect(result).toMatchObject({ ok: true, alreadyDelivered: false });
    const sent = fake.lastForward!;
    // 102 XLM in the mediator, minus 2 base reserves, minus 2 ops at 100 stroops
    expect(sent.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 200n);
    // the merge leg carries only the minimum balance
    expect(sent.mergeRemainder).toBe(2n * BASE_RESERVE);
    expect(encodeMemoCommitment(sent.memo)).toBe(encodeMemoCommitment(Memo.id("90210")));
    // the envelope went through the real validator and signer
    expect(fake.requests).toContain("POST /api/mediator/sign");
  });

  it("waits for a lagging view to include the merge before sizing the payment", async () => {
    const input = await mergedFlow();
    const live = fake.accounts.get(input.mediatorPublicKey)!;
    // two reads from a node one ledger behind: only the 2 XLM funding, older ledger
    const stale = { balance: 2n * XLM, seq: live.seq, lastModified: live.lastModified - 1 };
    fake.staleViews.set(input.mediatorPublicKey, [stale, { ...stale }]);
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 200n);
  });

  it("refuses to send anything when the merge never shows up", async () => {
    const flow = await mintedFlow();
    fake.createAccount(flow.mediatorPublicKey, 2n * XLM); // funded, never merged into
    const result = await submitMediatorForward(
      {
        mediatorPublicKey: flow.mediatorPublicKey,
        flowToken: flow.flowToken,
        destination: cex,
        memo: MEMO,
        network: TESTNET,
        closedAccount: user,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not visible");
    expect(fake.submitted).toHaveLength(0);
  });

  it("does not take a stranger's merge into the mediator for the user's", async () => {
    const flow = await mintedFlow();
    fake.createAccount(flow.mediatorPublicKey, 2n * XLM);
    const stranger = Keypair.random().publicKey();
    fake.createAccount(stranger, 3n * XLM);
    fake.mergeInto(stranger, flow.mediatorPublicKey);
    const result = await submitMediatorForward(
      {
        mediatorPublicKey: flow.mediatorPublicKey,
        flowToken: flow.flowToken,
        destination: cex,
        memo: MEMO,
        network: TESTNET,
        closedAccount: user,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(fake.submitted).toHaveLength(0);
  });

  it("bids the per-op fee from fee_charged p90 while ledgers are near full", async () => {
    fake.feeChargedP90 = "5000";
    fake.ledgerCapacityUsage = "0.95";
    const input = await mergedFlow();
    expect((await submitMediatorForward(input, deps)).ok).toBe(true);
    // per-op fee times two operations
    expect(fake.submitted[0]!.fee).toBe("10000");
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 10_000n);
  });

  it("does not let soroban resource fees in the stats inflate the bid when ledgers have room", async () => {
    // testnet on 2026-10-06: capacity 0.1, fee_charged mode 100, p90 100791
    fake.ledgerCapacityUsage = "0.1";
    fake.feeChargedMode = "100";
    fake.feeChargedP90 = "100791";
    const input = await mergedFlow();
    expect((await submitMediatorForward(input, deps)).ok).toBe(true);
    expect(fake.submitted[0]!.fee).toBe("200");
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 200n);
  });

  it("escalates the fee on tx_insufficient_fee and pays less only by the higher fee", async () => {
    fake.feeChargedP90 = "5000";
    fake.ledgerCapacityUsage = "0.95";
    fake.surgeFeePerOp = 20_000n;
    const input = await mergedFlow();
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    expect(fake.submitted.map((t) => t.fee)).toEqual(["10000", "30000", "90000"]);
    // the unused part of the bid stays in the merge leg, the payment never drops
    // below balance minus reserve minus the bid
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 90_000n);
  });

  it("reports horizon result codes instead of a bare 400", async () => {
    const input = await mergedFlow();
    fake.submitScript.push({
      kind: "reject",
      codes: { transaction: "tx_failed", operations: ["op_underfunded", "op_success"] },
    });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tx_failed [op_underfunded, op_success]");
  });

  it("treats a 504 as unknown and returns the real hash once the forward shows up", async () => {
    const input = await mergedFlow();
    fake.submitScript.push({ kind: "apply-then-504" });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.txHash).toBe(Buffer.from(fake.submitted[0]!.hash()).toString("hex"));
      expect(result.txHash).not.toContain("unknown");
      expect(result.ledger).toBe(fake.ledger);
    }
  });

  it("never fabricates a receipt when a 200 comes back without a hash", async () => {
    const input = await mergedFlow();
    fake.submitScript.push({ kind: "apply-no-hash" });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.txHash).toBe(Buffer.from(fake.submitted[0]!.hash()).toString("hex"));
  });

  it("does not take a 200 without its hash as landed", async () => {
    const input = await mergedFlow();
    fake.submitScript.push({ kind: "drop-no-hash" });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    // the first answer said nothing reliable and the ledger never had it
    expect(fake.submitted).toHaveLength(2);
    if (result.ok) {
      expect(result.txHash).toBe(Buffer.from(fake.submitted[1]!.hash()).toString("hex"));
    }
  });

  it("rebuilds after a dropped submission has expired with a higher bid, without double paying", async () => {
    const input = await mergedFlow();
    fake.submitScript.push({ kind: "drop-504" });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    // under surge pricing an underpriced forward is queued, not refused, and
    // simply never makes a ledger; the rebuild bids three times as much
    expect(fake.submitted.map((t) => t.fee)).toEqual(["200", "600"]);
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 600n);
  });

  it("sends both the payment and the merge to the committed destination", async () => {
    const input = await mergedFlow();
    expect((await submitMediatorForward(input, deps)).ok).toBe(true);
    const [pay, merge] = fake.submitted[0]!.operations;
    expect(pay).toMatchObject({ type: "payment", destination: cex });
    expect(merge).toMatchObject({ type: "accountMerge", destination: cex });
  });

  it("forwards a base64 hash memo as the same 32 bytes as its hex spelling", async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const hex = Buffer.from(bytes).toString("hex");
    const b64 = Buffer.from(bytes).toString("base64");
    // minted with the hex spelling, forwarded with the base64 one
    const flow = await startMediatorFlow(cex, {
      network: "testnet",
      memo: { type: "hash", value: hex },
    });
    if (!flow.ok) throw new Error(flow.reason);
    fake.createAccount(flow.mediatorPublicKey, 2n * XLM);
    fake.mergeInto(user, flow.mediatorPublicKey);
    const result = await submitMediatorForward(
      {
        mediatorPublicKey: flow.mediatorPublicKey,
        flowToken: flow.flowToken,
        destination: cex,
        memo: { type: "hash", value: b64 },
        network: TESTNET,
        closedAccount: user,
      },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(encodeMemoCommitment(fake.lastForward!.memo)).toBe(encodeMemoCommitment(Memo.hash(hex)));
  });

  it("reports a forward another tab already delivered as delivered", async () => {
    const input = await mergedFlow();
    const first = await submitMediatorForward(input, deps);
    expect(first.ok).toBe(true);
    const second = await submitMediatorForward(input, deps);
    expect(second).toMatchObject({ ok: true, alreadyDelivered: true });
    if (first.ok && second.ok) expect(second.txHash).toBe(first.txHash);
    expect(fake.submitted).toHaveLength(1);
  });

  it("reports a forward that lost the race to another tab as delivered by that tab", async () => {
    const input = await mergedFlow();
    // the other tab's forward lands between this tab's account read and its submit,
    // so this submission finds no source account
    let otherHash = "";
    fake.beforeNextSubmit = () => {
      otherHash = fake.forwardElsewhere(input.mediatorPublicKey, cex);
    };
    const result = await submitMediatorForward(input, deps);
    expect(result).toMatchObject({ ok: true, alreadyDelivered: true, txHash: otherHash });
    expect(fake.submitted).toHaveLength(1);
  });

  it("renews an expired flow token and still forwards to the committed destination", async () => {
    const input = await mergedFlow();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MEDIATOR_FLOW_TTL_MS + 60 * 60 * 1000);
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flowToken).not.toBe(input.flowToken);
    expect(fake.requests).toContain("POST /api/mediator/reissue");
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 200n);
  });

  it("refuses a renewed token that unlocks a different mediator", async () => {
    const input = await mergedFlow();
    const other = await mintedFlow();
    // a re-issue answer for some other flow's mediator
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
        if (raw.startsWith("/api/mediator/reissue")) {
          return Response.json({ ok: true, ...other, expiresAt: Date.now() + 60_000 });
        }
        return fake.fetch(req, init);
      }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MEDIATOR_FLOW_TTL_MS + 60_000);
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(other.mediatorPublicKey);
      expect(result.flowToken).toBe(input.flowToken);
    }
    expect(fake.submitted).toHaveLength(0);
  });
});

describe("submitMediatorForward against a busy or flaky mediator endpoint", () => {
  // answers the first `times` co-sign posts with `reply` (or a transport error),
  // then lets the real route handle them
  function interruptSigning(times: number, reply: () => Response | Promise<Response>) {
    let left = times;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
        if (raw === "/api/mediator/sign" && init?.method === "POST" && left > 0) {
          left -= 1;
          return reply();
        }
        return fake.fetch(req, init);
      }),
    );
  }

  const rateLimited = (seconds: string) => () =>
    Response.json(
      { ok: false, code: "RATE_LIMITED", reason: "Too many requests." },
      { status: 429, headers: { "retry-after": seconds } },
    );

  it("waits out a 429 for the time the server asks and then forwards", async () => {
    const input = await mergedFlow();
    interruptSigning(1, rateLimited("7"));
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    expect(sleeps).toContain(7_000);
    expect(fake.submitted).toHaveLength(1);
  });

  it("caps a long retry-after", async () => {
    const input = await mergedFlow();
    interruptSigning(1, rateLimited("3600"));
    expect((await submitMediatorForward(input, deps)).ok).toBe(true);
    expect(sleeps).toContain(60_000);
    expect(Math.max(...sleeps)).toBe(60_000);
  });

  it("retries a transport failure with a growing pause", async () => {
    const input = await mergedFlow();
    interruptSigning(2, () => Promise.reject(new TypeError("fetch failed")));
    expect((await submitMediatorForward(input, deps)).ok).toBe(true);
    expect(sleeps.slice(-2)).toEqual([2_000, 4_000]);
  });

  it("gives up after three retries and sends nothing", async () => {
    const input = await mergedFlow();
    interruptSigning(4, rateLimited("1"));
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("RATE_LIMITED");
    expect(fake.submitted).toHaveLength(0);
  });

  it("does not retry a refusal", async () => {
    const input = await mergedFlow();
    let posts = 0;
    interruptSigning(5, () => {
      posts += 1;
      return Response.json(
        { ok: false, code: "FORWARD_MEMO_NOT_COMMITTED", reason: "memo" },
        { status: 400 },
      );
    });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(false);
    expect(posts).toBe(1);
  });
});
