// which classic asset a token contract wraps, and which trustlines an exit
// needs before the pool can pay that asset out.
//
// an lp exit pays each pool token to the user. when the token is a stellar asset
// contract (SAC) for a credit asset, the SAC writes that payment into the user's
// classic trustline, and with no trustline the whole exit traps with
// Error(Contract, #13) "trustline entry is missing for account". seen read-only
// on mainnet 2026-10-07 for soroswap pairs CBKG7Y3L... (YBX), CAFRE2UJ... (LIBRE)
// and CCBCJUEV... (GQX), and for an aquarius reward claim paying AQUA. a blend
// withdraw pays its reserve asset through the asset's SAC the same way.
//
// a contract is taken as a SAC only when its instance runs the built-in asset
// executable (no wasm, so no token code runs to answer this) and its name()
// derives back to its own contract id: a SAC's id is the hash of its asset, so
// the asset it names cannot be wrong without the id differing.

import {
  Address,
  Asset,
  AuthRequiredFlag,
  Keypair,
  StrKey,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";

import {
  getUserReward,
  readAquariusPoolRewardTokens,
  readAquariusRewardToken,
} from "@/lib/adapters/aquarius/client";
import { poolIndexHexToBytes, readAquariusPoolAddress } from "@/lib/adapters/aquarius/pools";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AuditBalance } from "@/lib/types/account";
import { mapConcurrent } from "@/lib/soroban/concurrency";
import { fromScValString } from "@/lib/soroban/scval";
import { simulateRead } from "@/lib/soroban/simulate";

export type WrappedAsset =
  | { readonly kind: "native" }
  | {
      readonly kind: "credit";
      readonly code: string;
      readonly issuer: string;
      // the issuer's auth_required flag: a line opened now starts unauthorized
      // and can't receive a payout until the issuer authorizes it. null when the
      // issuer account no longer exists, so change_trust fails (no_issuer) and
      // no new line can be opened at all.
      readonly issuerAuthRequired: boolean | null;
    };

type SacName =
  { readonly kind: "native" } | { readonly kind: "credit"; code: string; issuer: string };

export interface StellarAssetDeps {
  readonly simulateRead?: typeof simulateRead;
  // ledger keys per getLedgerEntries call (the rpc accepts at most 200)
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 190;

// maps each contract id to the classic asset it wraps, or null for a contract
// that is not a stellar asset contract, with whether its issuer lets a new line
// receive. throws when an instance is missing or a SAC's name does not derive
// to its id, so a caller never plans an exit on a guess.
export async function readWrappedAssets(
  server: rpc.Server,
  network: NetworkConfig,
  contractIds: readonly string[],
  sourcePublicKey: string,
  deps: StellarAssetDeps = {},
): Promise<Map<string, WrappedAsset | null>> {
  const read = deps.simulateRead ?? simulateRead;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const ids = [...new Set(contractIds)];
  const isSac = new Map<string, boolean>();
  for (let i = 0; i < ids.length; i += batchSize) {
    const keys = ids.slice(i, i + batchSize).map((id) =>
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(id).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent,
        }),
      ),
    );
    const resp = await server.getLedgerEntries(...keys);
    for (const entry of resp.entries) {
      const cd = xdr.expectUnionVariant(entry.val, "contractData").contractData;
      const id = Address.fromScAddress(cd.contract).toString();
      const instance = xdr.expectUnionVariant(cd.val, "scvContractInstance").instance;
      isSac.set(id, instance.executable.type === "contractExecutableStellarAsset");
    }
  }
  const missing = ids.filter((id) => !isSac.has(id));
  if (missing.length > 0) {
    throw new Error(`token contract instances not returned by the rpc: ${missing.join(", ")}`);
  }

  const named = new Map<string, SacName | null>();
  for (const id of ids) {
    if (isSac.get(id) !== true) {
      named.set(id, null);
      continue;
    }
    const { retval } = await read(server, id, "name", [], sourcePublicKey, network);
    const asset = parseSacName(fromScValString(retval));
    const derived =
      asset.kind === "native"
        ? Asset.native().contractId(network.passphrase)
        : new Asset(asset.code, asset.issuer).contractId(network.passphrase);
    if (derived !== id) {
      throw new Error(
        `stellar asset contract ${id} names an asset whose contract is ${derived}, refusing to trust it`,
      );
    }
    named.set(id, asset);
  }

  const issuers = [
    ...new Set([...named.values()].flatMap((a) => (a?.kind === "credit" ? [a.issuer] : []))),
  ];
  const authRequired = await readIssuerAuthRequired(server, issuers, batchSize);
  const out = new Map<string, WrappedAsset | null>();
  for (const [id, asset] of named) {
    out.set(
      id,
      asset === null || asset.kind === "native"
        ? asset
        : { ...asset, issuerAuthRequired: authRequired.get(asset.issuer) ?? null },
    );
  }
  return out;
}

