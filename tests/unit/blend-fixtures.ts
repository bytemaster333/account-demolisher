// real blend-sdk objects (pools, reserves, users) for unit tests. only the
// methods that would hit RPC (pool.loadUser) are replaced; every conversion and
// emissions estimate runs through the SDK's own code.
import {
  EmissionDataV2,
  EmissionsV2,
  PoolMetadata,
  PoolUser,
  PoolUserEmissionData,
  PoolV1,
  PoolV2,
  Positions,
  ReserveConfigV2,
  ReserveData,
  ReserveV1,
  ReserveV2,
  type Pool,
  type Reserve,
} from "@blend-capital/blend-sdk";
import { Horizon } from "@stellar/stellar-sdk";

import type { BlendPoolLoader } from "@/lib/adapters/blend/client";

export const NOW_SECONDS = 1_790_000_000;

export interface ReserveSpec {
  readonly assetId: string;
  readonly index: number;
  // rate with the version's decimals (v1: 9, v2: 12)
  readonly dRate: bigint;
  readonly bRate: bigint;
  readonly supplyEmissions?: EmissionsV2;
  readonly borrowEmissions?: EmissionsV2;
}

export function makeReserve(version: "V1" | "V2", poolId: string, spec: ReserveSpec): Reserve {
  const config = new ReserveConfigV2(
    spec.index,
    7,
    9_000_000,
    9_000_000,
    5_000_000,
    9_500_000,
    0,
    0,
    0,
    0,
    0,
    10n ** 20n,
    true,
  );
  const data = new ReserveData(
    spec.dRate,
    spec.bRate,
    1_000_000_000n,
    1_000_000_0000000n,
    2_000_000_0000000n,
    0n,
    NOW_SECONDS,
  );
  const Ctor = version === "V1" ? ReserveV1 : ReserveV2;
  return new Ctor(
    poolId,
    spec.assetId,
    config,
    data,
    spec.borrowEmissions,
    spec.supplyEmissions,
    0,
    0,
    0,
    0,
    1,
  );
}

export function supplyEmissions(index: bigint): EmissionsV2 {
  // expiration far in the future, eps 0 so accrue() never moves the index
  return new EmissionsV2(new EmissionDataV2(NOW_SECONDS + 86_400, 0n, index, NOW_SECONDS), 1);
}

export interface UserSpec {
  readonly liabilities?: ReadonlyArray<readonly [number, bigint]>;
  readonly collateral?: ReadonlyArray<readonly [number, bigint]>;
  readonly supply?: ReadonlyArray<readonly [number, bigint]>;
  // reserve token id -> [index, accrued]
  readonly emissions?: ReadonlyArray<readonly [number, bigint, bigint]>;
}

export function makePool(opts: {
  readonly version: "V1" | "V2";
  readonly poolId: string;
  readonly backstop: string;
  readonly reserves: readonly ReserveSpec[];
  readonly user?: UserSpec;
  readonly name?: string;
}): Pool {
  const metadata = new PoolMetadata(
    "00".repeat(32),
    "GADMIN",
    opts.name ?? "Test Pool",
    opts.backstop,
    1_000_000,
    4,
    0n,
    "CORACLE",
    0,
    opts.reserves.map((r) => r.assetId),
    1,
  );
  const reserves = new Map<string, Reserve>();
  for (const spec of opts.reserves) {
    reserves.set(spec.assetId, makeReserve(opts.version, opts.poolId, spec));
  }
  const network = { rpc: "http://unused", passphrase: "unused" };
  const pool =
    opts.version === "V1"
      ? new PoolV1(network, opts.poolId, metadata, reserves, NOW_SECONDS)
      : new PoolV2(network, opts.poolId, metadata, reserves, NOW_SECONDS);
  const spec = opts.user ?? {};
  const user = new PoolUser(
    "GUSER",
    new Positions(
      new Map(spec.liabilities ?? []),
      new Map(spec.collateral ?? []),
      new Map(spec.supply ?? []),
    ),
    new Map(
      (spec.emissions ?? []).map(([id, index, accrued]) => [
        id,
        new PoolUserEmissionData(index, accrued),
      ]),
    ),
  );
  pool.loadUser = async () => user;
  return pool;
}

export function loaderFor(...pools: Pool[]): BlendPoolLoader {
  return {
    async load(_network, poolId) {
      const pool = pools.find((p) => p.id === poolId);
      if (!pool) throw new Error(`no fixture pool ${poolId}`);
      return pool;
    },
  };
}

export interface BalanceSpec {
  readonly code?: string; // undefined -> native
  readonly issuer?: string;
  readonly balance: string;
  readonly sellingLiabilities?: string;
  readonly authorized?: boolean;
}

// a real Horizon AccountResponse built from a Horizon account record
export function horizonAccount(opts: {
  readonly accountId: string;
  readonly sequence: string;
  readonly balances: readonly BalanceSpec[];
  readonly subentryCount?: number;
  readonly numSponsoring?: number;
  readonly numSponsored?: number;
}): Horizon.AccountResponse {
  const balances = opts.balances.map((b) =>
    b.code === undefined
      ? {
          asset_type: "native",
          balance: b.balance,
          buying_liabilities: "0.0000000",
          selling_liabilities: b.sellingLiabilities ?? "0.0000000",
        }
      : {
          asset_type: b.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
          asset_code: b.code,
          asset_issuer: b.issuer,
          balance: b.balance,
          limit: "922337203685.4775807",
          buying_liabilities: "0.0000000",
          selling_liabilities: b.sellingLiabilities ?? "0.0000000",
          last_modified_ledger: 1,
          is_authorized: b.authorized ?? true,
          is_authorized_to_maintain_liabilities: true,
          is_clawback_enabled: false,
        },
  );
  return new Horizon.AccountResponse({
    id: opts.accountId,
    account_id: opts.accountId,
    paging_token: opts.accountId,
    sequence: opts.sequence,
    subentry_count: opts.subentryCount ?? 0,
    num_sponsoring: opts.numSponsoring ?? 0,
    num_sponsored: opts.numSponsored ?? 0,
    last_modified_ledger: 1,
    last_modified_time: "2026-10-02T00:00:00Z",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
      auth_clawback_enabled: false,
    },
    balances,
    signers: [{ key: opts.accountId, weight: 1, type: "ed25519_public_key" }],
    data: {},
    _links: {},
  } as never);
}
