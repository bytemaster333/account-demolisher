/**
 * frozen snapshot of the blend mainnet pool registry.
 * source: github.com/blend-capital/blend-utils/main/mainnet.contracts.json
 * commit b05242df30b6b6caf9d317646f754541824a5a8b (2025-12-18T13:22:46Z)
 *
 * upstream JSON exposes a flat ids map keyed by role (poolFactoryV2, backstopV2, etc.) but does
 * NOT enumerate per-pool reserves — those live on the pool's on-chain reserveList and must be
 * loaded via Pool.load at runtime. assets is therefore an empty frozen tuple here.
 *
 * only v2 pools live under BLEND_MAINNET_POOLS; legacy v1 contract IDs stay in
 * BLEND_MAINNET_INFRASTRUCTURE so the allow-list covers them.
 */

/**
 * one entry in the blend pool registry.
 *  - pool_id: soroban contract address
 *  - name: human label, matches the on-chain PoolMetadata.name
 *  - version: SDK pool version; PoolV2.load vs PoolV1.load
 *  - assets: reserve assets if statically known. empty here — load dynamically.
 *  - verified_at: ISO date of the upstream snapshot
 *  - source: upstream URL + commit anchor
 */
export interface BlendPoolEntry {
  readonly pool_id: string;
  readonly name: string;
  readonly version: "V1" | "V2";
  readonly assets: readonly string[];
  readonly verified_at: string;
  readonly source: string;
}

const BLEND_UTILS_COMMIT = "b05242df30b6b6caf9d317646f754541824a5a8b";
const BLEND_UTILS_SOURCE = `github.com/blend-capital/blend-utils@${BLEND_UTILS_COMMIT}/mainnet.contracts.json`;
const VERIFIED_AT = "2026-05-15";

// mainnet blend pools (v2). snapshotted from mainnet.contracts.json::ids.{FixedV2,YieldBloxV2}.
export const BLEND_MAINNET_POOLS: readonly BlendPoolEntry[] = Object.freeze([
  Object.freeze({
    pool_id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    name: "FixedV2",
    version: "V2",
    assets: Object.freeze([] as readonly string[]),
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  } satisfies BlendPoolEntry),
  Object.freeze({
    pool_id: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS",
    name: "YieldBloxV2",
    version: "V2",
    assets: Object.freeze([] as readonly string[]),
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  } satisfies BlendPoolEntry),
  // legacy v1 pools — retained so allow-list covers them. PoolV1.load works against these IDs.
  Object.freeze({
    pool_id: "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP",
    name: "Fixed",
    version: "V1",
    assets: Object.freeze([] as readonly string[]),
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  } satisfies BlendPoolEntry),
  Object.freeze({
    pool_id: "CBP7NO6F7FRDHSOFQBT2L2UWYIZ2PU76JKVRYAQTG3KZSQLYAOKIF2WB",
    name: "YieldBlox",
    version: "V1",
    assets: Object.freeze([] as readonly string[]),
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  } satisfies BlendPoolEntry),
]);

/**
 * frozen snapshot of canonical blend testnet pools.
 * source: github.com/blend-capital/blend-utils/main/testnet.contracts.json (verified 2026-05-16)
 * env override available via BLEND_TESTNET_POOL_ID.
 */
const BLEND_TESTNET_SOURCE = "github.com/blend-capital/blend-utils@main/testnet.contracts.json";
const TESTNET_VERIFIED_AT = "2026-05-16";

export const BLEND_TESTNET_POOLS: readonly BlendPoolEntry[] = Object.freeze([
  Object.freeze({
    pool_id: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    name: "TestnetV2",
    version: "V2",
    assets: Object.freeze([] as readonly string[]),
    verified_at: TESTNET_VERIFIED_AT,
    source: BLEND_TESTNET_SOURCE,
  } satisfies BlendPoolEntry),
]);

// resolved via env override
export const TESTNET_POOLS = BLEND_TESTNET_POOLS;

/**
 * infrastructure contracts the SDK invokes alongside each pool (factory, backstop,
 * BLND/USDC tokens, comet LP, etc.). sourced from the same upstream ids map.
 */
export interface BlendInfrastructureEntry {
  readonly id: string;
  readonly name: string;
  readonly verified_at: string;
  readonly source: string;
}

export const BLEND_MAINNET_INFRASTRUCTURE: readonly BlendInfrastructureEntry[] = Object.freeze([
  Object.freeze({
    id: "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU",
    name: "poolFactoryV2",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CCZD6ESMOGMPWH2KRO4O7RGTAPGTUPFWFQBELQSS7ZUK63V3TZWETGAG",
    name: "poolFactory",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7",
    name: "backstopV2",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3",
    name: "backstop",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CCOQM6S7ICIUWA225O5PSJWUBEMXGFSSW2PQFO6FP4DQEKMS5DASRGRR",
    name: "emitter",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY",
    name: "BLND",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    name: "USDC",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    name: "XLM (SAC)",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CA2LVIPU6HJHHPPD6EDDYJTV2QEUBPGOAVJ4VIYNTMFUCRM4LFK3TJKF",
    name: "cometFactory",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM",
    name: "comet (BLND/USDC LP)",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
  Object.freeze({
    id: "CBUTN4KJSULJAUZYTYIGSMYAOO7PBJSAQ5OP6UTGYHOXA6UQYBAEOBB3",
    name: "bootstrapper",
    verified_at: VERIFIED_AT,
    source: BLEND_UTILS_SOURCE,
  }),
]);

// every blend mainnet pool id as a frozen string array
export const BLEND_MAINNET_POOL_IDS: readonly string[] = Object.freeze(
  BLEND_MAINNET_POOLS.map((p) => p.pool_id),
);
