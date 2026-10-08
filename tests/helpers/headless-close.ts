// drives the app's own close state machine (pageFlowMachine) without a browser:
// discovery, preview, hydration and the executor all run exactly as on
// /demolish, against the live network. only the page around it is missing, so
// the test plays the user's part: it reads the review and sends the typed
// confirmation the confirm dialog would.

import { Horizon } from "@stellar/stellar-sdk";
import { createActor, waitFor, type SnapshotFrom } from "xstate";

import type { NetworkConfig } from "@/lib/config/networks";
import { pageFlowMachine, type PageFlowInput } from "@/lib/orchestrator/page-flow-machine";
import type { Connector } from "@/lib/wallet/connector";

export type FlowSnapshot = SnapshotFrom<typeof pageFlowMachine>;
export type FlowActor = ReturnType<typeof createActor<typeof pageFlowMachine>>;

const REVIEW_TIMEOUT_MS = 240_000;
const EXECUTE_TIMEOUT_MS = 280_000;

export function startFlow(): FlowActor {
  const actor = createActor(pageFlowMachine);
  actor.start();
  return actor;
}

// START and wait for the review (or a failure before it)
export async function reachReview(actor: FlowActor, input: PageFlowInput): Promise<FlowSnapshot> {
  actor.send({ type: "START", input });
  return waitFor(actor, (s) => s.matches("awaiting_confirmation") || s.matches("failed"), {
    timeout: REVIEW_TIMEOUT_MS,
  });
}

// what the review shows the user that keeps confirm disabled, in one list, so a
// failing test names the reason instead of timing out on a refused CONFIRM
export function reviewProblems(s: FlowSnapshot): string[] {
  const c = s.context;
  return [
    ...(s.matches("failed") ? [`failed (${c.failureKind}): ${c.error}`] : []),
    ...c.reviewBlockers.map((b) => `blocker: ${b}`),
    ...c.unroutableCredits.map((u) => `unroutable credit: ${u.key}`),
    ...c.refusedConversions.map((r) => `refused conversion ${r.key}: ${r.reason}`),
    ...c.emissionForfeits.map((f) => `emission forfeit ${f.poolId}: ${f.reason}`),
  ];
}

// the typed confirmation: the last four characters of the reviewed destination
export function confirm(actor: FlowActor): void {
  const input = actor.getSnapshot().context.input;
  if (input === null) throw new Error("confirm: the machine holds no run");
  actor.send({
    type: "CONFIRM",
    typed: input.destination.slice(-4),
    expected: { publicKey: input.publicKey, networkId: input.network.id },
  });
}

export async function waitForOutcome(actor: FlowActor): Promise<FlowSnapshot> {
  // the CONFIRM is processed synchronously; wait for the run it started to end
  return waitFor(
    actor,
    (s) => s.matches("succeeded") || s.matches("failed") || s.matches("prepared"),
    { timeout: EXECUTE_TIMEOUT_MS },
  );
}

export function retry(actor: FlowActor, connector: Connector): void {
  actor.send({ type: "RETRY", connector });
}

// the whole close with the default choices: review, confirm, run
export async function closeHeadless(
  input: PageFlowInput,
): Promise<{ readonly review: FlowSnapshot; readonly outcome: FlowSnapshot }> {
  const actor = startFlow();
  try {
    const review = await reachReview(actor, input);
    const problems = reviewProblems(review);
    if (problems.length > 0) {
      throw new Error(`the review would not let this close run:\n${problems.join("\n")}`);
    }
    confirm(actor);
    const outcome = await waitForOutcome(actor);
    return { review, outcome };
  } finally {
    actor.stop();
  }
}

export function outcomeSummary(s: FlowSnapshot): string {
  const nodes = s.context.tree
    ? [...s.context.tree.allNodes.values()].map(
        (n) => `${n.id} ${n.kind} ${n.status}${n.error ? `: ${n.error}` : ""}`,
      )
    : [];
  return [
    `state ${JSON.stringify(s.value)}`,
    `error ${s.context.error ?? "none"} (${s.context.failureKind ?? "no kind"})`,
    ...nodes,
  ].join("\n");
}

export async function friendbotFund(network: NetworkConfig, publicKey: string): Promise<void> {
  if (network.friendbot === null) throw new Error(`${network.id} has no friendbot`);
  const res = await fetch(`${network.friendbot}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${res.status}`);
}

export async function nativeBalance(horizon: Horizon.Server, publicKey: string): Promise<bigint> {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find((b) => b.asset_type === "native");
  if (line === undefined) throw new Error(`${publicKey} has no native balance line`);
  return toStroops(line.balance);
}

export async function accountExists(horizon: Horizon.Server, publicKey: string): Promise<boolean> {
  try {
    await horizon.loadAccount(publicKey);
    return true;
  } catch (err) {
    if ((err as { response?: { status?: number } }).response?.status === 404) return false;
    throw err;
  }
}

// "123.4567890" -> 1234567890n
export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole ?? "0") * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}
