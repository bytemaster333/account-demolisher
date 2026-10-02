// configure-step form schema and the memo it produces

import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import type { ClassicMemo } from "@/lib/types/plan";

export const G_ADDRESS = z
  .string()
  .min(1, { message: "Destination address is required." })
  .refine((v) => StrKey.isValidEd25519PublicKey(v), {
    message: "Not a valid Stellar G... address.",
  });

export const MEMO_TYPE = z.enum(["none", "text", "id", "hash", "return"]);

export const FORM_SCHEMA = z.object({
  destination: G_ADDRESS,
  memoType: MEMO_TYPE,
  memoValue: z.string(),
  fallback: z.string(),
  selectedCbIds: z.array(z.string()),
  // pathKey()s of un-routable credit assets the user consented to return to
  // their issuer so the account can close
  returnToIssuer: z.array(z.string()),
  sendToDestination: z.array(z.string()),
});

export type FormState = z.infer<typeof FORM_SCHEMA>;

export const INITIAL_FORM: FormState = {
  destination: "",
  memoType: "none",
  memoValue: "",
  fallback: "",
  selectedCbIds: [],
  returnToIssuer: [],
  sendToDestination: [],
};

export function parseMemo(form: FormState): ClassicMemo | undefined {
  if (form.memoType === "none") return undefined;
  const value = form.memoValue.trim();
  if (value.length === 0) return undefined;
  return { type: form.memoType, value } as ClassicMemo;
}
