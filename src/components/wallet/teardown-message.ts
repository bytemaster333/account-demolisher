// what to tell the user when a wallet could not be let go of. the kit and
// disconnectSession throw an AggregateError when more than one close failed,
// and its own message names neither the wallet nor the reason, so the reasons
// inside it are listed instead.

import { errorMessage } from "@/lib/errors";

export function teardownFailureDetail(error: unknown): string {
  const reasons = [...new Set(reasonsOf(error))];
  return reasons.map((r) => (/[.!?]$/u.test(r) ? r : `${r}.`)).join(" ");
}

// the app has already let go of the wallet when this shows; only the wallet's
// own side (an extension grant, a walletconnect pairing) may be left
export function walletTeardownNotice(error: unknown): string {
  return `The wallet could not be fully disconnected: ${teardownFailureDetail(error)} If it still lists this site as connected, disconnect it in the wallet.`;
}

function reasonsOf(error: unknown): string[] {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.flatMap(reasonsOf);
  }
  return [errorMessage(error, "The wallet gave no reason")];
}
