// submitters for signed classic and soroban transactions. both report what the
// network said precisely: a refusal with its codes, an outcome that is still
// unknown (with the hash, so a retry looks it up first), or a receipt.

import {
  AccountRequiresMemoError,
  FeeBumpTransaction,
  NotFoundError,
  TransactionBuilder,
  xdr,
  type Horizon,
  type Transaction,
  type rpc as RpcNS,
} from "@stellar/stellar-sdk";

import { describeSubmitError, errorMessage } from "@/lib/errors";
import {
  pollSoroban,
  sendSoroban,
  SorobanNotQueuedError,
  type SorobanPollOutcome,
} from "@/lib/soroban/submit";
import {
  AmbiguousSubmitError,
  CloseFailure,
  SubmitRejectedError,
  type ResultCodes,
} from "@/lib/orchestrator/failures";
import type { ConfirmationReceipt } from "@/lib/orchestrator/executor";

export type ClassicSubmitHorizon = Pick<
  Horizon.Server,
  "submitTransaction" | "transactions" | "ledgers"
>;

export interface SubmitTiming {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const RECONCILE_POLL_MS = 3_000;
// a live close's transaction expires within minutes, so its lookup runs until
// then and ends with a definite answer. a multisig bundle can live for days, so
// its lookup is bounded and the retry looks the hash up again before resubmitting.
const RECONCILE_CAP_MS = 120_000;
const WAIT_OUT_MAX_TIME_MS = 10 * 60_000;

export function txHashHex(tx: Transaction | FeeBumpTransaction): string {
  return Array.from(tx.hash(), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function txMaxTime(tx: Transaction | FeeBumpTransaction): number | null {
  const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  const max = Number(inner.timeBounds?.maxTime ?? 0);
  return Number.isFinite(max) && max > 0 ? max : null;
}

export function createClassicSubmitter(
  horizon: ClassicSubmitHorizon,
  passphrase: string,
  timing: SubmitTiming = {},
): (signedXdr: string) => Promise<ConfirmationReceipt> {
  const sleep = timing.sleep ?? realSleep;
  const now = timing.now ?? Date.now;

  // look the hash up until horizon has ingested a ledger past the tx's maxTime;
  // only then is "not found" a definite "did not land"
  const reconcile = async (
    hash: string,
    maxTime: number | null,
    detail: string,
  ): Promise<ConfirmationReceipt> => {
    const expiresAt = maxTime === null ? null : maxTime * 1000 + 30_000;
    const capAt =
      expiresAt !== null && expiresAt - now() <= WAIT_OUT_MAX_TIME_MS
        ? Math.max(expiresAt, now() + RECONCILE_CAP_MS)
        : now() + RECONCILE_CAP_MS;
    for (;;) {
      try {
        const record = await horizon.transactions().transaction(hash).call();
        if (record.successful) return { txHash: hash, ledger: record.ledger_attr };
        throw new SubmitRejectedError({ transaction: resultCodeOf(record.result_xdr) }, undefined);
      } catch (err) {
        if (err instanceof SubmitRejectedError) throw err;
        if (isNotFoundError(err) && maxTime !== null) {
          const closedAt = await latestCloseTime(horizon);
          if (closedAt !== null && closedAt > maxTime) {
            throw new CloseFailure(
              "network",
              `Horizon did not accept transaction ${hash} (${detail}) and it expired without landing.`,
            );
          }
        }
      }
      if (now() + RECONCILE_POLL_MS > capAt) break;
      await sleep(RECONCILE_POLL_MS);
    }
    throw new AmbiguousSubmitError(hash, maxTime, detail);
  };

  return async (signedXdr) => {
    const signed = TransactionBuilder.fromXdr(signedXdr, passphrase);
    const hash = txHashHex(signed);
    const maxTime = txMaxTime(signed);
    let res: { readonly hash?: string; readonly ledger?: number };
    try {
      res = (await horizon.submitTransaction(signed)) as typeof res;
    } catch (err) {
      // the sdk's sep-29 check refused it before anything was sent, so there is
      // nothing to look up, and the same envelope would be refused again
      if (err instanceof AccountRequiresMemoError) {
        throw new CloseFailure(
          "not_mergeable",
          `submitClassic rejected: ${describeSubmitError(err)}`,
          {
            cause: err,
          },
        );
      }
      const status = statusOf(err);
      const data = dataOf(err);
      const codes = data?.extras?.result_codes as ResultCodes | undefined;
      if (codes) throw new SubmitRejectedError(codes, status);
      const detail = describeHttpError(err);
      // any other 4xx except a rate limit is a definite refusal
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw new Error(`submitClassic rejected: ${detail}`);
      }
      // 429, 5xx (504 means horizon stopped waiting, not that the tx failed), a
      // client timeout or a dropped connection: the tx may still land
      return reconcile(hash, maxTime, detail);
    }
    if (typeof res.hash !== "string" || res.hash.length === 0) {
      throw new Error("submitClassic: Horizon accepted the transaction but returned no hash");
    }
    return { txHash: res.hash, ledger: res.ledger ?? 0 };
  };
}

// a soroban submission refused by the rpc or reverted on chain
export class SorobanSubmitError extends Error {
  constructor(
    readonly resultCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = "SorobanSubmitError";
  }
}

export type SorobanSubmitRpc = Pick<RpcNS.Server, "sendTransaction" | "pollTransaction">;

export function createSorobanSubmitter(
  rpc: SorobanSubmitRpc,
  passphrase: string,
  timing: SubmitTiming = {},
): (signedXdr: string) => Promise<ConfirmationReceipt> {
  const sleep = timing.sleep ?? realSleep;
  return async (signedXdr) => {
    const signed = TransactionBuilder.fromXdr(signedXdr, passphrase) as Transaction;
    const hash = txHashHex(signed);
    const maxTime = txMaxTime(signed);
    let sentHash: string;
    try {
      sentHash = await sendSoroban(rpc, signed, sleep);
    } catch (err) {
      if (err instanceof SorobanNotQueuedError) {
        if (err.status === "TRY_AGAIN_LATER") {
          throw new CloseFailure(
            "network",
            `The Soroban RPC kept asking to try transaction ${err.hash} later; nothing landed.`,
          );
        }
        const code = err.resultCode;
        const diags =
          err.diagnostics.length > 0 ? `; diagnostics ${err.diagnostics.join(" ")}` : "";
        throw new SorobanSubmitError(
          code,
          `submitSoroban: sendTransaction returned ERROR${code ? `; result ${code}` : ""}${diags}`,
        );
      }
      // a json-rpc error answer is the rpc refusing the request, which is
      // definite. a send that drops in transit may still have reached the rpc,
      // so the hash is kept for the retry to look up.
      if (isJsonRpcError(err)) {
        throw new SorobanSubmitError(
          null,
          `submitSoroban: sendTransaction refused: ${errorMessage(err)}`,
        );
      }
      throw new AmbiguousSubmitError(hash, maxTime, `sendTransaction failed: ${errorMessage(err)}`);
    }
    // bounded poll (~60s); a NOT_FOUND after it means still pending, not failed
    let result: SorobanPollOutcome;
    try {
      result = await pollSoroban(rpc, sentHash);
    } catch (err) {
      throw new AmbiguousSubmitError(sentHash, maxTime, `polling failed: ${errorMessage(err)}`);
    }
    if (result.status === "FAILED") {
      throw new SorobanSubmitError(
        null,
        `submitSoroban: transaction ${sentHash} failed on-chain${result.reason ? `: ${result.reason}` : ""}`,
      );
    }
    if (result.status !== "SUCCESS") {
      throw new AmbiguousSubmitError(sentHash, maxTime, "still pending after polling");
    }
    return { txHash: sentHash, ledger: result.ledger };
  };
}

// the sdk's json-rpc client rejects with the response's plain { code, message }
// error object when the server answered with an error
function isJsonRpcError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    !(err instanceof Error) &&
    typeof (err as { code?: unknown }).code === "number"
  );
}

