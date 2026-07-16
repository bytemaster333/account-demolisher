import { Horizon } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { filterClaimableNow } from "@/lib/stellar/claimable-balances";
import type { NetworkConfig } from "@/lib/config/networks";
import type {
  AccountAudit,
  AssetIdentifier,
  AuditBalance,
  AuditFlags,
  AuditSigner,
  AuditThresholds,
  ClaimableBalanceEntry,
  DataEntry,
  Mergeability,
  OfferEntry,
  PoolShareEntry,
  SponsorshipInfo,
} from "@/lib/types/account";

// read-only audit of a classic stellar account. no caching. every call
// re-reads horizon
export async function auditAccount(
  publicKey: string,
  network: NetworkConfig,
): Promise<AccountAudit> {
  const server = getHorizon(network);

  let account: Horizon.AccountResponse;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err) {
    if (isHorizonNotFound(err)) {
      throw new AccountNotFoundError(publicKey);
    }
    throw err;
  }

  const balances = parseBalances(account.balances);
  const signers = parseSigners(account.signers);
  const thresholds = parseThresholds(account.thresholds, signers, account.account_id);
  const flags = parseFlags(account.flags);
  const data = parseData(account.data_attr);

  const [offers, rawClaimableBalances, poolShares] = await Promise.all([
    loadOffers(server, publicKey),
    loadClaimableBalances(server, publicKey),
    loadPoolShares(server, balances),
  ]);

  // mark which CBs this account can actually claim right now, so the UI and
  // the batcher never attempt an unclaimable balance (which would fail on-chain
  // and, if self-sponsored, would leave the merge blocked).
  const claimableIds = new Set(
    filterClaimableNow(rawClaimableBalances, publicKey, new Date()).map((c) => c.id),
  );
  const claimableBalances: readonly ClaimableBalanceEntry[] = rawClaimableBalances.map((cb) => ({
    ...cb,
    claimableNow: claimableIds.has(cb.id),
  }));

  // sponsorships the demolition can release itself: the account's OWN entries
  // that it self-sponsors (removed/cancelled/cleared on close) plus claimable
  // self-sponsored CBs. Anything beyond this in num_sponsoring is a foreign
  // sponsorship the user must resolve before the account can merge.
  const accountId = account.account_id;
  const coverableSponsorships = computeCoverableSponsorships(accountId, {
    balances,
    offers,
    signers,
    claimableBalances,
    data,
  });

  const sponsorship: SponsorshipInfo = {
    numSponsoring: account.num_sponsoring,
    numSponsored: account.num_sponsored,
    coverable: Math.min(coverableSponsorships, account.num_sponsoring),
    ...(account.sponsor !== undefined ? { sponsoredBy: account.sponsor } : {}),
  };

  const requiresMultisig = computeRequiresMultisig(thresholds);
  const mergeability = computeMergeability(flags, sponsorship);

  return {
    accountId: account.account_id,
    sequence: account.sequence,
    subentryCount: account.subentry_count,
    ...(account.home_domain !== undefined ? { homeDomain: account.home_domain } : {}),
    thresholds,
    flags,
    balances,
    signers,
    offers,
    data,
    claimableBalances,
    poolShares,
    sponsorship,
    requiresMultisig,
    mergeability,
  };
}

export class AccountNotFoundError extends Error {
  constructor(public readonly publicKey: string) {
    super(`Stellar account not found on this network: ${publicKey}`);
    this.name = "AccountNotFoundError";
  }
}

function isHorizonNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: number }; name?: string };
  return e.response?.status === 404 || e.name === "NotFoundError";
}

function parseBalances(
  balances: readonly Horizon.HorizonApi.BalanceLine[],
): readonly AuditBalance[] {
  return balances.map((b) => {
    const asset = balanceLineToAsset(b);
    // lp shares have no buying/selling liabilities
    const buyingLiabilities = "buying_liabilities" in b ? b.buying_liabilities : "0";
    const sellingLiabilities = "selling_liabilities" in b ? b.selling_liabilities : "0";
    const result: Record<string, unknown> = {
      asset,
      amount: b.balance,
      buyingLiabilities,
      sellingLiabilities,
    };
    if ("limit" in b && typeof b.limit === "string") result.limit = b.limit;
    if ("is_authorized" in b) {
      result.isAuthorized = (b as { is_authorized: boolean }).is_authorized;
    }
    if ("is_authorized_to_maintain_liabilities" in b) {
      result.isAuthorizedToMaintainLiabilities = (
        b as { is_authorized_to_maintain_liabilities: boolean }
      ).is_authorized_to_maintain_liabilities;
    }
    if ("sponsor" in b && typeof (b as { sponsor?: unknown }).sponsor === "string") {
      result.sponsor = (b as { sponsor: string }).sponsor;
    }
    return result as unknown as AuditBalance;
  });
}

