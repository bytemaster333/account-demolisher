// post-merge mediator forward: once the user's accountMerge into the mediator
// has landed, pay the balance to the destination with the deposit memo and merge
// the mediator away to the same destination.

import {
  Asset,
  Horizon,
  NotFoundError,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import {
  horizonFor,
  loadMediatorAccount,
  readMediatorHistory,
  type MediatorHistory,
  type MediatorMergedOut,
} from "@/lib/mediator/chain-state";
import {
  reissueMediatorFlow,
  requestMediatorSignature,
  type MediatorFailure,
} from "@/lib/mediator/client";
import {
  FORWARD_OPERATION_COUNT,
  MAX_FORWARD_FEE_PER_OP,
  forwardMemoToSdk,
} from "@/lib/mediator/forward-terms";
import { decimalToStroops, stroopsToDecimal } from "@/lib/stellar/amount";
import type { ClassicMemo } from "@/lib/types/plan";

export interface MediatorForwardInput {
  readonly mediatorPublicKey: string;
  // token from startMediatorFlow that unlocks this flow's signing key. it is
  // renewed through the re-issue route when it has expired.
  readonly flowToken: string;
  readonly destination: string;
  readonly memo?: ClassicMemo;
  readonly network: NetworkConfig;
  // the account whose merge funds the mediator. when given, the forward only
  // counts a merge from this account as the one it is waiting for.
  readonly closedAccount?: string;
}

export type MediatorForwardResult =
  | {
      readonly ok: true;
      readonly txHash: string;
      readonly ledger: number;
      // true when an earlier forward (another tab, a lost response) had already
      // delivered the balance and nothing new was sent
      readonly alreadyDelivered: boolean;
      // the token to keep for this flow; differs from the input after a re-issue
      readonly flowToken: string;
    }
  | { readonly ok: false; readonly error: string; readonly flowToken: string };

export interface MediatorForwardDeps {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const NETWORK_MIN_FEE_PER_OP = 100;
// the forward's own validity window; short, so an ambiguous submit resolves fast
const FORWARD_TIMEOUT_SECONDS = 180;
const MAX_FORWARD_ATTEMPTS = 4;
// the merge was just confirmed by a possibly different horizon node; give the
// one we read from time to catch up before refusing
const VIEW_POLL_ATTEMPTS = 10;
const VIEW_POLL_DELAY_MS = 2_000;
const RECONCILE_POLL_DELAY_MS = 5_000;
// how long past maxTime a tx may still show up in horizon's history
const RECONCILE_GRACE_MS = 30_000;
const READ_ATTEMPTS = 3;
// below this share of a full ledger there is no classic surge to outbid
const SURGE_CAPACITY_USAGE = 0.5;
// retries of a rate-limited or unreachable mediator endpoint
const ENDPOINT_RETRIES = 3;
const ENDPOINT_BACKOFF_MS = 2_000;
const MAX_RETRY_AFTER_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function submitMediatorForward(
  input: MediatorForwardInput,
  deps: MediatorForwardDeps = {},
): Promise<MediatorForwardResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const server = horizonFor(input.network);
  let flowToken = input.flowToken;
  const fail = (error: string): MediatorForwardResult => ({ ok: false, error, flowToken });

  try {
    // 1. find the merge that funded the mediator, or the forward that already
    // emptied it
    let history: MediatorHistory | null = null;
    for (let i = 0; i < VIEW_POLL_ATTEMPTS; i++) {
      history = await read(() =>
        readMediatorHistory(server, input.mediatorPublicKey, input.closedAccount),
      );
      if (history.mergedOut !== null || history.mergeIn !== null) break;
      await sleep(VIEW_POLL_DELAY_MS);
    }
    if (history?.mergedOut) {
      return deliveredResult(history.mergedOut, input.destination, flowToken);
    }
    if (!history?.mergeIn) {
      return fail(
        "The merge into the mediator account is not visible on Horizon, so nothing was forwarded. " +
          "If the merge landed, resume the forward in a minute.",
      );
    }
    const mergeLedger = history.mergeIn.ledger;

    let feePerOp = await read(() => startingFeePerOp(server));
    const reserve = await read(() => baseReserveStroops(server));
    let lastProblem = "no attempt was made";

    for (let attempt = 1; attempt <= MAX_FORWARD_ATTEMPTS; attempt++) {
      // 2. wait until the account view includes the merge. A view one ledger
      // behind still shows only the 2 XLM funding, and sizing the payment from
      // it would send the user's balance through the uncredited merge leg.
      const account = await waitForAccountView(server, input.mediatorPublicKey, mergeLedger, sleep);
      if (account === "gone") {
        // the node that answered 404 may be ahead of the one serving history
        for (let i = 0; i < VIEW_POLL_ATTEMPTS; i++) {
          const after = await read(() => readMediatorHistory(server, input.mediatorPublicKey));
          if (after.mergedOut !== null) {
            return deliveredResult(after.mergedOut, input.destination, flowToken);
          }
          await sleep(VIEW_POLL_DELAY_MS);
        }
        return fail("The mediator account no longer exists and no forward out of it was found.");
      }
      if (account === "stale") {
        return fail(
          `Horizon has not caught up with the merge into the mediator (ledger ${String(mergeLedger)}); ` +
            "nothing was forwarded. Resume the forward in a minute.",
        );
      }

      // 3. pay everything above the mediator's minimum balance and the fee; the
      // merge leg then carries only that minimum plus any unused fee
      const amount = forwardableStroops(account, reserve, feePerOp);
      if (amount <= 0n) {
        return fail(
          `Mediator balance ${nativeLine(account)?.balance ?? "0"} XLM does not cover its minimum balance and the forward fee.`,
        );
      }
      const unsigned = new TransactionBuilder(account, {
        fee: String(feePerOp),
        networkPassphrase: input.network.passphrase,
        memo: forwardMemoToSdk(input.memo),
      })
        .addOperation(
          Operation.payment({
            destination: input.destination,
            asset: Asset.native(),
            amount: stroopsToDecimal(amount),
          }),
        )
        .addOperation(Operation.accountMerge({ destination: input.destination }))
        .setTimeout(FORWARD_TIMEOUT_SECONDS)
        .build();

      // 4. co-sign, renewing the token once if it has expired
      const unsignedXdr = unsigned.toEnvelope().toXdr("base64");
      const cosign = (token: string) =>
        withEndpointRetry(
          () => requestMediatorSignature(unsignedXdr, token, input.network.id),
          sleep,
        );
      let signature = await cosign(flowToken);
      if (!signature.ok && signature.code === "FLOW_TOKEN_EXPIRED") {
        const current = flowToken;
        const renewed = await withEndpointRetry(() => reissueMediatorFlow(current), sleep);
        if (!renewed.ok) {
          return fail(
            `Could not renew the expired flow token (${renewed.code}): ${renewed.reason}`,
          );
        }
        // a renewed token must unlock the same mediator; anything else would
        // leave the recovery record pointing at a key that holds nothing
        if (renewed.mediatorPublicKey !== input.mediatorPublicKey) {
          return fail(
            `The re-issue route returned a token for mediator ${renewed.mediatorPublicKey}, not ${input.mediatorPublicKey}.`,
          );
        }
        flowToken = renewed.flowToken;
        signature = await cosign(flowToken);
      }
      if (!signature.ok) {
        return fail(
          `Mediator rejected the forward envelope (${signature.code}): ${signature.reason}`,
        );
      }
      const signed = TransactionBuilder.fromXdr(
        signature.signedXdr,
        input.network.passphrase,
      ) as Transaction;
      const txHash = toHex(signed.hash());
      if (txHash !== toHex(unsigned.hash())) {
        return fail("Mediator returned a different transaction than the one it was asked to sign.");
      }

      // 5. submit, and reconcile by hash whenever the outcome is unknown
      const outcome = await submitAndReconcile(server, signed, txHash, sleep, now);
      if (outcome.kind === "landed") {
        return { ok: true, txHash, ledger: outcome.ledger, alreadyDelivered: false, flowToken };
      }
      if (outcome.kind === "error") return fail(outcome.message);
      if (outcome.kind === "expired") {
        // tx_insufficient_fee only means below the network minimum. under surge
        // pricing an underpriced forward is queued or told to try again later
        // and just never makes a ledger, so the rebuild bids higher
        lastProblem = `forward ${txHash} was not seen on chain before it expired`;
        feePerOp = Math.min(feePerOp * 3, MAX_FORWARD_FEE_PER_OP);
        continue;
      }
      const codes = outcome.codes;
      lastProblem = `forward rejected: ${formatCodes(codes)}`;
      if (codes.transaction === "tx_insufficient_fee") {
        if (feePerOp >= MAX_FORWARD_FEE_PER_OP) {
          return fail(
            `${lastProblem}; already bidding the ${String(MAX_FORWARD_FEE_PER_OP)} stroop per-op ceiling.`,
          );
        }
        feePerOp = Math.min(feePerOp * 3, MAX_FORWARD_FEE_PER_OP);
        continue;
      }
      // another tab's forward got there first (the mediator is gone or its
      // sequence moved) or the timebound lapsed: reload, and a forward that
      // already went out is found by the "gone" check above
      if (
        codes.transaction === "tx_no_source_account" ||
        codes.transaction === "tx_bad_seq" ||
        codes.transaction === "tx_too_late"
      ) {
        continue;
      }
      return fail(`Mediator forward submission failed: ${formatCodes(codes)}`);
    }
    return fail(
      `Mediator forward did not land after ${String(MAX_FORWARD_ATTEMPTS)} attempts: ${lastProblem}`,
    );
  } catch (err) {
    return fail(`Mediator forward failed: ${describe(err)}`);
  }
}

function deliveredResult(
  mergedOut: MediatorMergedOut,
  destination: string,
  flowToken: string,
): MediatorForwardResult {
  if (mergedOut.into !== destination) {
    return {
      ok: false,
      error: `The mediator was merged into ${mergedOut.into}, not the committed destination ${destination}.`,
      flowToken,
    };
  }
  return {
    ok: true,
    txHash: mergedOut.txHash,
    ledger: mergedOut.ledger,
    alreadyDelivered: true,
    flowToken,
  };
}

async function waitForAccountView(
  server: Horizon.Server,
  mediatorPublicKey: string,
  mergeLedger: number,
  sleep: (ms: number) => Promise<void>,
): Promise<Horizon.AccountResponse | "gone" | "stale"> {
  for (let i = 0; i < VIEW_POLL_ATTEMPTS; i++) {
    const account = await read(() => loadMediatorAccount(server, mediatorPublicKey));
    if (account === null) return "gone";
    if (account.last_modified_ledger >= mergeLedger) return account;
    await sleep(VIEW_POLL_DELAY_MS);
  }
  return "stale";
}

// fee_charged is what recent transactions actually paid; max_fee is what other
// submitters bid, which sits at the cap under any load. fee_charged also counts
// soroban transactions, whose resource fees push its upper percentiles far above
// any classic surge price (testnet on 2026-10-06: capacity 0.1, mode 100, p90
// 100791). while recent ledgers had room the classic price is the mode; p90 is
// only used once they run near full. an underbid is raised on the rebuild, and
// whatever the bid leaves unused travels in the uncredited merge leg.
async function startingFeePerOp(server: Horizon.Server): Promise<number> {
  const stats = await server.feeStats();
  const usage = Number.parseFloat(stats.ledger_capacity_usage);
  const pick = usage < SURGE_CAPACITY_USAGE ? stats.fee_charged.mode : stats.fee_charged.p90;
  if (!Number.isFinite(usage)) {
    throw new Error(
      `Horizon fee_stats returned an unreadable ledger_capacity_usage "${stats.ledger_capacity_usage}".`,
    );
  }
  const fee = Number.parseInt(pick, 10);
  if (!Number.isFinite(fee)) {
    throw new Error(`Horizon fee_stats returned an unreadable fee_charged value "${pick}".`);
  }
  return Math.min(Math.max(fee, NETWORK_MIN_FEE_PER_OP), MAX_FORWARD_FEE_PER_OP);
}

// one call to a mediator endpoint, retried on a 429 (waiting what the server
// asked, capped) or a transport failure. a refusal is never retried. this runs
// after the user's balance is already in the mediator, so a busy endpoint must
// not end the forward on its first answer.
async function withEndpointRetry<T extends { ok: boolean }>(
  call: () => Promise<T | MediatorFailure>,
  sleep: (ms: number) => Promise<void>,
): Promise<T | MediatorFailure> {
  let result = await call();
  for (let retry = 0; retry < ENDPOINT_RETRIES; retry++) {
    if (result.ok) return result;
    const failure = result as MediatorFailure;
    if (failure.code !== "RATE_LIMITED" && failure.code !== "NETWORK_ERROR") return result;
    const backoff = ENDPOINT_BACKOFF_MS * 2 ** retry;
    const asked =
      failure.retryAfterSeconds === undefined ? backoff : failure.retryAfterSeconds * 1000;
    await sleep(Math.min(asked, MAX_RETRY_AFTER_MS));
    result = await call();
  }
  return result;
}

async function baseReserveStroops(server: Horizon.Server): Promise<bigint> {
  const page = await server.ledgers().order("desc").limit(1).call();
  const latest = page.records[0];
  if (latest === undefined) throw new Error("Horizon returned no ledgers.");
  return BigInt(latest.base_reserve_in_stroops);
}

function nativeLine(account: Horizon.AccountResponse): Horizon.HorizonApi.BalanceLineNative | null {
  const line = account.balances.find((b) => b.asset_type === "native");
  return line === undefined ? null : (line as Horizon.HorizonApi.BalanceLineNative);
}

function forwardableStroops(
  account: Horizon.AccountResponse,
  baseReserve: bigint,
  feePerOp: number,
): bigint {
  const line = nativeLine(account);
  if (line === null) return 0n;
  const entries =
    2n +
    BigInt(account.subentry_count) +
    BigInt(account.num_sponsoring) -
    BigInt(account.num_sponsored);
  const minimum = entries * baseReserve;
  const fee = BigInt(feePerOp) * BigInt(FORWARD_OPERATION_COUNT);
  return (
    decimalToStroops(line.balance) -
    decimalToStroops(line.selling_liabilities ?? "0") -
    minimum -
    fee
  );
}

type SubmitOutcome =
  | { readonly kind: "landed"; readonly ledger: number }
  | { readonly kind: "rejected"; readonly codes: ResultCodes }
  | { readonly kind: "expired" }
  | { readonly kind: "error"; readonly message: string };

interface ResultCodes {
  readonly transaction?: string;
  readonly operations?: readonly string[];
}

async function submitAndReconcile(
  server: Horizon.Server,
  signed: Transaction,
  txHash: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<SubmitOutcome> {
  // SEP-29 check on its own, so a failure here is known to have sent nothing
  try {
    await server.checkMemoRequired(signed);
  } catch (err) {
    return { kind: "error", message: `Forward not sent: ${describe(err)}` };
  }
  try {
    const res = await server.submitTransaction(signed, { skipMemoRequiredCheck: true });
    if (typeof res.hash === "string" && res.hash === txHash && typeof res.ledger === "number") {
      return { kind: "landed", ledger: res.ledger };
    }
    // a 200 without our hash says nothing reliable; ask the ledger history
  } catch (err) {
    if (err instanceof TransactionFailedError) {
      const codes = resultCodes(err);
      if (codes !== null) return { kind: "rejected", codes };
    }
    const status = httpStatus(err);
    // a 4xx other than a timeout is a definite refusal; 5xx, 408 and transport
    // failures (including the 60s client timeout) may still land
    if (status !== null && status < 500 && status !== 408) {
      return { kind: "error", message: `Forward submission refused: ${describe(err)}` };
    }
  }
  const maxTimeMs = Number(signed.timeBounds?.maxTime ?? "0") * 1000;
  for (;;) {
    try {
      const record = await server.transactions().transaction(txHash).call();
      if (record.successful) return { kind: "landed", ledger: record.ledger_attr };
      return { kind: "error", message: `Forward ${txHash} was included but failed on chain.` };
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        return {
          kind: "error",
          message: `Could not confirm forward ${txHash}: ${describe(err)}. Check it on an explorer before retrying.`,
        };
      }
    }
    if (now() > maxTimeMs + RECONCILE_GRACE_MS) return { kind: "expired" };
    await sleep(RECONCILE_POLL_DELAY_MS);
  }
}

function resultCodes(err: TransactionFailedError): ResultCodes | null {
  const extras = (err.response as { data?: { extras?: { result_codes?: unknown } } } | undefined)
    ?.data?.extras;
  const codes = extras?.result_codes;
  if (typeof codes !== "object" || codes === null) return null;
  return codes as ResultCodes;
}

function httpStatus(err: unknown): number | null {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : null;
}

function formatCodes(codes: ResultCodes): string {
  const ops = codes.operations?.length ? ` [${codes.operations.join(", ")}]` : "";
  return `${codes.transaction ?? "unknown"}${ops}`;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const status = httpStatus(err);
    const data = (err as { response?: { data?: { title?: unknown; detail?: unknown } } }).response
      ?.data;
    const title = typeof data?.title === "string" ? `: ${data.title}` : "";
    return status !== null ? `${err.message} (HTTP ${String(status)}${title})` : err.message;
  }
  return errorMessage(err);
}

// bounded retry for read-only horizon calls; a 404 is an answer, not a fault
async function read<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < READ_ATTEMPTS; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
