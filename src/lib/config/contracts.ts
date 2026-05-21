// network-aware contract-id allow-list.
//
// every soroban tx the user signs must have every invoked contract pass
// the allow-list verifier in src/lib/stellar/allowlist.ts. each entry's
// verified_at is the iso date the contract id was verified against the
// upstream project's published deployment json or docs.

import { BLEND_MAINNET_INFRASTRUCTURE, BLEND_MAINNET_POOLS } from "@/lib/adapters/blend/pools";
import { BLEND_TESTNET_POOLS } from "@/lib/adapters/blend/pools";
import { FXDAO_MAINNET_CONTRACTS } from "@/lib/adapters/fxdao/contracts";
import type { NetworkConfig } from "@/lib/config/networks";

export interface AllowedContract {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly verified_at: string;
  readonly source: string;
}

// blend mainnet pool ids + infrastructure (factory, backstop, BLND/USDC
// sacs, comet lp). source: blend-utils mainnet.contracts.json snapshot
// in src/lib/adapters/blend/pools.ts.
const BLEND_ALLOWLIST_ENTRIES: readonly AllowedContract[] = [
  ...BLEND_MAINNET_POOLS.map(
    (pool): AllowedContract => ({
      id: pool.pool_id,
      name: `BlendPool::${pool.name}`,
      protocol: "blend",
      verified_at: pool.verified_at,
      source: pool.source,
    }),
  ),
  ...BLEND_MAINNET_INFRASTRUCTURE.map(
    (entry): AllowedContract => ({
      id: entry.id,
      name: `Blend::${entry.name}`,
      protocol: "blend",
      verified_at: entry.verified_at,
      source: entry.source,
    }),
  ),
];

// fxdao mainnet vault contract + synthetic-stablecoin sacs, mirrored from
// FXDAO_MAINNET_CONTRACTS so the universal verifier accepts pay_debt /
// redeem and the inner SAC calls the vault dispatches.
const FXDAO_ALLOWLIST_ENTRIES: readonly AllowedContract[] = FXDAO_MAINNET_CONTRACTS.map(
  (entry): AllowedContract => ({
    id: entry.id,
    name: `FxDAO::${entry.name}`,
    protocol: "fxdao",
    verified_at: entry.verified_at,
    source: entry.source,
  }),
);

export const MAINNET_ALLOWLIST: readonly AllowedContract[] = [
  // soroswap (github.com/soroswap/core)
  {
    id: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
    name: "SoroswapRouter",
    protocol: "soroswap",
    verified_at: "2026-05-15",
    source: "research-tech-research.md §5c",
  },
  {
    id: "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2",
    name: "SoroswapFactory",
    protocol: "soroswap",
    verified_at: "2026-05-15",
    source: "research-tech-research.md §5c",
  },
  // blend (github.com/blend-capital/blend-utils)
  ...BLEND_ALLOWLIST_ENTRIES,
  // aquarius (github.com/AquaToken/soroban-amm)
  {
    id: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    name: "AquariusAmmRouter",
    protocol: "aquarius",
    verified_at: "2026-05-15",
    source: "research-tech-research.md §5b",
  },
  // fxdao (www.fxdao.io/docs/addresses/)
  ...FXDAO_ALLOWLIST_ENTRIES,
];

// testnet allow-list — mirrors the four protocols on stellar testnet.

// blend testnet infrastructure — the eight non-pool testnet contracts.
// sourced from blend-utils@main/testnet.contracts.json (re-fetched 2026-05-18).
const BLEND_TESTNET_INFRASTRUCTURE_SOURCE =
  "github.com/blend-capital/blend-utils@main/testnet.contracts.json";
const BLEND_TESTNET_VERIFIED_AT = "2026-05-18";

export interface BlendTestnetInfrastructureEntry {
  readonly id: string;
  readonly name: string;
  readonly verified_at: string;
  readonly source: string;
}

