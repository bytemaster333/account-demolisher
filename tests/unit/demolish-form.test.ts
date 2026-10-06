import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { FORM_SCHEMA, INITIAL_FORM } from "@/app/demolish/_lib/form";

describe("configure form schema", () => {
  it("accepts a space-padded destination and returns it trimmed (L-53)", () => {
    const key = Keypair.random().publicKey();
    const parsed = FORM_SCHEMA.safeParse({ ...INITIAL_FORM, destination: `  ${key}\t ` });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.destination).toBe(key);
  });

  it("still rejects a value that is not a G address once trimmed", () => {
    const parsed = FORM_SCHEMA.safeParse({ ...INITIAL_FORM, destination: "  GNOPE  " });
    expect(parsed.success).toBe(false);
  });

  it("has no backup address field, since nothing could deliver to it (M-08)", () => {
    expect(Object.keys(INITIAL_FORM)).not.toContain("fallback");
    expect(Object.keys(FORM_SCHEMA.shape)).not.toContain("fallback");
  });
});
