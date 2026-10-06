// network-aware contract-id allow-list

import {
  BLEND_MAINNET_INFRASTRUCTURE,
  BLEND_MAINNET_POOLS,
  BLEND_TESTNET_INFRASTRUCTURE,
  BLEND_TESTNET_POOLS,
} from "@/lib/adapters/blend/pools";
import { FXDAO_MAINNET_CONTRACTS, FXDAO_TESTNET_CONTRACTS } from "@/lib/adapters/fxdao/contracts";
import {
  CONCENTRATED_POOLS_SOURCE,
  CONCENTRATED_POOLS_VERIFIED_AT,
  MAINNET_CONCENTRATED_POOLS,
  TESTNET_CONCENTRATED_POOLS,
  type AquariusConcentratedPool,
} from "@/lib/adapters/aquarius/concentrated-pools";
import type { NetworkConfig } from "@/lib/config/networks";

// entrypoint: a contract an adapter invokes as the root of a transaction it asks
// the user to sign. token / infrastructure: known contracts (SACs, factories,
// oracles, emitters) kept for labelling and lookups but never a valid root call
// target, so a bug that builds e.g. a direct XLM_SAC.transfer is refused at sign
// time instead of passing on "the contract is known".
export type AllowedContractRole = "entrypoint" | "token" | "infrastructure";

export interface AllowedContract {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly role: AllowedContractRole;
  readonly verified_at: string;
  readonly source: string;
}

// the blend contracts an adapter calls as the root: every pool (submit, claim)
// and the backstops (queue_withdrawal). everything else in the blend snapshot is a
// token or infrastructure.
const BLEND_ENTRYPOINT_INFRASTRUCTURE = new Set(["backstop", "backstopV2"]);

function blendInfrastructureRole(name: string): AllowedContractRole {
  if (BLEND_ENTRYPOINT_INFRASTRUCTURE.has(name)) return "entrypoint";
  return /SAC|^BLND$|^USDC$|LP\)$/.test(name) ? "token" : "infrastructure";
}

// fxdao: only the vaults contract is invoked (pay_debt); the rest are the
// synthetic-stablecoin SACs, the oracle and the locking pool
function fxdaoRole(name: string): AllowedContractRole {
  if (name === "VaultsContract") return "entrypoint";
  return /SAC/.test(name) ? "token" : "infrastructure";
}

function concentratedEntry(pool: AquariusConcentratedPool): AllowedContract {
  return {
    id: pool.address,
    name: `AquariusConcentratedPool::${pool.poolIndex.slice(0, 8)}`,
    protocol: "aquarius",
    role: "entrypoint",
    verified_at: CONCENTRATED_POOLS_VERIFIED_AT,
    source: CONCENTRATED_POOLS_SOURCE,
  };
}

// blend mainnet pool ids + infrastructure (factory, backstop, BLND/USDC
const BLEND_ALLOWLIST_ENTRIES: readonly AllowedContract[] = [
  ...BLEND_MAINNET_POOLS.map((pool): AllowedContract => ({
    id: pool.pool_id,
    name: `BlendPool::${pool.name}`,
    protocol: "blend",
    role: "entrypoint",
    verified_at: pool.verified_at,
    source: pool.source,
  })),
  ...BLEND_MAINNET_INFRASTRUCTURE.map((entry): AllowedContract => ({
    id: entry.id,
    name: `Blend::${entry.name}`,
    protocol: "blend",
    role: blendInfrastructureRole(entry.name),
    verified_at: entry.verified_at,
    source: entry.source,
  })),
];

// fxdao mainnet vault contract + synthetic-stablecoin sacs, mirrored from
const FXDAO_ALLOWLIST_ENTRIES: readonly AllowedContract[] = FXDAO_MAINNET_CONTRACTS.map(
  (entry): AllowedContract => ({
    id: entry.id,
    name: `FxDAO::${entry.name}`,
    protocol: "fxdao",
    role: fxdaoRole(entry.name),
    verified_at: entry.verified_at,
    source: entry.source,
  }),
);

// soroswap mainnet router + factory, from the protocol's own published
// deployment file (re-verified against upstream 2026-08-23)
const SOROSWAP_MAINNET_SOURCE = "github.com/soroswap/core@main/public/mainnet.contracts.json";

export const MAINNET_ALLOWLIST: readonly AllowedContract[] = [
  // soroswap (github.com/soroswap/core)
  {
    id: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
    name: "SoroswapRouter",
    protocol: "soroswap",
    role: "entrypoint",
    verified_at: "2026-08-23",
    source: SOROSWAP_MAINNET_SOURCE,
  },
  {
    id: "CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2",
    name: "SoroswapFactory",
    protocol: "soroswap",
    role: "infrastructure",
    verified_at: "2026-08-23",
    source: SOROSWAP_MAINNET_SOURCE,
  },
  // blend (github.com/blend-capital/blend-utils)
  ...BLEND_ALLOWLIST_ENTRIES,
  // aquarius (github.com/AquaToken/soroban-amm)
  {
    id: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    name: "AquariusAmmRouter",
    protocol: "aquarius",
    role: "entrypoint",
    verified_at: "2026-08-23",
    source:
      "docs.aqua.network/developers/code-examples/prerequisites-and-basics (mainnet AMM contract id); cross-confirmed against AquaToken/soroban-amm liquidity_pool_router",
  },
  ...MAINNET_CONCENTRATED_POOLS.map(concentratedEntry),
  // fxdao (www.fxdao.io/docs/addresses/)
  ...FXDAO_ALLOWLIST_ENTRIES,
];