export const BLEND_TESTNET_INFRASTRUCTURE: readonly BlendTestnetInfrastructureEntry[] =
  Object.freeze([
    Object.freeze({
      id: "CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6",
      name: "poolFactoryV2",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
      name: "backstopV2",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CC3WJVJINN4E3LPMNTWKK7LQZLYDQMZHZA7EZGXATPHHBPKNZRIO3KZ6",
      name: "emitter",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF",
      name: "BLND",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
      name: "USDC",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      name: "XLM (SAC)",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CDX2TKELFKHP2MWISDCXWWZ73CL7F57GHYRJAWJWNOTLNJNNM7XLT4JY",
      name: "cometFactory",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
    Object.freeze({
      id: "CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM",
      name: "comet (BLND/USDC LP)",
      verified_at: BLEND_TESTNET_VERIFIED_AT,
      source: BLEND_TESTNET_INFRASTRUCTURE_SOURCE,
    }),
  ]);

const TESTNET_BLEND_ENTRIES: readonly AllowedContract[] = [
  ...BLEND_TESTNET_POOLS.map(
    (pool): AllowedContract => ({
      id: pool.pool_id,
      name: `BlendPool::${pool.name}`,
      protocol: "blend",
      verified_at: pool.verified_at,
      source: pool.source,
    }),
  ),
  ...BLEND_TESTNET_INFRASTRUCTURE.map(
    (entry): AllowedContract => ({
      id: entry.id,
      name: `Blend::${entry.name}`,
      protocol: "blend",
      verified_at: entry.verified_at,
      source: entry.source,
    }),
  ),
];

// soroswap testnet contracts (factory + router; no aggregator on testnet).
// sourced from soroswap/core@main/public/testnet.contracts.json (re-fetched 2026-05-18).
const SOROSWAP_TESTNET_SOURCE = "github.com/soroswap/core@main/public/testnet.contracts.json";
const TESTNET_SOROSWAP_ENTRIES: readonly AllowedContract[] = [
  {
    id: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
    name: "SoroswapRouter",
    protocol: "soroswap",
    verified_at: "2026-05-18",
    source: SOROSWAP_TESTNET_SOURCE,
  },
  {
    id: "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY",
    name: "SoroswapFactory",
    protocol: "soroswap",
    verified_at: "2026-05-18",
    source: SOROSWAP_TESTNET_SOURCE,
  },
];

// fxdao testnet contracts. sourced from fxdao.io/docs/addresses/ "Testnet
// Addresses" section (re-fetched 2026-05-18). includes the vault contract,
// the four SACs (FXG, USDx, EURx, GBPx), and the oracle. locking-pool is
// omitted because the docs page does not advertise a testnet id.
const FXDAO_TESTNET_SOURCE = "fxdao.io/docs/addresses/ (Testnet)";
const TESTNET_FXDAO_ENTRIES: readonly AllowedContract[] = [
  {
    id: "CBUZ5NJKA5PRS4TBPHWMN4JGGRVIOQOKI4JUYLA2IXS3BEJKQKEWFW7D",
    name: "FxDAO::VaultsContract",
    protocol: "fxdao",
    verified_at: "2026-05-18",
    source: FXDAO_TESTNET_SOURCE,
  },
  {
    id: "CB4WLX4IP2MWAT2ITRRO7I5YM743NILBBOWMUIVWYSLWWASZVRGB5YD3",
    name: "FxDAO::FXG (SAC)",
    protocol: "fxdao",
    verified_at: "2026-05-18",
    source: FXDAO_TESTNET_SOURCE,
  },
  {
    id: "CA2QJKOZF6WE3C45FCYDWB45337BKENLUU4EREWWXRIMHKWJSH6EEWVO",
    name: "FxDAO::USDx (SAC)",
    protocol: "fxdao",
    verified_at: "2026-05-18",
    source: FXDAO_TESTNET_SOURCE,
  },
  {
    id: "CBA2S6NROG4PN36FSFZTWGD4JVQDCUYBMCW2H4J64JCGH7ZSQYTAIZ54",
    name: "FxDAO::EURx (SAC)",
    protocol: "fxdao",
    verified_at: "2026-05-18",
    source: FXDAO_TESTNET_SOURCE,
  },
  {
    id: "CDYP7LY3OIKHFVDID3CO6MQJ45T37N2G63NYXN33OQJPLW3X2PYRFHVT",
    name: "FxDAO::GBPx (SAC)",
    protocol: "fxdao",
    verified_at: "2026-05-18",
    source: FXDAO_TESTNET_SOURCE,
  },
  {
    id: "CCHXQJ5YDCIRGCBUTLC5BF2V2DKHULVPTQJGD4BAHW46JQWVRQNGA2LU",
    name: "FxDAO::Oracle",
    protocol: "fxdao",
    verified_at: "2026-05-18",
    source: FXDAO_TESTNET_SOURCE,
  },
];

// aquarius testnet entries. router verified 2026-05-18 against two sources:
//   1. AquaToken/aquarius-frontend constants/soroban.ts (CONTRACTS[ENV_TESTNET].amm).
//   2. stellar.expert testnet contract registry, validation.status=verified
//      against AquaToken/soroban-amm soroban-liquidity-pool-router-contract.
// the batcher is published in the same constants file but isn't invoked by
// the current adapter — mirrored here so the verifier accepts it later.
const TESTNET_AQUARIUS_ENTRIES: readonly AllowedContract[] = [
  {
    id: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
    name: "AquariusAmmRouter",
    protocol: "aquarius",
    verified_at: "2026-05-18",
    source:
      "github.com/AquaToken/aquarius-frontend/blob/master/src/constants/soroban.ts (CONTRACTS[ENV_TESTNET].amm); cross-confirmed via api.stellar.expert/explorer/testnet/contract/CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD (validation.status=verified against AquaToken/soroban-amm soroban-liquidity-pool-router-contract)",
  },
  {
    id: "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4",
    name: "AquariusBatcher",
    protocol: "aquarius",
    verified_at: "2026-05-18",
    source:
      "github.com/AquaToken/aquarius-frontend/blob/master/src/constants/soroban.ts (CONTRACTS[ENV_TESTNET].batch)",
  },
];

export const TESTNET_ALLOWLIST: readonly AllowedContract[] = [
  ...TESTNET_SOROSWAP_ENTRIES,
  ...TESTNET_BLEND_ENTRIES,
  ...TESTNET_AQUARIUS_ENTRIES,
  ...TESTNET_FXDAO_ENTRIES,
];

const MAINNET_ALLOWED_IDS: ReadonlySet<string> = new Set(MAINNET_ALLOWLIST.map((c) => c.id));
const TESTNET_ALLOWED_IDS: ReadonlySet<string> = new Set(TESTNET_ALLOWLIST.map((c) => c.id));

// returns the allow-list for the given network. futurenet returns empty.
export function getAllowlistForNetwork(network: NetworkConfig): readonly AllowedContract[] {
  switch (network.id) {
    case "mainnet":
      return MAINNET_ALLOWLIST;
    case "testnet":
      return TESTNET_ALLOWLIST;
    case "futurenet":
      return [];
  }
}

// pure predicate used by allowlist.ts before signing. omitting network
// defaults to mainnet for backward compatibility.
export function isAllowedContract(contractId: string, network?: NetworkConfig): boolean {
  if (network === undefined) {
    return MAINNET_ALLOWED_IDS.has(contractId);
  }
  switch (network.id) {
    case "mainnet":
      return MAINNET_ALLOWED_IDS.has(contractId);
    case "testnet":
      return TESTNET_ALLOWED_IDS.has(contractId);
    case "futurenet":
      return false;
  }
}

// lookup the human-readable label for a contract. returns null if not
// allow-listed. omitting network searches the mainnet list.
export function getAllowedContract(
  contractId: string,
  network?: NetworkConfig,
): AllowedContract | null {
  const list = network === undefined ? MAINNET_ALLOWLIST : getAllowlistForNetwork(network);
  return list.find((c) => c.id === contractId) ?? null;
}
