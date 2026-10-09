"use client";

import { Notice } from "@/components/ui";

// a shared account's close is one bundled classic transaction, so it can't move
// standalone tokens (each needs its own transaction); say so instead of offering
// a sweep the signing request would drop
export function SharedTokensNotice({
  count,
  scanFailed,
}: {
  readonly count: number;
  readonly scanFailed: boolean;
}): React.JSX.Element {
  return (
    <Notice tone="warning" title="Standalone tokens stay on this account" role="status">
      {count > 0
        ? `This account holds ${count} standalone token${count === 1 ? "" : "s"} (custom SEP-41 tokens). `
        : "The scan for standalone tokens couldn't finish, so some may not be listed. "}
      A signing request closes the account in one transaction, which can&apos;t move them. Move them
      out with all signers first, or they stay on the deleted account.
      {scanFailed && count > 0 ? " The scan didn't finish, so there may be more." : ""}
    </Notice>
  );
}
