import { describe, it, expect } from "vitest";
import { Account, Asset, BASE_FEE, Contract, TransactionBuilder } from "@stellar/stellar-sdk";

import { getViolations } from "@/lib/stellar/allowlist";
import {
  MAINNET_ALLOWLIST,
  TESTNET_ALLOWLIST,
  isAllowedRootTarget,
  isKnownContract,
} from "@/lib/config/contracts";
import {
  MAINNET_CONCENTRATED_POOLS,
  TESTNET_CONCENTRATED_POOLS,
} from "@/lib/adapters/aquarius/concentrated-pools";
import { MAINNET, TESTNET } from "@/lib/config/networks";

const SOURCE = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const XLM_SAC_MAINNET = Asset.native().contractId(MAINNET.passphrase);

function mainnetCall(contractId: string, fn: string) {
  return new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: BASE_FEE,
    networkPassphrase: MAINNET.passphrase,
  })
    .addOperation(new Contract(contractId).call(fn))
    .setTimeout(60)
    .build();
}

function idOf(name: string): string {
  const entry = MAINNET_ALLOWLIST.find((c) => c.name === name);
  if (!entry) throw new Error(`no mainnet allow-list entry named ${name}`);
  return entry.id;
}

describe("allow-list roles: only entry points may be a signed root call", () => {
  it("rejects a root call on a curated token SAC (XLM_SAC.transfer)", () => {
    expect(isKnownContract(XLM_SAC_MAINNET, MAINNET)).toBe(true);
    const v = getViolations(mainnetCall(XLM_SAC_MAINNET, "transfer"), MAINNET);
    expect(v).toHaveLength(1);
    expect(v[0]!.contractId).toBe(XLM_SAC_MAINNET);
  });

  it("rejects a root call on infrastructure (soroswap factory, blend emitter)", () => {
    for (const name of ["SoroswapFactory", "Blend::emitter", "Blend::poolFactoryV2"]) {
      const id = idOf(name);
      expect(isKnownContract(id, MAINNET), name).toBe(true);
      expect(getViolations(mainnetCall(id, "anything"), MAINNET), name).toHaveLength(1);
    }
  });

  it("accepts the entry points the adapters invoke", () => {
    for (const name of [
      "BlendPool::FixedV2",
      "Blend::backstopV2",
      "SoroswapRouter",
      "AquariusAmmRouter",
      "FxDAO::VaultsContract",
    ]) {
      expect(getViolations(mainnetCall(idOf(name), "submit"), MAINNET), name).toEqual([]);
    }
  });

  it("every protocol keeps at least one entry point on both networks", () => {
    for (const list of [MAINNET_ALLOWLIST, TESTNET_ALLOWLIST]) {
      const protocols = new Set(list.filter((c) => c.role === "entrypoint").map((c) => c.protocol));
      for (const p of ["blend", "aquarius", "soroswap", "fxdao"])
        expect(protocols.has(p), p).toBe(true);
    }
  });

  it("lists every pinned aquarius concentrated pool as an entry point", () => {
    expect(MAINNET_CONCENTRATED_POOLS.length).toBeGreaterThan(0);
    for (const p of MAINNET_CONCENTRATED_POOLS)
      expect(isAllowedRootTarget(p.address, MAINNET)).toBe(true);
    for (const p of TESTNET_CONCENTRATED_POOLS)
      expect(isAllowedRootTarget(p.address, TESTNET)).toBe(true);
    // network isolation holds for them too
    expect(isAllowedRootTarget(TESTNET_CONCENTRATED_POOLS[0]!.address, MAINNET)).toBe(false);
  });
});
