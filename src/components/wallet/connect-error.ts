// turns a wallet-kit connect rejection into what the user should see. the kit
// rejects with plain { code, message } objects and uses code -1 for almost
// everything (its parseError default), so only the picker-close message itself
// means "the user cancelled".

import { errorMessage } from "@/lib/errors";

// sdk/kit.js authModal: reject({ code: -1, message: "The user closed the modal." })
const PICKER_CLOSED = "The user closed the modal.";

const HINT = "Make sure the wallet is installed and unlocked, then try again.";

// null means the user closed the picker and nothing should be shown
export function describeConnectError(e: unknown): string | null {
  const detail = errorMessage(e, "");
  if (detail === PICKER_CLOSED) return null;
  return detail.length > 0
    ? `Couldn't connect to your wallet: ${detail} ${HINT}`
    : `Couldn't connect to your wallet. ${HINT}`;
}
