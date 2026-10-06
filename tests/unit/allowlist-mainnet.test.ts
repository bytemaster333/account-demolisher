import { describe, it, expect } from "vitest";
import {
  Account,
  BASE_FEE,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

import {
  assertTransactionAllowed,
  getViolations,
  AllowlistViolation,
} from "@/lib/stellar/allowlist";
import {
  MAINNET_ALLOWLIST,
  TESTNET_ALLOWLIST,
  getAllowlistForNetwork,
  isAllowedContract,
} from "@/lib/config/contracts";
import { MAINNET, TESTNET, resolveNetwork } from "@/lib/config/networks";

// Source-level tests for the FINALIZED MAINNET contract-address allow-list:
// (1) the sign-time gate rejects a non-allow-listed contract on mainnet, and
// (2) the mainnet allow-list itself is complete, well-formed, and every entry
// cites a real upstream source (no dangling internal references).

const SOURCE = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const MAINNET_ROUTER = MAINNET_ALLOWLIST.find(
  (c) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
)!.id;
const NOT_ALLOWED = StrKey.encodeContract(Buffer.alloc(32, 7));

function mainnetTx(op: xdr.Operation) {
  return new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: BASE_FEE,
    networkPassphrase: MAINNET.passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
}

describe("mainnet allow-list: sign-time enforcement", () => {
  it("passes an invocation of an allow-listed MAINNET contract", () => {
    const t = mainnetTx(new Contract(MAINNET_ROUTER).call("swap"));
    expect(getViolations(t, MAINNET)).toEqual([]);
  });

  it("BLOCKS an invocation of a non-allow-listed contract on mainnet", () => {
    const t = mainnetTx(new Contract(NOT_ALLOWED).call("transfer"));
    expect(() => assertTransactionAllowed(t, MAINNET)).toThrow(AllowlistViolation);
    const v = getViolations(t, MAINNET);
    expect(v).toHaveLength(1);
    expect(v[0]!.contractId).toBe(NOT_ALLOWED);
    expect(v[0]!.reason).toMatch(/MAINNET_ALLOWLIST/);
  });

  it("BLOCKS contract-creation and wasm-upload host functions on mainnet", () => {
    expect(() =>
      assertTransactionAllowed(
        mainnetTx(Operation.uploadContractWasm({ wasm: Buffer.from([1]) })),
        MAINNET,
      ),
    ).toThrow(/WASM-upload/);
  });
});

describe("mainnet allow-list: completeness and provenance", () => {
  it("covers all four DeFi protocols", () => {
    const protocols = new Set(MAINNET_ALLOWLIST.map((c) => c.protocol));
    for (const p of ["blend", "aquarius", "soroswap", "fxdao"]) {
      expect(protocols.has(p), `missing mainnet protocol: ${p}`).toBe(true);
    }
  });

  it("every entry is a valid, uniquely-listed contract id", () => {
    const ids = MAINNET_ALLOWLIST.map((c) => c.id);
    for (const id of ids)
      expect(StrKey.isValidContract(id), `invalid contract id: ${id}`).toBe(true);
    expect(new Set(ids).size, "duplicate ids in mainnet allow-list").toBe(ids.length);
  });

  it("every entry cites a real upstream source (no dangling internal doc)", () => {
    for (const c of MAINNET_ALLOWLIST) {
      expect(c.name.length, `empty name for ${c.id}`).toBeGreaterThan(0);
      expect(c.source.length, `empty source for ${c.name}`).toBeGreaterThan(0);
      // the source must not point at the removed internal research note
      expect(c.source, `${c.name} cites a non-upstream internal doc`).not.toMatch(
        /research-tech-research/i,
      );
      // and must reference an actual upstream (a domain / known protocol origin)
      expect(c.source, `${c.name} source is not an upstream reference`).toMatch(
        /github\.com|aqua\.network|fxdao\.io|soroswap|stellar\.expert/i,
      );
      expect(c.verified_at, `${c.name} verified_at not a date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("allow-list: network isolation", () => {
  it("a mainnet id is allowed on mainnet and rejected on testnet", () => {
    expect(isAllowedContract(MAINNET_ROUTER, MAINNET)).toBe(true);
    expect(isAllowedContract(MAINNET_ROUTER, TESTNET)).toBe(false);
  });

  it("a testnet id is allowed on testnet and rejected on mainnet", () => {
    const testnetId = TESTNET_ALLOWLIST[0]!.id;
    expect(isAllowedContract(testnetId, TESTNET)).toBe(true);
    expect(isAllowedContract(testnetId, MAINNET)).toBe(false);
  });

  it("futurenet has an empty allow-list and allows nothing", () => {
    const futurenet = resolveNetwork("futurenet");
    expect(getAllowlistForNetwork(futurenet)).toEqual([]);
    expect(isAllowedContract(MAINNET_ROUTER, futurenet)).toBe(false);
  });
});
