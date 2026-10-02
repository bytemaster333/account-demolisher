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
import {
  horizonFor,
  loadMediatorAccount,
  readMediatorHistory,
  type MediatorHistory,
  type MediatorMergedOut,
} from "@/lib/mediator/chain-state";
import { reissueMediatorFlow, requestMediatorSignature } from "@/lib/mediator/client";
import {
  FORWARD_OPERATION_COUNT,
  MAX_FORWARD_FEE_PER_OP,
  forwardMemoToSdk,
} from "@/lib/mediator/forward-terms";
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
        const after = await read(() => readMediatorHistory(server, input.mediatorPublicKey));
        if (after.mergedOut !== null) {
          return deliveredResult(after.mergedOut, input.destination, flowToken);
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
            amount: stroopsToAmount(amount),
          }),
        )
        .addOperation(Operation.accountMerge({ destination: input.destination }))
        .setTimeout(FORWARD_TIMEOUT_SECONDS)
        .build();

      // 4. co-sign, renewing the token once if it has expired
      const unsignedXdr = unsigned.toEnvelope().toXdr("base64");
      let signature = await requestMediatorSignature(unsignedXdr, flowToken, input.network.id);
      if (!signature.ok && signature.code === "FLOW_TOKEN_EXPIRED") {
        const renewed = await reissueMediatorFlow(flowToken);
        if (!renewed.ok) {
          return fail(
            `Could not renew the expired flow token (${renewed.code}): ${renewed.reason}`,
          );
        }
        flowToken = renewed.flowToken;
        signature = await requestMediatorSignature(unsignedXdr, flowToken, input.network.id);
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
        lastProblem = `forward ${txHash} was not seen on chain before it expired`;
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
      // a stale sequence (another tab forwarded first) or a lapsed timebound:
      // reload and rebuild; a forward that already went out is found above
      if (codes.transaction === "tx_bad_seq" || codes.transaction === "tx_too_late") continue;
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
// submitters bid, which sits at the cap under any load
async function startingFeePerOp(server: Horizon.Server): Promise<number> {
  const stats = await server.feeStats();
  const p90 = Number.parseInt(stats.fee_charged.p90, 10);
  if (!Number.isFinite(p90)) {
    throw new Error(
      `Horizon fee_stats returned an unreadable fee_charged.p90 "${stats.fee_charged.p90}".`,
    );
  }
  return Math.min(Math.max(p90, NETWORK_MIN_FEE_PER_OP), MAX_FORWARD_FEE_PER_OP);
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
    amountToStroops(line.balance) - amountToStroops(line.selling_liabilities ?? "0") - minimum - fee
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
  return String(err);
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

// stroop-precision (7 decimal) helpers; avoids pulling in a decimal lib
function amountToStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole ?? "0") * 10_000_000n + BigInt(fracPadded || "0");
}

function stroopsToAmount(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(7, "0")}`;
}
