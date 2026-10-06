// fxdao's former soroban deployments. fxdao is no longer supported: on mainnet
// the vaults contract now runs an evict-only wasm (spec: evict, upgrade) with
// panic_mode set and zero vaults, and none of the testnet ids exist any more
// (read 2026-10-06). nothing here is discovered or called; the ids remain only
// because the allow-list and the auth guard still import them.

// one entry in the fxdao mainnet contract registry
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

// testnet contract IDs snapshotted from fxdao.io/docs/addresses/ (Testnet). Shared
// with the contract allow-list (config/contracts.ts) so the ids live in one place.
const FXDAO_TESTNET_SOURCE = "fxdao.io/docs/addresses/ (Testnet)";
const FXDAO_TESTNET_VERIFIED_AT = "2026-05-18";

export const FXDAO_TESTNET_CONTRACTS: readonly FxDAOContractEntry[] = Object.freeze([
  Object.freeze({
    id: "CBUZ5NJKA5PRS4TBPHWMN4JGGRVIOQOKI4JUYLA2IXS3BEJKQKEWFW7D",
    name: "VaultsContract",
    kind: "vaults",
    verified_at: FXDAO_TESTNET_VERIFIED_AT,
    source: FXDAO_TESTNET_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CB4WLX4IP2MWAT2ITRRO7I5YM743NILBBOWMUIVWYSLWWASZVRGB5YD3",
    name: "FXG (SAC)",
    kind: "governance_sac",
    verified_at: FXDAO_TESTNET_VERIFIED_AT,
    source: FXDAO_TESTNET_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CA2QJKOZF6WE3C45FCYDWB45337BKENLUU4EREWWXRIMHKWJSH6EEWVO",
    name: "USDx (SAC)",
    kind: "synthetic_sac",
    verified_at: FXDAO_TESTNET_VERIFIED_AT,
    source: FXDAO_TESTNET_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CBA2S6NROG4PN36FSFZTWGD4JVQDCUYBMCW2H4J64JCGH7ZSQYTAIZ54",
    name: "EURx (SAC)",
    kind: "synthetic_sac",
    verified_at: FXDAO_TESTNET_VERIFIED_AT,
    source: FXDAO_TESTNET_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CDYP7LY3OIKHFVDID3CO6MQJ45T37N2G63NYXN33OQJPLW3X2PYRFHVT",
    name: "GBPx (SAC)",
    kind: "synthetic_sac",
    verified_at: FXDAO_TESTNET_VERIFIED_AT,
    source: FXDAO_TESTNET_SOURCE,
  } satisfies FxDAOContractEntry),
  Object.freeze({
    id: "CCHXQJ5YDCIRGCBUTLC5BF2V2DKHULVPTQJGD4BAHW46JQWVRQNGA2LU",
    name: "Oracle",
    kind: "oracle",
    verified_at: FXDAO_TESTNET_VERIFIED_AT,
    source: FXDAO_TESTNET_SOURCE,
  } satisfies FxDAOContractEntry),
]);
