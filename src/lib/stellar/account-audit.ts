import { Horizon } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
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

// read-only audit of a classic stellar account. no caching — every call
// re-reads horizon.
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
  const thresholds = parseThresholds(account.thresholds, signers);
  const flags = parseFlags(account.flags);
  const sponsorship: SponsorshipInfo = {
    numSponsoring: account.num_sponsoring,
    numSponsored: account.num_sponsored,
    ...(account.sponsor !== undefined ? { sponsoredBy: account.sponsor } : {}),
  };
  const data = parseData(account.data_attr);

  const [offers, claimableBalances, poolShares] = await Promise.all([
    loadOffers(server, publicKey),
    loadClaimableBalances(server, publicKey),
    loadPoolShares(server, balances),
  ]);

  const requiresMultisig = computeRequiresMultisig(signers, thresholds);
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
    // lp shares have no buying/selling liabilities.
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
): AuditThresholds {
  const master = signers.find((s) => s.type === "ed25519_public_key");
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

  const out: PoolShareEntry[] = [];
  for (const pb of poolBalances) {
    const pool = await server.liquidityPools().liquidityPoolId(pb.asset.poolId).call();
    out.push({
      poolId: pb.asset.poolId,
      poolType: pool.type,
      shareBalance: pb.amount,
      shareLimit: pb.limit ?? "0",
      fee: pool.fee_bp,
      reserves: pool.reserves.map((r) => ({
        asset: serverAssetStringToIdentifier(r.asset),
        amount: r.amount,
      })),
    });
  }
  return out;
}

// horizon serializes assets either as an object or as "CODE:ISSUER"/"native".
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

function computeRequiresMultisig(
  signers: readonly AuditSigner[],
  thresholds: AuditThresholds,
): boolean {
  const masterWeight = thresholds.masterWeight;
  const nonMasterTotal = signers
    .filter((s) => (s.type !== "ed25519_public_key" || s.weight === 0 ? false : true))
    .filter((s) => s.weight > 0)
    .filter((s, _, arr) => arr.length > 1 || s.weight !== masterWeight)
    .reduce((sum, s) => sum + s.weight, 0);
  if (nonMasterTotal === 0) return false;
  return masterWeight < thresholds.high;
}

function computeMergeability(flags: AuditFlags, sponsorship: SponsorshipInfo): Mergeability {
  if (flags.authImmutable) {
    return { mergeable: false, reason: "AUTH_IMMUTABLE" };
  }
  if (sponsorship.numSponsoring > 0) {
    return {
      mergeable: false,
      reason: "IS_SPONSOR",
      detail: `Account sponsors ${sponsorship.numSponsoring} ledger entries for other accounts.`,
    };
  }
  return { mergeable: true };
}
