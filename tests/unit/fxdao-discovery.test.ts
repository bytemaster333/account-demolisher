import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

import { getUserVaults } from "@/lib/adapters/fxdao/client";
import {
  getFxDAOVaultsContractId,
  getFxDAOVaultsContractIdForNetwork,
} from "@/lib/adapters/fxdao/contracts";
import { MAINNET, TESTNET } from "@/lib/config/networks";
import type { NetworkConfig } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// getUserVaults probes get_vault per denomination via the injected simulate; we
// drive its result to exercise SEC-06's fail-closed behaviour.
function deps(simResult: unknown) {
  return {
    server: {} as never,
    simulate: (async () => simResult) as never,
    denominations: ["USD"],
  };
}

describe("getUserVaults — fail-closed discovery (SEC-06)", () => {
  it("treats a host error (sim.ok=false) as a genuine no-vault absence", async () => {
    // FxDAO's get_vault panics when the caller holds no vault, so this is expected
    const vaults = await getUserVaults(
      USER,
      TESTNET,
      deps({ ok: false, error: "vault not found" }),
    );
    expect(vaults).toEqual([]);
  });

  it("THROWS on an undecodable get_vault result (ABI drift) instead of silently skipping", async () => {
    // simulation succeeded but returned a scalar, not a vault struct
    const retval = xdr.ScVal.scvU32(7);
    await expect(getUserVaults(USER, TESTNET, deps({ ok: true, retval }))).rejects.toThrow(
      /undecodable/,
    );
  });

  it("THROWS when a successful simulation returns no value", async () => {
    await expect(getUserVaults(USER, TESTNET, deps({ ok: true, retval: null }))).rejects.toThrow(
      /cannot confirm/,
    );
  });
});

// Previously getUserVaults hardcoded the MAINNET VaultsContract id, so on testnet
// every get_vault simulated against a contract that doesn't exist there and read
// as "no vault" — FxDAO was completely undiscoverable on the milestone's network.
describe("getFxDAOVaultsContractIdForNetwork — network-aware resolution", () => {
  it("resolves the mainnet VaultsContract (matching the legacy mainnet getter)", () => {
    expect(getFxDAOVaultsContractIdForNetwork(MAINNET)).toBe(getFxDAOVaultsContractId());
  });

  it("resolves the DISTINCT testnet VaultsContract (previously unreachable)", () => {
    const testnetId = getFxDAOVaultsContractIdForNetwork(TESTNET);
    expect(testnetId).toBe("CBUZ5NJKA5PRS4TBPHWMN4JGGRVIOQOKI4JUYLA2IXS3BEJKQKEWFW7D");
    // and it must NOT be the mainnet id (the exact bug that hid testnet vaults)
    expect(testnetId).not.toBe(getFxDAOVaultsContractId());
  });

  it("returns null where FxDAO has no published deployment (futurenet)", () => {
    expect(
      getFxDAOVaultsContractIdForNetwork({ id: "futurenet" } as unknown as NetworkConfig),
    ).toBeNull();
  });

  it("getUserVaults returns [] (without simulating) on a network with no FxDAO", async () => {
    let simulated = false;
    const vaults = await getUserVaults(USER, { id: "futurenet" } as unknown as NetworkConfig, {
      server: {} as never,
      simulate: (async () => {
        simulated = true;
        return { ok: true, retval: null };
      }) as never,
      denominations: ["USD"],
    });
    expect(vaults).toEqual([]);
    expect(simulated).toBe(false);
  });
});
