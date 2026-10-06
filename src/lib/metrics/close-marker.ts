// on-chain marker that identifies a close made with this app. the final classic
// transaction (the one with the account merge) sets this data entry and deletes
// it again right before the merge, so the account ends with no extra subentry
// and the pair shows up in the transaction's operations on any explorer.
//
// close verification only counts a merge whose transaction carries this exact
// set + delete pair from the closing account. anyone can copy the marker into
// their own merge, so the dashboard counts "merges that carried the marker",
// nothing stronger.

import { Operation, type xdr } from "@stellar/stellar-sdk";

export const CLOSE_MARKER_NAME = "account-demolisher.close";
export const CLOSE_MARKER_VALUE = "1";

// the two operations to place immediately before the account merge. setting the
// entry needs one base reserve (0.5 XLM) free at that point, which the caller
// must check against the account's native balance at that stage of the batch.
export function closeMarkerOperations(source?: string): readonly [xdr.Operation, xdr.Operation] {
  return [
    Operation.manageData({
      name: CLOSE_MARKER_NAME,
      value: CLOSE_MARKER_VALUE,
      ...(source ? { source } : {}),
    }),
    Operation.manageData({
      name: CLOSE_MARKER_NAME,
      value: null,
      ...(source ? { source } : {}),
    }),
  ];
}