// each issuer's auth_required flag from its account entry. an issuer the rpc
// does not return has no account (merged away); it is left out of the map.
async function readIssuerAuthRequired(
  server: rpc.Server,
  issuers: readonly string[],
  batchSize: number,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (let i = 0; i < issuers.length; i += batchSize) {
    const keys = issuers
      .slice(i, i + batchSize)
      .map((id) =>
        xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(id).xdrPublicKey() }),
        ),
      );
    const resp = await server.getLedgerEntries(...keys);
    for (const entry of resp.entries) {
      const account = xdr.expectUnionVariant(entry.val, "account").account;
      const id = StrKey.encodeEd25519PublicKey(
        xdr.expectUnionVariant(account.accountId, "publicKeyTypeEd25519").ed25519.toBytes(),
      );
      out.set(id, (account.flags & AuthRequiredFlag) !== 0);
    }
  }
  return out;
}

// a SAC's name() is "native" or "CODE:ISSUER"
function parseSacName(name: string): SacName {
  if (name === "native") return { kind: "native" };
  const sep = name.indexOf(":");
  if (sep <= 0 || sep !== name.lastIndexOf(":")) {
    throw new Error(`stellar asset contract name "${name}" is not CODE:ISSUER`);
  }
  const code = name.slice(0, sep);
  const issuer = name.slice(sep + 1);
  // Asset's constructor validates the code and the issuer key
  new Asset(code, issuer);
  return { kind: "credit", code, issuer };
}

// the pool and reserve tokens the planned exits pay out, with the same rules the
// plan generator uses to plan them: a soroswap or aquarius withdraw needs shares,
// a concentrated pool pays its own tokens only through a range with liquidity or
// unpaid fees, and a blend withdraw pays each collateral or supply asset. a
// position kept only for its reward pays none of its pool tokens.
//
// it does not include the aquarius reward token, which needs rpc reads; a
// trustline check must use readExitPayouts.
export function exitPayoutTokens(positions: ProtocolPositions): readonly string[] {
  const out = new Set<string>();
  for (const p of positions.soroswap) {
    if (p.shareBalance <= 0n) continue;
    out.add(p.pair.tokenA);
    out.add(p.pair.tokenB);
  }
  for (const p of positions.aquarius) {
    if (p.shareBalance > 0n) for (const t of p.tokens) out.add(t);
  }
  for (const p of positions.aquariusConcentrated) {
    if (p.ranges.some((r) => r.liquidity > 0n) || p.pendingFees.some((f) => f > 0n)) {
      for (const t of p.tokens) out.add(t);
    }
  }
  for (const pool of positions.blend) {
    for (const [asset, amount] of [...pool.collateral, ...pool.supply]) {
      if (amount > 0n) out.add(asset);
    }
  }
  return [...out];
}

export interface ExitPayoutDeps {
  readonly readRewardToken?: typeof readAquariusRewardToken;
  readonly readUserReward?: typeof getUserReward;
  readonly readPoolAddress?: typeof readAquariusPoolAddress;
  readonly readPoolRewardTokens?: typeof readAquariusPoolRewardTokens;
}

export interface ExitPayouts {
  // every token a planned exit or reward claim pays out
  readonly tokens: readonly string[];
  // the one token every aquarius reward claim that pays anything pays, for
  // GeneratePlanOptions.aquariusRewardToken; undefined when no claim pays
  readonly aquariusRewardToken: string | undefined;
}

const REWARD_READ_CONCURRENCY = 4;

// exitPayoutTokens plus the reward token of each aquarius pool whose claim will
// pay some. a claim of a pending reward into a missing trustline traps with
// Error(Contract, #13) like a withdraw; a claim with nothing pending runs and
// pays 0 (both seen read-only on mainnet 2026-10-07), so a pool only counts
// when a reward is pending there. the generator claims every standard pool it
// withdraws, so each of those is asked through get_user_reward; a concentrated
// position carries its own pendingReward.
//
// the pool pays its claim from its own RewardToken, while the plan links every
// claim to one reward token, so a paying pool whose token is not the router's
// is refused rather than planned against the wrong line. any failed read
// throws: an unknown reward must not read as "no payout".
export async function readExitPayouts(
  server: rpc.Server,
  network: NetworkConfig,
  userAddress: string,
  positions: ProtocolPositions,
  deps: ExitPayoutDeps = {},
): Promise<ExitPayouts> {
  const tokens = exitPayoutTokens(positions);
  const readUserReward = deps.readUserReward ?? getUserReward;
  const readPoolAddress = deps.readPoolAddress ?? readAquariusPoolAddress;

  const paying = positions.aquariusConcentrated
    .filter((p) => p.pendingReward > 0n)
    .map((p) => p.poolAddress);
  const withdrawn = positions.aquarius.filter((p) => p.shareBalance > 0n);
  const rewards = await mapConcurrent(withdrawn, REWARD_READ_CONCURRENCY, (p) =>
    readUserReward(server, {
      user: userAddress,
      tokens: p.tokens,
      poolIndex: poolIndexHexToBytes(p.poolIndex),
      network,
    }),
  );
  const rewarded = withdrawn.filter((_, i) => rewards[i]! > 0n);
  paying.push(
    ...(await mapConcurrent(rewarded, REWARD_READ_CONCURRENCY, (p) =>
      readPoolAddress(server, network, p.tokens, p.poolIndex, userAddress),
    )),
  );
  if (paying.length === 0) return { tokens, aquariusRewardToken: undefined };

  const [routerToken, byPool] = await Promise.all([
    (deps.readRewardToken ?? readAquariusRewardToken)(server, network),
    (deps.readPoolRewardTokens ?? readAquariusPoolRewardTokens)(server, paying),
  ]);
  for (const pool of new Set(paying)) {
    const poolTokens = byPool.get(pool);
    if (poolTokens === undefined) {
      throw new Error(`the reward token of Aquarius pool ${pool} was not read`);
    }
    if (poolTokens.length !== 1 || poolTokens[0] !== routerToken) {
      throw new Error(
        `Aquarius pool ${pool} pays its rewards in ${poolTokens.join(", ")}, not only in the ` +
          `router's reward token ${routerToken}, so its reward claim can't be planned. Claim ` +
          "that reward outside this app before closing.",
      );
    }
  }
  return {
    tokens: tokens.includes(routerToken) ? tokens : [...tokens, routerToken],
    aquariusRewardToken: routerToken,
  };
}