// testnet allow-list, mirrors the four protocols on stellar testnet

// blend testnet infrastructure (factory, backstopV2, emitter, tokens…) is
// snapshotted in blend/pools.ts and shared with backstop resolution.
const TESTNET_BLEND_ENTRIES: readonly AllowedContract[] = [
  ...BLEND_TESTNET_POOLS.map((pool): AllowedContract => ({
    id: pool.pool_id,
    name: `BlendPool::${pool.name}`,
    protocol: "blend",
    role: "entrypoint",
    verified_at: pool.verified_at,
    source: pool.source,
  })),
  ...BLEND_TESTNET_INFRASTRUCTURE.map((entry): AllowedContract => ({
    id: entry.id,
    name: `Blend::${entry.name}`,
    protocol: "blend",
    role: blendInfrastructureRole(entry.name),
    verified_at: entry.verified_at,
    source: entry.source,
  })),
];

// soroswap testnet contracts (factory + router; no aggregator on testnet)
// sourced from soroswap/core@main/public/testnet.contracts.json (re-fetched 2026-05-18)
const SOROSWAP_TESTNET_SOURCE = "github.com/soroswap/core@main/public/testnet.contracts.json";
const TESTNET_SOROSWAP_ENTRIES: readonly AllowedContract[] = [
  {
    id: "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD",
    name: "SoroswapRouter",
    protocol: "soroswap",
    role: "entrypoint",
    verified_at: "2026-05-18",
    source: SOROSWAP_TESTNET_SOURCE,
  },
  {
    id: "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY",
    name: "SoroswapFactory",
    protocol: "soroswap",
    role: "infrastructure",
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
    role: fxdaoRole(entry.name),
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
    role: "entrypoint",
    verified_at: "2026-05-18",
    source:
      "github.com/AquaToken/aquarius-frontend/blob/master/src/constants/soroban.ts (CONTRACTS[ENV_TESTNET].amm); cross-confirmed via api.stellar.expert/explorer/testnet/contract/CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD (validation.status=verified against AquaToken/soroban-amm soroban-liquidity-pool-router-contract)",
  },
  {
    id: "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4",
    name: "AquariusBatcher",
    protocol: "aquarius",
    role: "infrastructure",
    verified_at: "2026-05-18",
    source:
      "github.com/AquaToken/aquarius-frontend/blob/master/src/constants/soroban.ts (CONTRACTS[ENV_TESTNET].batch)",
  },
  ...TESTNET_CONCENTRATED_POOLS.map(concentratedEntry),
];

export const TESTNET_ALLOWLIST: readonly AllowedContract[] = [
  ...TESTNET_SOROSWAP_ENTRIES,
  ...TESTNET_BLEND_ENTRIES,
  ...TESTNET_AQUARIUS_ENTRIES,
  ...TESTNET_FXDAO_ENTRIES,
];

function idsWithRole(list: readonly AllowedContract[], role?: AllowedContractRole) {
  return new Set(list.filter((c) => role === undefined || c.role === role).map((c) => c.id));
}

const MAINNET_KNOWN_IDS: ReadonlySet<string> = idsWithRole(MAINNET_ALLOWLIST);
const TESTNET_KNOWN_IDS: ReadonlySet<string> = idsWithRole(TESTNET_ALLOWLIST);
const MAINNET_ENTRYPOINT_IDS: ReadonlySet<string> = idsWithRole(MAINNET_ALLOWLIST, "entrypoint");
const TESTNET_ENTRYPOINT_IDS: ReadonlySet<string> = idsWithRole(TESTNET_ALLOWLIST, "entrypoint");

// every curated contract for the given network, entry points and labels alike.
// futurenet returns empty
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

// the sign-time predicate: may this contract be the root of a transaction we ask
// the user to sign. only entry points qualify.
export function isAllowedRootTarget(contractId: string, network: NetworkConfig): boolean {
  switch (network.id) {
    case "mainnet":
      return MAINNET_ENTRYPOINT_IDS.has(contractId);
    case "testnet":
      return TESTNET_ENTRYPOINT_IDS.has(contractId);
    case "futurenet":
      return false;
  }
}

// labelling predicate: is the contract curated at all on this network (entry
// point, token or infrastructure)
export function isKnownContract(contractId: string, network: NetworkConfig): boolean {
  switch (network.id) {
    case "mainnet":
      return MAINNET_KNOWN_IDS.has(contractId);
    case "testnet":
      return TESTNET_KNOWN_IDS.has(contractId);
    case "futurenet":
      return false;
  }
}

// the predicate allowlist.ts applies before signing, so it answers the root-target
// question. an omitted network still reads as mainnet only because callers in
// other modules (scam-heuristics passes none) have not moved to isAllowedRootTarget
// / isKnownContract with an explicit network yet; new code must not call this.
export function isAllowedContract(contractId: string, network?: NetworkConfig): boolean {
  if (network === undefined) return MAINNET_ENTRYPOINT_IDS.has(contractId);
  return isAllowedRootTarget(contractId, network);
}