// horizon's call builders reject a 404 with NotFoundError, whose `response` is
// the problem json; other paths keep the http response
export function isNotFoundError(err: unknown): boolean {
  return err instanceof NotFoundError || statusOf(err) === 404;
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof s === "number" ? s : undefined;
}

function dataOf(
  err: unknown,
): { title?: string; detail?: string; extras?: { result_codes?: unknown } } | undefined {
  return (err as { response?: { data?: never } } | null)?.response?.data;
}

function describeHttpError(err: unknown): string {
  const status = statusOf(err);
  const data = dataOf(err);
  const parts = [
    status !== undefined ? `HTTP ${status}` : null,
    typeof data?.title === "string" ? data.title : null,
    typeof data?.detail === "string" ? data.detail : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) parts.push(errorMessage(err));
  return parts.join(": ");
}

async function latestCloseTime(horizon: ClassicSubmitHorizon): Promise<number | null> {
  try {
    const page = await horizon.ledgers().order("desc").limit(1).call();
    const closed = page.records[0]?.closed_at;
    if (typeof closed !== "string") return null;
    return Math.floor(Date.parse(closed) / 1000);
  } catch {
    // horizon unreachable: the caller keeps polling until its cap
    return null;
  }
}

// "txFailed" -> "tx_failed", to match horizon's result-code spelling
function resultCodeOf(resultXdr: string): string {
  try {
    const type = xdr.TransactionResult.fromXdr(resultXdr, "base64").result.type;
    return type.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  } catch {
    return "tx_failed";
  }
}
