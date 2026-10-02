import { Horizon } from "@stellar/stellar-sdk";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { filterClaimableNow } from "@/lib/stellar/claimable-balances";
import {
  DEFAULT_TX_VALIDITY_SECONDS,
  fetchLedgerClock,
  type LedgerClock,
} from "@/lib/stellar/ledger-clock";
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

// the audit plus the ledger it was evaluated against, so later checks (merge
// sequence ceiling, transaction time bounds) use the same network clock
export interface AccountAuditResult extends AccountAudit {
  readonly ledger: LedgerClock;
}

export interface AuditOptions {
  // how long the transaction that claims balances stays valid. a balance is only
  // marked claimable when it stays claimable for this whole window
  readonly claimWindowSeconds?: number;
}

// read-only audit of a classic stellar account. no caching. every call
// re-reads horizon
export async function auditAccount(
  publicKey: string,
  network: NetworkConfig,
  options: AuditOptions = {},
): Promise<AccountAuditResult> {
  const server = getHorizon(network);

  let account: Horizon.AccountResponse;
  let ledger: LedgerClock;
  try {
    [account, ledger] = await Promise.all([
      server.loadAccount(publicKey),
      fetchLedgerClock(network),
    ]);
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

  // mark which CBs this account can claim, judged on the ledger clock and kept
  // claimable for the whole signing window, so the UI and the batcher never
  // attempt a claim that fails on chain (and, if self-sponsored, would leave the
  // merge blocked).
  const claimableIds = new Set(
    filterClaimableNow(
      rawClaimableBalances,
      publicKey,
      new Date(ledger.closedAt * 1000),
      options.claimWindowSeconds ?? DEFAULT_TX_VALIDITY_SECONDS,
    ).map((c) => c.id),
  );
  const claimableBalances: readonly ClaimableBalanceEntry[] = rawClaimableBalances.map((cb) => ({
    ...cb,
    claimableNow: claimableIds.has(cb.id),
  }));

  // the only sponsorships the close releases itself are claimable balances this
  // account created with itself as a claimant. everything else in num_sponsoring
  // is a reserve it pays for another account's entry, which blocks the merge
  // until the user resolves it. this counts every claimable one; the user's
  // actual claim selection is applied in assessMergeability.
  const accountId = account.account_id;
  const coverableSponsorships = computeCoverableSponsorships(accountId, claimableBalances);

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
    ledger,
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

// the master key alone can run the close only if its weight meets every
// threshold the close touches: account_merge and set_options are high, path
// payments, payments, change_trust and offers are medium, claims are low. the
// three thresholds are independent, so medium or low can sit above high.
export function computeRequiresMultisig(thresholds: AuditThresholds): boolean {
  const { masterWeight, low, medium, high } = thresholds;
  return masterWeight === 0 || masterWeight < Math.max(low, medium, high);
}

// sponsorships the close releases on its own. an account cannot sponsor its own
// trustlines, offers, signers or data entries (begin_sponsoring with itself as
// the sponsored id is op_malformed), so the only entries in num_sponsoring the
// close frees are claimable balances this account created with itself as a
// claimant, and only those it can claim and actually claims. claimableBalanceIds
// is the user's claim selection with the batcher's meaning: undefined claims
// every claimable balance.
export function computeCoverableSponsorships(
  accountId: string,
  claimableBalances: readonly ClaimableBalanceEntry[],
  claimableBalanceIds?: readonly string[],
): number {
  const selected = claimableBalanceIds === undefined ? null : new Set(claimableBalanceIds);
  return claimableBalances.filter(
    (cb) =>
      cb.sponsor === accountId &&
      cb.claimableNow === true &&
      (selected === null || selected.has(cb.id)),
  ).length;
}

// flag and sponsorship check stored on the audit record, assuming every
// claimable balance is claimed. assessMergeability is the full pre-merge check.
export function computeMergeability(flags: AuditFlags, sponsorship: SponsorshipInfo): Mergeability {
  if (flags.authImmutable) {
    return { mergeable: false, reason: "AUTH_IMMUTABLE" };
  }
  const foreign = sponsorship.numSponsoring - sponsorship.coverable;
  if (foreign > 0) {
    return { mergeable: false, reason: "IS_SPONSOR", detail: foreignSponsorDetail(foreign) };
  }
  return { mergeable: true };
}

function foreignSponsorDetail(foreign: number): string {
  return `Account sponsors ${foreign} ledger ${
    foreign === 1 ? "entry" : "entries"
  } for other accounts that must be resolved before it can be merged.`;
}

export type MergeBlockReason =
  "AUTH_IMMUTABLE" | "IS_SPONSOR" | "FROZEN_TRUSTLINE" | "SEQNUM_TOO_FAR";

export type MergeAssessment =
  | { readonly mergeable: true }
  | { readonly mergeable: false; readonly reason: MergeBlockReason; readonly detail: string };

export interface MergeAssessmentOptions {
  // the ledger the audit was read against (AccountAuditResult.ledger)
  readonly ledger: LedgerClock;
  // the user's claim selection; undefined claims every claimable balance
  readonly claimableBalanceIds?: readonly string[];
  // classic transactions this account submits up to and including the one that
  // carries account_merge. each consumes one sequence number.
  readonly transactionsBeforeMerge: number;
}

// a positive credit balance on a trustline the issuer has deauthorized (or left
// authorized to maintain liabilities only) cannot be paid, path-paid or sent back
// to the issuer, and the trustline cannot be removed while it holds a balance
export function isFrozenBalance(balance: AuditBalance): boolean {
  return (
    balance.asset.kind === "credit" && balance.isAuthorized === false && isPositive(balance.amount)
  );
}

// the full pre-merge check, run at preview and again on a fresh audit right
// before the merge is signed. returns the first blocker in the order a user has
// to resolve them.
export function assessMergeability(
  audit: AccountAudit,
  options: MergeAssessmentOptions,
): MergeAssessment {
  if (!Number.isInteger(options.transactionsBeforeMerge) || options.transactionsBeforeMerge < 1) {
    throw new RangeError(
      `assessMergeability: transactionsBeforeMerge must be a positive integer; got ${options.transactionsBeforeMerge}`,
    );
  }
  if (audit.flags.authImmutable) {
    return {
      mergeable: false,
      reason: "AUTH_IMMUTABLE",
      detail: "The account has AUTH_IMMUTABLE set, and the network never merges such an account.",
    };
  }

  const frozen = audit.balances.filter(isFrozenBalance);
  if (frozen.length > 0) {
    const names = frozen
      .map((b) =>
        b.asset.kind === "credit" ? `${b.amount} ${b.asset.code} (${b.asset.issuer})` : "",
      )
      .join(", ");
    return {
      mergeable: false,
      reason: "FROZEN_TRUSTLINE",
      detail:
        `Frozen by the issuer: ${names}. A frozen balance cannot be sent or returned, and its ` +
        `trustline cannot be removed. Ask the issuer to unfreeze it or claw it back.`,
    };
  }

  const coverable = Math.min(
    computeCoverableSponsorships(
      audit.accountId,
      audit.claimableBalances,
      options.claimableBalanceIds,
    ),
    audit.sponsorship.numSponsoring,
  );
  const foreign = audit.sponsorship.numSponsoring - coverable;
  if (foreign > 0) {
    return { mergeable: false, reason: "IS_SPONSOR", detail: foreignSponsorDetail(foreign) };
  }

  // core refuses account_merge with ACCOUNT_MERGE_SEQNUM_TOO_FAR when the source
  // sequence, after the merge transaction consumed its own number, is at or above
  // (applying ledger << 32). the merge applies in a ledger after the latest
  // closed one, so latest + 1 is the lowest ledger it can land in.
  const seqAtMerge = BigInt(audit.sequence) + BigInt(options.transactionsBeforeMerge);
  const firstApplyLedger = BigInt(options.ledger.sequence) + 1n;
  if (seqAtMerge >= firstApplyLedger << 32n) {
    const mergeableFrom = (seqAtMerge >> 32n) + 1n;
    const wait = mergeableFrom - firstApplyLedger;
    return {
      mergeable: false,
      reason: "SEQNUM_TOO_FAR",
      detail:
        `The account's sequence number was bumped ahead of the network, which refuses to ` +
        `merge it before ledger ${mergeableFrom} (${wait} ledgers from now, ` +
        `${describeLedgerWait(wait)}).`,
    };
  }

  return { mergeable: true };
}

// ledgers close about every 5 to 6 seconds, so this is a rough estimate only
function describeLedgerWait(ledgers: bigint): string {
  const hours = (ledgers * 6n) / 3600n;
  if (hours < 1n) return "under an hour at about 6 seconds per ledger";
  if (hours < 48n) return `roughly ${hours} hours at about 6 seconds per ledger`;
  return `roughly ${hours / 24n} days at about 6 seconds per ledger`;
}

function isPositive(amount: string): boolean {
  for (const ch of amount) if (ch >= "1" && ch <= "9") return true;
  return false;
}
