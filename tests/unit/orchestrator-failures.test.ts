import { describe, expect, it } from "vitest";
import {
  BadResponseError,
  NetworkError,
  NotFoundError,
  TransactionFailedError,
} from "@stellar/stellar-sdk";

import { classifyFailure, isRetryableFailure } from "@/lib/orchestrator/failures";

// what the sdk's horizon call builders reject with: NetworkError(statusText, body).
// horizon's problem json carries the status; an http/2 reply has an empty
// status text, and a proxy's error page has no json at all.
function readError(statusText: string, body: unknown): NetworkError {
  return new NetworkError(statusText, body);
}

describe("raw horizon read errors", () => {
  it("treats a rate limit as transient", () => {
    const err = readError("Too Many Requests", { status: 429, title: "Rate Limit Exceeded" });
    expect(classifyFailure(err)).toBe("network");
    expect(isRetryableFailure(classifyFailure(err))).toBe(true);
  });

  it("treats a 5xx as transient, including an http/2 reply with no status text", () => {
    expect(classifyFailure(readError("Internal Server Error", { status: 500 }))).toBe("network");
    expect(classifyFailure(readError("", { status: 503, title: "Service Unavailable" }))).toBe(
      "network",
    );
  });

  it("treats an error page with no readable status as transient", () => {
    expect(classifyFailure(readError("", "<html>502 Bad Gateway</html>"))).toBe("network");
    expect(classifyFailure(readError("Unknown", undefined))).toBe("network");
  });

  it("does not call a 404 or another 4xx transient", () => {
    expect(classifyFailure(new NotFoundError("Not Found", { status: 404 }))).toBe("unknown");
    expect(classifyFailure(readError("Bad Request", { status: 400 }))).toBe("unknown");
  });

  it("reads the status a submit error wraps", () => {
    const gateway = new BadResponseError("Transaction submission failed.", {
      status: 504,
      statusText: "Gateway Timeout",
      data: {},
    });
    expect(classifyFailure(gateway)).toBe("network");
    const refused = new TransactionFailedError("Transaction submission failed.", {
      status: 400,
      statusText: "Bad Request",
      data: { extras: { result_codes: { transaction: "tx_bad_auth" } } },
    });
    expect(classifyFailure(refused)).not.toBe("network");
  });
});

describe("a refused conversion", () => {
  it("is not replayed: the plan is rebuilt so the user decides per token", () => {
    expect(isRetryableFailure("conversion_refused")).toBe(false);
  });
});
