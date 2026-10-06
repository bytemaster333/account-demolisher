import { describe, it, expect } from "vitest";
import { explorerAccountUrl, explorerContractUrl, explorerTxUrl } from "@/lib/explorer";
import { MAINNET, TESTNET, type NetworkConfig } from "@/lib/config/networks";

const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("explorer urls", () => {
  it("uses stellar.expert's 'public' slug for mainnet", () => {
    expect(explorerAccountUrl(MAINNET, ACCOUNT)).toBe(
      `https://stellar.expert/explorer/public/account/${ACCOUNT}`,
    );
    expect(explorerTxUrl(MAINNET, "ab12")).toBe("https://stellar.expert/explorer/public/tx/ab12");
  });

  it("uses the testnet slug for testnet", () => {
    expect(explorerContractUrl(TESTNET, "CABC")).toBe(
      "https://stellar.expert/explorer/testnet/contract/CABC",
    );
  });

  // stellar.expert answers 'Unknown network name' for anything else, so a link
  // would point at an error page
  it("refuses a network stellar.expert does not serve", () => {
    const other = { ...TESTNET, id: "futurenet" } as unknown as NetworkConfig;
    expect(() => explorerTxUrl(other, "ab12")).toThrow(/no explorer/);
  });
});