// the token list of readExitPayouts
export async function readExitPayoutTokens(
  server: rpc.Server,
  network: NetworkConfig,
  userAddress: string,
  positions: ProtocolPositions,
  deps: ExitPayoutDeps = {},
): Promise<readonly string[]> {
  return (await readExitPayouts(server, network, userAddress, positions, deps)).tokens;
}

export interface ExitTrustlineGap {
  readonly contractId: string;
  readonly code: string;
  readonly issuer: string;
  // missing: a change_trust before the exit fixes it. the other two need the
  // issuer, which the app can't stand in for. unauthorized: the account has the
  // line and the issuer has not authorized it. issuer_requires_authorization:
  // there is no line, and one opened now would start unauthorized.
  readonly reason: "missing" | "unauthorized" | "issuer_requires_authorization";
}

export type UnfixableExitTrustlineGap = ExitTrustlineGap & {
  readonly reason: Exclude<ExitTrustlineGap["reason"], "missing">;
};

export function isUnfixableGap(gap: ExitTrustlineGap): gap is UnfixableExitTrustlineGap {
  return gap.reason !== "missing";
}

// why the line can't take a payout, and what the user can do about it. both
// the plan generator and the review blockers word a refusal with this, so the
// two never disagree about whether the line exists.
export function describeUnfixableGap(gap: UnfixableExitTrustlineGap): {
  readonly cause: string;
  readonly fix: string;
} {
  const asset = `${gap.code}:${gap.issuer}`;
  switch (gap.reason) {
    case "unauthorized":
      return {
        cause: `The ${asset} trustline of this account is not authorized by its issuer.`,
        fix: "Ask the issuer to authorize the line",
      };
    case "issuer_requires_authorization":
      return {
        cause:
          `This account has no ${asset} trustline, and its issuer requires authorization, so ` +
          "a line opened now could not receive anything until the issuer authorizes it.",
        fix: "Open the line from your wallet and have the issuer authorize it",
      };
  }
}

// the credit assets among an exit's payout tokens that the account cannot
// receive right now. native and non-SAC tokens need no trustline, and neither
// does an asset the account issues itself. a missing line whose issuer account
// is gone can't be opened at all, which stops the plan here.
export function exitTrustlineGaps(
  accountId: string,
  balances: readonly AuditBalance[],
  payoutTokens: readonly string[],
  wrapped: ReadonlyMap<string, WrappedAsset | null>,
): ExitTrustlineGap[] {
  const gaps: ExitTrustlineGap[] = [];
  for (const contractId of new Set(payoutTokens)) {
    if (!wrapped.has(contractId)) {
      throw new Error(`exitTrustlineGaps: token ${contractId} was not resolved`);
    }
    const asset = wrapped.get(contractId);
    if (asset === null || asset === undefined || asset.kind === "native") continue;
    if (asset.issuer === accountId) continue;
    const line = balances.find(
      (b) =>
        b.asset.kind === "credit" && b.asset.code === asset.code && b.asset.issuer === asset.issuer,
    );
    if (line === undefined) {
      if (asset.issuerAuthRequired === null) {
        throw new Error(
          `The ${asset.code} issuer account ${asset.issuer} no longer exists, so this account ` +
            `can't open the ${asset.code} trustline a pool exit pays into, and that exit can't ` +
            "run, so the close stops here.",
        );
      }
      gaps.push({
        contractId,
        code: asset.code,
        issuer: asset.issuer,
        reason: asset.issuerAuthRequired === true ? "issuer_requires_authorization" : "missing",
      });
    } else if (line.isAuthorized === false) {
      gaps.push({ contractId, code: asset.code, issuer: asset.issuer, reason: "unauthorized" });
    }
  }
  return gaps;
}
