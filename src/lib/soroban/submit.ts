// the one send and the one wait every soroban submission goes through: the
// close executor, the allowance revokes and the testnet demo seeder. each caller
// words its own errors, but what counts as queued, when the identical envelope
// is sent again and how a result is read live here, so a fix to one path reaches
// all of them.

import type { FeeBumpTransaction, Transaction, rpc } from "@stellar/stellar-sdk";

import { describeSorobanFailure } from "@/lib/soroban/diagnostics";

export type SorobanSendRpc = Pick<rpc.Server, "sendTransaction">;
export type SorobanPollRpc = Pick<rpc.Server, "pollTransaction">;

// the rpc's queue is full: the identical signed envelope can be sent again, at
// 1, 2, 4, 8 and 16 seconds
export const TRY_AGAIN_LATER_RESENDS = 5;

// about a minute at the sdk's one-second spacing
export const DEFAULT_POLL_ATTEMPTS = 60;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// the rpc answered but did not queue the transaction. only PENDING and DUPLICATE
// mean it took the envelope, so the hash of anything else must never be handed
// on as if it might land.
export class SorobanNotQueuedError extends Error {
  constructor(
    readonly status: "ERROR" | "TRY_AGAIN_LATER",
    readonly hash: string,
    // the transaction result code of an ERROR answer, when the rpc sent one
    readonly resultCode: string | null,
    // base64 diagnostic events of an ERROR answer
    readonly diagnostics: readonly string[],
  ) {
    super(
      status === "TRY_AGAIN_LATER"
        ? `the soroban rpc kept asking to try transaction ${hash} later`
        : `the soroban rpc refused transaction ${hash}${resultCode ? ` (${resultCode})` : ""}`,
    );
    this.name = "SorobanNotQueuedError";
  }
}

// sends the envelope and resolves with its hash once the rpc has queued it. an
// error thrown by the send request itself (a dropped connection, a json-rpc
// error answer) reaches the caller untouched, since only the caller knows
// whether it can look the hash up afterwards.
export async function sendSoroban(
  server: SorobanSendRpc,
  tx: Transaction | FeeBumpTransaction,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<string> {
  let send = await server.sendTransaction(tx);
  for (let i = 0; send.status === "TRY_AGAIN_LATER" && i < TRY_AGAIN_LATER_RESENDS; i++) {
    await sleep(1_000 * 2 ** i);
    send = await server.sendTransaction(tx);
  }
  if (send.status === "PENDING" || send.status === "DUPLICATE") return send.hash;
  if (send.status === "TRY_AGAIN_LATER") {
    throw new SorobanNotQueuedError("TRY_AGAIN_LATER", send.hash, null, []);
  }
  throw new SorobanNotQueuedError("ERROR", send.hash, resultCodeOf(send), diagnosticsOf(send));
}

export type SorobanPollOutcome =
  | { readonly status: "SUCCESS"; readonly ledger: number }
  // the decoded failure reason, empty when the rpc kept no diagnostic events
  | { readonly status: "FAILED"; readonly reason: string }
  // not seen within the window: still pending, not failed
  | { readonly status: "NOT_FOUND" };

// waits for a queued transaction's result. an error from the poll request
// itself reaches the caller untouched.
export async function pollSoroban(
  server: SorobanPollRpc,
  hash: string,
  attempts: number = DEFAULT_POLL_ATTEMPTS,
): Promise<SorobanPollOutcome> {
  const result = await server.pollTransaction(hash, { attempts });
  if (result.status === "SUCCESS") return { status: "SUCCESS", ledger: result.ledger };
  if (result.status === "FAILED") {
    return { status: "FAILED", reason: describeSorobanFailure(result.diagnosticEventsXdr) };
  }
  return { status: "NOT_FOUND" };
}

// the sdk parses both from the rpc's xdr when it reads the answer, so these are
// plain reads
function resultCodeOf(send: rpc.Api.SendTransactionResponse): string | null {
  return send.errorResult?.result.type ?? null;
}

function diagnosticsOf(send: rpc.Api.SendTransactionResponse): string[] {
  return send.diagnosticEvents?.map((e) => e.toXdr("base64")) ?? [];
}
