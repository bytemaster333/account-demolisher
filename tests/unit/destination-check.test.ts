import { describe, it, expect, vi, beforeEach } from "vitest";
import { NetworkError, NotFoundError } from "@stellar/stellar-sdk";

// horizon is faked at the network boundary; the classification is the real code
const loadAccount = vi.fn();
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({ loadAccount }),
}));

import { checkDestination } from "@/lib/stellar/destination";
import { TESTNET } from "@/lib/config/networks";

const DEST = "GCZLCMUM4Q4H324CTT3753P6656CYR4KPLHYFPGYPGE6JVHONGLNRDI5";

describe("checkDestination", () => {
  beforeEach(() => {
    loadAccount.mockReset();
  });

  it("reports an existing destination and its SEP-29 flag", async () => {
    loadAccount.mockResolvedValue({ data_attr: { "config.memo_required": "MQ==" } });
    expect(await checkDestination(DEST, TESTNET)).toEqual({
      state: "exists",
      sep29MemoRequired: true,
    });
  });

  it("reports an existing destination without the flag", async () => {
    loadAccount.mockResolvedValue({ data_attr: {} });
    expect(await checkDestination(DEST, TESTNET)).toEqual({
      state: "exists",
      sep29MemoRequired: false,
    });
  });

  it("reports a missing destination on a 404", async () => {
    loadAccount.mockImplementation(async () => {
      throw new NotFoundError("Not Found", { status: 404 });
    });
    expect(await checkDestination(DEST, TESTNET)).toEqual({ state: "missing" });
  });

  it("surfaces any other failure instead of guessing", async () => {
    loadAccount.mockImplementation(async () => {
      throw new NetworkError("Bad Gateway", { status: 502 });
    });
    await expect(checkDestination(DEST, TESTNET)).rejects.toThrow("Bad Gateway");
  });
});
