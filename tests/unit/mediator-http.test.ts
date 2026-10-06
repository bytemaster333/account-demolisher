import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logMediatorError } from "@/app/api/mediator/_shared/http";
import { PendingForwardStorageError } from "@/lib/mediator/pending-flow";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logMediatorError", () => {
  it("logs the message of a plain rejection object and redacts any seed in it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seed = Keypair.random().secret();
    logMediatorError("ctx", { code: 7, message: `rpc said no for ${seed}` });
    expect(error).toHaveBeenCalledWith("[mediator] ctx: rpc said no for [redacted seed]");
  });
});

describe("PendingForwardStorageError", () => {
  it("keeps the message of a plain rejection object", () => {
    const err = new PendingForwardStorageError("save", { name: "x", message: "quota exceeded" });
    expect(err.message).toBe(
      "Could not save the exchange-forward recovery record in browser storage: quota exceeded",
    );
  });
});
