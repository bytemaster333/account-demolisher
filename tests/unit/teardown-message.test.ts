import { describe, expect, it } from "vitest";

import { teardownFailureDetail } from "@/components/wallet/teardown-message";

describe("teardownFailureDetail", () => {
  it("keeps a single failure's own reason", () => {
    expect(teardownFailureDetail(new Error("the extension refused to disconnect"))).toBe(
      "the extension refused to disconnect.",
    );
  });

  it("does not add a second full stop", () => {
    expect(teardownFailureDetail(new Error("End it in your wallet app."))).toBe(
      "End it in your wallet app.",
    );
  });

  // the AggregateError's own message names no wallet and no reason
  it("lists every reason inside an AggregateError instead of its summary", () => {
    const error = new AggregateError(
      [
        new Error("WalletConnect could not reach its relay. Check your connection and try again."),
        new AggregateError([new Error("Freighter: user rejected")], "nested"),
      ],
      "the wallet could not be disconnected",
    );
    expect(teardownFailureDetail(error)).toBe(
      "WalletConnect could not reach its relay. Check your connection and try again. Freighter: user rejected.",
    );
  });

  it("says each reason once", () => {
    const error = new AggregateError([new Error("relay down"), new Error("relay down")], "x");
    expect(teardownFailureDetail(error)).toBe("relay down.");
  });

  it("still says something for a failure without a message", () => {
    expect(teardownFailureDetail(undefined)).toBe("The wallet gave no reason.");
    expect(
      teardownFailureDetail(new AggregateError([], "the wallet could not be disconnected")),
    ).toBe("the wallet could not be disconnected.");
  });
});
