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

  it("bids the per-op fee from fee_charged stats", async () => {
    fake.feeChargedP90 = "5000";
    const input = await mergedFlow();
    expect((await submitMediatorForward(input, deps)).ok).toBe(true);
    // per-op fee times two operations
    expect(fake.submitted[0]!.fee).toBe("10000");
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 10_000n);
  });

  it("escalates the fee on tx_insufficient_fee and pays less only by the higher fee", async () => {
    fake.feeChargedP90 = "5000";
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

  it("rebuilds after a dropped submission has expired, without double paying", async () => {
    const input = await mergedFlow();
    fake.submitScript.push({ kind: "drop-504" });
    const result = await submitMediatorForward(input, deps);
    expect(result.ok).toBe(true);
    expect(fake.submitted).toHaveLength(2);
    expect(fake.lastForward!.amount).toBe(102n * XLM - 2n * BASE_RESERVE - 200n);
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
