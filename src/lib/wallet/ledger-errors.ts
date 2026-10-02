// maps the Stellar Ledger app's refusals to messages a user can act on.
//
// @ledgerhq/hw-app-str turns the device status words into errors named after them
// (createCustomErrorClass sets error.name) and keeps the raw transport error,
// with its statusCode, as error.cause. both are checked so the mapping holds
// whichever shape reaches us.

const SW_DENY = 0x6985;
const SW_HASH_SIGNING_MODE_NOT_ENABLED = 0x6c66;
const SW_DATA_TOO_LARGE = 0xb004;
const SW_DATA_PARSING_FAIL = 0xb005;

export type LedgerRefusal = "rejected" | "hash-signing-disabled" | "too-large" | "unparseable";

export class LedgerSigningError extends Error {
  readonly refusal: LedgerRefusal;

  constructor(refusal: LedgerRefusal, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LedgerSigningError";
    this.refusal = refusal;
  }
}

const BY_NAME: Record<string, LedgerRefusal> = {
  StellarUserRefusedError: "rejected",
  StellarHashSigningNotEnabledError: "hash-signing-disabled",
  StellarDataTooLargeError: "too-large",
  StellarDataParsingFailedError: "unparseable",
};

const BY_STATUS: Record<number, LedgerRefusal> = {
  [SW_DENY]: "rejected",
  [SW_HASH_SIGNING_MODE_NOT_ENABLED]: "hash-signing-disabled",
  [SW_DATA_TOO_LARGE]: "too-large",
  [SW_DATA_PARSING_FAIL]: "unparseable",
};

const MESSAGES: Record<LedgerRefusal, string> = {
  rejected: "You rejected the transaction on your Ledger.",
  "hash-signing-disabled":
    "Your Ledger was asked to sign a bare hash, which its Stellar app refuses by default. " +
    "Account Demolisher only asks the device to show and sign the full transaction; update the " +
    "Stellar app on your Ledger and try again.",
  "too-large":
    "This transaction is too large for your Ledger to show on screen, so it cannot be signed " +
    "there. Close this account with another wallet.",
  unparseable:
    "The Stellar app on your Ledger could not read this transaction. Update the Stellar app on " +
    "the device, or close this account with another wallet.",
};

function statusOf(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

// returns a LedgerSigningError for a known device refusal, null for anything else
// (which the caller rethrows unchanged)
export function toLedgerSigningError(e: unknown): LedgerSigningError | null {
  if (typeof e !== "object" || e === null) return null;
  const name = (e as { name?: unknown }).name;
  const refusal =
    (typeof name === "string" ? BY_NAME[name] : undefined) ??
    BY_STATUS[statusOf(e) ?? -1] ??
    BY_STATUS[statusOf((e as { cause?: unknown }).cause) ?? -1];
  if (refusal === undefined) return null;
  return new LedgerSigningError(refusal, MESSAGES[refusal], { cause: e });
}
