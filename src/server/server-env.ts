import "server-only";

import { z } from "zod";

// server-only env vars, validated when first read

// empty-string values from .env are defined but unset in practice. coerce
// them to undefined so .optional() schemas don't trip the constraint checks
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const MediatorSecretSchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .startsWith("S", { message: "MEDIATOR_SECRET must be a Stellar seed" })
    .length(56, { message: "MEDIATOR_SECRET must be 56 characters" })
    .optional(),
);

// zod messages name the failing field and rule but never include the value, so
// they are safe to log
function invalid(name: string, error: z.ZodError): Error {
  return new Error(`Invalid server environment configuration for ${name}: ${error.message}`);
}

let mediatorSecret: { readonly value: string | undefined } | null = null;

// the mediator master seed, or undefined when unset. throws when it is set but
// malformed.
export function getMediatorSecret(): string | undefined {
  if (mediatorSecret !== null) return mediatorSecret.value;
  const parsed = MediatorSecretSchema.safeParse(process.env.MEDIATOR_SECRET);
  if (!parsed.success) throw invalid("MEDIATOR_SECRET", parsed.error);
  mediatorSecret = { value: parsed.data };
  return parsed.data;
}

// test-only: forget cached values so a test can change the environment
export function __resetServerEnvForTests(): void {
  mediatorSecret = null;
}