function balanceLineToAsset(b: Horizon.HorizonApi.BalanceLine): AssetIdentifier {
  switch (b.asset_type) {
    case "native":
      return { kind: "native" };
    case "credit_alphanum4":
    case "credit_alphanum12":
      return {
        kind: "credit",
        code: b.asset_code,
        issuer: b.asset_issuer,
      };
    case "liquidity_pool_shares":
      return {
        kind: "liquidity_pool_shares",
        poolId: b.liquidity_pool_id,
      };
  }
}

function parseSigners(
  signers: readonly Horizon.ServerApi.AccountRecordSigners[],
): readonly AuditSigner[] {
  return signers.map((s) => {
    const base: AuditSigner = {
      key: s.key,
      type: s.type as AuditSigner["type"],
      weight: s.weight,
    };
    const sponsor = (s as { sponsor?: string }).sponsor;
    return sponsor !== undefined ? { ...base, sponsor } : base;
  });
}

function parseThresholds(
  t: Horizon.HorizonApi.AccountThresholds,
  signers: readonly AuditSigner[],
  accountId: string,
): AuditThresholds {
  // the master key is the signer whose key equals the account id, NOT merely
  // the first ed25519 signer (added co-signers are ed25519 too).
  const master = signers.find((s) => s.key === accountId);
  return {
    low: t.low_threshold,
    medium: t.med_threshold,
    high: t.high_threshold,
    masterWeight: master?.weight ?? 0,
  };
}

function parseFlags(f: Horizon.HorizonApi.Flags): AuditFlags {
  return {
    authImmutable: f.auth_immutable,
    authRequired: f.auth_required,
    authRevocable: f.auth_revocable,
    authClawbackEnabled: f.auth_clawback_enabled,
  };
}

function parseData(data: Record<string, string>): readonly DataEntry[] {
  return Object.entries(data).map(([name, value]) => ({ name, value }));
}

async function loadOffers(
  server: Horizon.Server,
  publicKey: string,
): Promise<readonly OfferEntry[]> {
  const out: OfferEntry[] = [];
  let page = await server.offers().forAccount(publicKey).limit(200).call();
  while (page.records.length > 0) {
    for (const o of page.records) {
      out.push({
        id: o.id.toString(),
        selling: serverAssetToIdentifier(o.selling),
        buying: serverAssetToIdentifier(o.buying),
        amount: o.amount,
        priceR: { n: o.price_r.n, d: o.price_r.d },
        ...(o.sponsor !== undefined ? { sponsor: o.sponsor } : {}),
      });
    }
    if (page.records.length < 200) break;
    page = await page.next();
  }
  return out;
}

async function loadClaimableBalances(
  server: Horizon.Server,
  publicKey: string,
): Promise<readonly ClaimableBalanceEntry[]> {
  const out: ClaimableBalanceEntry[] = [];
  let page = await server.claimableBalances().claimant(publicKey).limit(200).call();
  while (page.records.length > 0) {
    for (const c of page.records) {
      out.push({
        id: c.id,
        asset: serverAssetStringToIdentifier(c.asset),
        amount: c.amount,
        sponsor: c.sponsor ?? "",
        predicate: c.claimants,
        claimants: c.claimants.map((cl) => cl.destination),
      });
    }
    if (page.records.length < 200) break;
    page = await page.next();
  }
  return out;
}

