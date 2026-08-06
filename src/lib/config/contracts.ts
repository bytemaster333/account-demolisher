// network-aware contract-id allow-list

import {
  BLEND_MAINNET_INFRASTRUCTURE,
  BLEND_MAINNET_POOLS,
  BLEND_TESTNET_INFRASTRUCTURE,
  BLEND_TESTNET_POOLS,
} from "@/lib/adapters/blend/pools";
import { FXDAO_MAINNET_CONTRACTS, FXDAO_TESTNET_CONTRACTS } from "@/lib/adapters/fxdao/contracts";
import type { NetworkConfig } from "@/lib/config/networks";

export interface AllowedContract {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly verified_at: string;
  readonly source: string;
}

// blend mainnet pool ids + infrastructure (factory, backstop, BLND/USDC
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

// testnet allow-list, mirrors the four protocols on stellar testnet

// blend testnet infrastructure (factory, backstopV2, emitter, tokens…) is
// snapshotted in blend/pools.ts and shared with backstop resolution.
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

// soroswap testnet contracts (factory + router; no aggregator on testnet)
// sourced from soroswap/core@main/public/testnet.contracts.json (re-fetched 2026-05-18)
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

// fxdao testnet contracts (vault + synthetic-stablecoin SACs + oracle) are
// snapshotted in fxdao/contracts.ts and shared with discovery so ids live once.
const TESTNET_FXDAO_ENTRIES: readonly AllowedContract[] = FXDAO_TESTNET_CONTRACTS.map(
  (entry): AllowedContract => ({
    id: entry.id,
    name: `FxDAO::${entry.name}`,
    protocol: "fxdao",
    verified_at: entry.verified_at,
    source: entry.source,
  }),
);

// aquarius testnet entries
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

// returns the allow-list for the given network. futurenet returns empty
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
// defaults to mainnet for backward compatibility
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
