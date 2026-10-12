import { describe, it, expect } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

import { MAINNET_ALLOWLIST, TESTNET_ALLOWLIST } from "@/lib/config/contracts";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import { lookupSpender } from "@/lib/soroban/spender-registry";

// the soroswap routers, spelled out here so the test does not lean on the list
// it checks
const MAINNET_SOROSWAP_ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const TESTNET_SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

describe("lookupSpender", () => {
  it("names a curated spender on the network it is curated for", () => {
    expect(lookupSpender(MAINNET_SOROSWAP_ROUTER, MAINNET)).toEqual({
      name: "SoroswapRouter",
      protocol: "soroswap",
    });
    expect(lookupSpender(TESTNET_SOROSWAP_ROUTER, TESTNET)).toEqual({
      name: "SoroswapRouter",
      protocol: "soroswap",
    });
  });

  it("does not carry a contract id over to the other network", () => {
    expect(lookupSpender(MAINNET_SOROSWAP_ROUTER, TESTNET)).toBeNull();
    expect(lookupSpender(TESTNET_SOROSWAP_ROUTER, MAINNET)).toBeNull();
  });

  it("returns null for a contract nobody curated", () => {
    const unknown = StrKey.encodeContract(Buffer.alloc(32, 9));
    expect(lookupSpender(unknown, MAINNET)).toBeNull();
    expect(lookupSpender(unknown, TESTNET)).toBeNull();
  });

  it("labels every allow-listed contract of each network", () => {
    for (const [list, network] of [
      [MAINNET_ALLOWLIST, MAINNET],
      [TESTNET_ALLOWLIST, TESTNET],
    ] as const) {
      expect(list.length).toBeGreaterThan(0);
      for (const c of list) {
        expect(lookupSpender(c.id, network)).toEqual({ name: c.name, protocol: c.protocol });
      }
    }
  });
});