async function loadPoolShares(
  server: Horizon.Server,
  balances: readonly AuditBalance[],
): Promise<readonly PoolShareEntry[]> {
  const poolBalances = balances.filter(
    (b): b is AuditBalance & { asset: { kind: "liquidity_pool_shares"; poolId: string } } =>
      b.asset.kind === "liquidity_pool_shares",
  );
  if (poolBalances.length === 0) return [];

  // fetch every pool's details in parallel: a single flaky pool no longer blocks
  // the others sequentially. If any fail we still throw (pool reserves are needed
  // to build a safe withdraw), but with ONE aggregated, pool-named error instead
  // of aborting on whichever happened to be first.
  const settled = await Promise.allSettled(
    poolBalances.map(async (pb): Promise<PoolShareEntry> => {
      const pool = await server.liquidityPools().liquidityPoolId(pb.asset.poolId).call();
      return {
        poolId: pb.asset.poolId,
        poolType: pool.type,
        shareBalance: pb.amount,
        totalShares: pool.total_shares,
        shareLimit: pb.limit ?? "0",
        fee: pool.fee_bp,
        reserves: pool.reserves.map((r) => ({
          asset: serverAssetStringToIdentifier(r.asset),
          amount: r.amount,
        })),
      };
    }),
  );
  const failures = settled
    .map((r, i) => (r.status === "rejected" ? poolBalances[i]!.asset.poolId : null))
    .filter((id): id is string => id !== null);
  if (failures.length > 0) {
    throw new Error(`Failed to load liquidity pool details for: ${failures.join(", ")}`);
  }
  return settled.map((r) => (r as PromiseFulfilledResult<PoolShareEntry>).value);
}

// horizon serializes assets either as an object or as "CODE:ISSUER"/"native"
function serverAssetToIdentifier(asset: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): AssetIdentifier {
  if (asset.asset_type === "native") return { kind: "native" };
  return {
    kind: "credit",
    code: asset.asset_code ?? "",
    issuer: asset.asset_issuer ?? "",
  };
}

function serverAssetStringToIdentifier(asset: string): AssetIdentifier {
  if (asset === "native") return { kind: "native" };
  const parts = asset.split(":");
  return { kind: "credit", code: parts[0] ?? "", issuer: parts[1] ?? "" };
}

// account_merge and set_options (clearing signers / resetting thresholds) are
// HIGH-threshold operations. The connected master key can complete the merge on
// its own only if its weight meets the high threshold; otherwise additional
// signers are required and the merge must go through multisig coordination.
export function computeRequiresMultisig(thresholds: AuditThresholds): boolean {
  const { masterWeight, high } = thresholds;
  return masterWeight === 0 || masterWeight < high;
}

// count of the account's OWN self-sponsored entries the demolition will release
// on close. Only claimable self-sponsored CBs count (unclaimable ones aren't
// released). num_sponsoring beyond this is foreign sponsorship that blocks.
export function computeCoverableSponsorships(
  accountId: string,
  entries: {
    readonly balances: readonly AuditBalance[];
    readonly offers: readonly OfferEntry[];
    readonly signers: readonly AuditSigner[];
    readonly claimableBalances: readonly ClaimableBalanceEntry[];
    readonly data: readonly DataEntry[];
  },
): number {
  // horizon's account record carries no per-data-entry sponsor field, so we
  // can't tell which data entries are self-sponsored. The demolition deletes
  // every data entry on close, releasing any self-sponsorship they carry, so
  // count them all as coverable. The Math.min clamp against num_sponsoring at
  // the call site absorbs any overcount from non-self-sponsored data entries.
  return (
    entries.balances.filter((b) => b.sponsor === accountId).length +
    entries.offers.filter((o) => o.sponsor === accountId).length +
    entries.signers.filter((s) => s.sponsor === accountId).length +
    entries.claimableBalances.filter((cb) => cb.sponsor === accountId && cb.claimableNow).length +
    entries.data.length
  );
}

export function computeMergeability(flags: AuditFlags, sponsorship: SponsorshipInfo): Mergeability {
  if (flags.authImmutable) {
    return { mergeable: false, reason: "AUTH_IMMUTABLE" };
  }
  // only FOREIGN sponsorships block: the account's self-sponsored entries are
  // released automatically when the demolition removes/claims them.
  const foreign = sponsorship.numSponsoring - sponsorship.coverable;
  if (foreign > 0) {
    return {
      mergeable: false,
      reason: "IS_SPONSOR",
      detail: `Account sponsors ${foreign} ledger ${
        foreign === 1 ? "entry" : "entries"
      } for other accounts that must be resolved before it can be merged.`,
    };
  }
  return { mergeable: true };
}
