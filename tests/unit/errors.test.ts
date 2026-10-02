import { describe, it, expect } from "vitest";
import { AccountRequiresMemoError, TransactionFailedError } from "@stellar/stellar-sdk";
import { describeSubmitError, errorMessage } from "@/lib/errors";

// The Soroban RPC client (`@stellar/stellar-sdk`) rejects with a plain
// `{ code, message }` object rather than an `Error`. A bare
// `err instanceof Error ? err.message : fallback` check therefore discarded the
// real RPC message and always showed the generic fallback (e.g. the allowance
// viewer's "Failed to load allowances."). errorMessage must recover the message
// from that plain-object shape.
describe("errorMessage", () => {
  it("returns an Error instance's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("recovers the message from a plain RPC-style { code, message } object", () => {
    const rpcRejection = {
      code: -32600,
      message: "startLedger must be within the ledger range: 3517481 - 3638440",
    };
    expect(errorMessage(rpcRejection)).toBe(
      "startLedger must be within the ledger range: 3517481 - 3638440",
    );
  });

  it("returns a bare string thrown value verbatim", () => {
    expect(errorMessage("plain string failure")).toBe("plain string failure");
  });

  it("uses the fallback when no message can be extracted", () => {
    expect(errorMessage({ code: 500 }, "Failed to load allowances.")).toBe(
      "Failed to load allowances.",
    );
    expect(errorMessage(null, "Revoke failed.")).toBe("Revoke failed.");
    expect(errorMessage(undefined, "Revoke failed.")).toBe("Revoke failed.");
  });

  it("prefers a real message over the fallback", () => {
    expect(errorMessage(new Error("real detail"), "generic")).toBe("real detail");
    expect(errorMessage({ message: "rpc detail" }, "generic")).toBe("rpc detail");
  });

  it("falls back to String(err) when no fallback is supplied and no message exists", () => {
    expect(errorMessage({ code: 500 })).toBe("[object Object]");
    expect(errorMessage(42)).toBe("42");
  });

  it("ignores an empty-string message and uses the fallback", () => {
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(errorMessage({ message: "" }, "fallback")).toBe("fallback");
  });

  it("ignores a non-string message field", () => {
    expect(errorMessage({ message: 123 }, "fallback")).toBe("fallback");
  });
});

// submitTransaction runs the SEP-29 check before posting; its error carries no
// horizon response, so reading only result_codes reduced it to "<no result_codes>"
describe("describeSubmitError", () => {
  const DEST = "GCZLCMUM4Q4H324CTT3753P6656CYR4KPLHYFPGYPGE6JVHONGLNRDI5";

  it("names the destination of a SEP-29 memo-required refusal", () => {
    const err = new AccountRequiresMemoError("account requires memo", DEST, 0);
    const text = describeSubmitError(err);
    expect(text).toContain(DEST);
    expect(text).toContain("memo");
  });

  it("reports horizon result codes for a failed transaction", () => {
    const err = new TransactionFailedError("Transaction submission failed.", {
      status: 400,
      statusText: "Bad Request",
      data: { extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_trust"] } } },
    });
    expect(describeSubmitError(err)).toBe(
      JSON.stringify({ transaction: "tx_failed", operations: ["op_no_trust"] }),
    );
  });

  it("falls back to the error message when there are no result codes", () => {
    expect(describeSubmitError(new Error("fetch failed"))).toBe("fetch failed");
  });
});
