import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

import { getUserVaults } from "@/lib/adapters/fxdao/client";
import { TESTNET } from "@/lib/config/networks";

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
