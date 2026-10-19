// what the scans covered, in the words the close flow and the allowances page
// show. the partner wording is used only when the partner index answered the
// scan in question; otherwise the scan saw the rpc's ~7 days and says so.

import { EVENT_RETENTION_WINDOW_LEDGERS } from "@/lib/soroban/event-retention";

const RETENTION = `about the last 7 days (${EVENT_RETENTION_WINDOW_LEDGERS.toLocaleString("en-US")} ledgers)`;

// the review step, before anything is signed
export function allowanceReviewNote(partnerThroughLedger: number | null): string {
  return partnerThroughLedger !== null
    ? "Token spending permissions are found from every approve event in the account's history, " +
        "read from Lumeus, our history partner, and each one is checked on chain before it is revoked."
    : `Token spending permissions are found from the network's recent approve events, ${RETENTION}. ` +
        "A permission granted before that isn't seen, so it isn't revoked here.";
}

// the run result
export function allowanceRunNote(partnerThroughLedger: number | null): string {
  return partnerThroughLedger !== null
    ? "Token spending permissions were looked for in every approve event in the account's history, " +
        "read from Lumeus, our history partner."
    : `Token spending permissions were looked for in ${RETENTION} of approve events; an older one was not seen.`;
}

// the standalone-token card
export function heldTokenScanNote(partnerAsOfLedger: number | null): string {
  return partnerAsOfLedger !== null
    ? "This list comes from the tokens Lumeus, our history partner, shows this account holding, " +
        "plus the last 7 days of transfers, each checked on chain. If a token you hold is missing, " +
        "add it by contract address below."
    : "This scan only sees about the last 7 days of activity. If someone sent you a token before " +
        "that, it won't appear. Add it by contract address below.";
}
