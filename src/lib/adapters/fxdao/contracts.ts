/**
 * frozen snapshot of fxdao's mainnet soroban deployments.
 * source: fxdao.io/docs/addresses/ (verified 2026-05-15)
 *
 * fxdao ships a single VaultsContract that holds vaults for every supported denomination
 * (USD → USDx, EUR → EURx, GBP → GBPx). denomination is stored as a Symbol on the on-chain
 * Vault record — there is NOT a separate vault contract per stablecoin.
 *
 * the synthetic stablecoins (USDx/EURx/GBPx/FXG) are stellar asset contracts (SACs) — classical
 * stellar assets issued by GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN exposed as
 * SAC tokens. their IDs are pinned so vault pay_debt/redeem inner-invocations pass the allow-list.
 *
 * if upstream rotates any of these addresses, re-verify and update explicitly. do NOT mutate.
 */

/**
 * one entry in the fxdao mainnet contract registry.
 * kind discriminates the role; allow-list filters by kind === "vaults".
 */
export interface FxDAOContractEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: "vaults" | "synthetic_sac" | "governance_sac" | "oracle" | "locking_pool";
  readonly verified_at: string;
  readonly source: string;
}

const FXDAO_SOURCE = "fxdao.io/docs/addresses/";
const VERIFIED_AT = "2026-05-15";

// mainnet contract IDs snapshotted from fxdao.io/docs/addresses/
export const FXDAO_MAINNET_CONTRACTS: readonly FxDAOContractEntry[] = Object.freeze([
  Object.freeze({
    id: "CCUN4RXU5VNDHSF4S4RKV4ZJYMX2YWKOH6L4AKEKVNVDQ7HY5QIAO4UB",
    name: "VaultsContract",
    kind: "vaults",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CDIKURWHYS4FFTR5KOQK6MBFZA2K3E26WGBQI6PXBYWZ4XIOPJHDFJKP",
    name: "USDx (SAC)",
    kind: "synthetic_sac",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CBN3NCJSMOQTC6SPEYK3A44NU4VS3IPKTARJLI3Y77OH27EWBY36TP7U",
    name: "EURx (SAC)",
    kind: "synthetic_sac",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CBCO65UOWXY2GR66GOCMCN6IU3Y45TXCPBY3FLUNL4AOUMOCKVIVV6JC",
    name: "GBPx (SAC)",
    kind: "synthetic_sac",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CDBR4FMYL5WPUDBIXTBEBU2AFEYTDLXVOTRZHXS3JC575C7ZQRKYZQ55",
    name: "FXG (SAC)",
    kind: "governance_sac",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CDCART6WRSM2K4CKOAOB5YKUVBSJ6KLOVS7ZEJHA4OAQ2FXX7JOHLXIP",
    name: "LockingPool",
    kind: "locking_pool",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CB5OTV4GV24T5USEZHFVYGC3F4A4MPUQ3LN56E76UK2IT7MJ6QXW4TFS",
    name: "Oracle",
    kind: "oracle",
    verified_at: VERIFIED_AT,
    source: FXDAO_SOURCE,
  } satisfies FxDAOContractEntry),
]);

// mainnet stable-asset issuer (classical stellar account). classical trustlines for USDx/EURx/GBPx target this.
export const FXDAO_MAINNET_STABLE_ISSUER =
  "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN" as const;

/**
 * canonical soroban Symbol denominations recognised by the on-chain VaultsContract.
 * user-facing asset codes are USDx/EURx/GBPx — i.e. the symbol with an x suffix.
 */
export const FXDAO_KNOWN_DENOMINATIONS: readonly string[] = Object.freeze(["USD", "EUR", "GBP"]);

// resolve the single mainnet VaultsContract id
export function getFxDAOVaultsContractId(): string {
  const entry = FXDAO_MAINNET_CONTRACTS.find((c) => c.kind === "vaults");
  if (!entry) {
    throw new Error(
      "FxDAO VaultsContract not in FXDAO_MAINNET_CONTRACTS — upstream addresses unverified",
    );
  }
  return entry.id;
}

// resolve the SAC contract id for a synthetic stablecoin. denomination is the on-chain symbol.
export function getFxDAOSyntheticSacId(denomination: string): string {
  const code = `${denomination}x (SAC)`;
  const entry = FXDAO_MAINNET_CONTRACTS.find((c) => c.kind === "synthetic_sac" && c.name === code);
  if (!entry) {
    throw new Error(`FxDAO synthetic SAC not registered for denomination=${denomination}`);
  }
  return entry.id;
}
