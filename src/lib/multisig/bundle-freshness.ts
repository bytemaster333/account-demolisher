// a bundled close is built from one snapshot of the account and then collects
// signatures for up to 72 hours. if the account changes meanwhile (another
// transaction bumps the sequence, someone sends a dust payment to a trustline
// the bundle removes, an offer fills, a signer is rotated, the destination
// drops a trustline the bundle pays into or merges away) the fully signed
// bundle fails on chain and everyone has to start over.
//
// this compares a bundle against the live account before anyone is asked for
// the final confirmation and again right before submit, and names every drift
// so the user can rebuild the request instead of submitting a doomed one.

import {
  LiquidityPoolAsset,
  NotFoundError,
  TransactionBuilder,
  extractBaseAddress,
  getLiquidityPoolId,
  type FeeBumpTransaction,
  type Horizon,
  type Keypair,
  type Transaction,
} from "@stellar/stellar-sdk";

import { CLOSE_MARKER_NAME } from "@/lib/metrics/close-marker";
import {
  decimalToStroops as toStroops,
  stroopsToDecimal as fromStroops,
} from "@/lib/stellar/amount";
import { shortAddress } from "@/lib/safe-display";

export interface SignerSnapshot {
  readonly signers: readonly { readonly key: string; readonly weight: number }[];
  readonly thresholds: { readonly low: number; readonly med: number; readonly high: number };
}

// a claimable balance the bundle claims, as Horizon reports it now
export interface LiveClaimableBalance {
  readonly id: string;
  // "native" or "CODE:ISSUER", Horizon's format
  readonly asset: string;
  readonly amount: string;
  // the account paying the balance's reserve. core counts it once per claimant
  // in the sponsor's num_sponsoring, and claiming the balance releases all of them
  readonly sponsor?: string;
  readonly claimants: number;
}

export interface FreshnessInput {
  readonly xdr: string;
  readonly passphrase: string;
  readonly account: Horizon.AccountResponse;
  // ids of the account's open offers right now
  readonly offerIds: readonly string[];
  // the claimable balances the bundle claims that still exist
  readonly claimableBalances: readonly LiveClaimableBalance[];
  // the signer set the relay checked signatures against, when there is one
  readonly snapshot?: SignerSnapshot;
  // the merge destination as Horizon reports it now, null when it doesn't exist.
  // a bundle without a merge has no destination to compare
  readonly destination: Horizon.AccountResponse | null;
  readonly nowMs?: number;
}

export type FreshnessResult =
  { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] };

interface AssetLike {
  isNative(): boolean;
  getCode(): string;
  getIssuer(): string;
}

interface RawOp {
  readonly type: string;
  readonly source?: string;
  readonly destination?: string;
  readonly amount?: string;
  readonly limit?: string;
  readonly offerId?: string;
  readonly name?: string;
  readonly value?: Uint8Array;
  readonly balanceId?: string;
  readonly asset?: AssetLike;
  readonly line?: AssetLike | LiquidityPoolAsset;
}

function assetKey(a: AssetLike): string {
  return a.isNative() ? "native" : `${a.getCode()}:${a.getIssuer()}`;
}

function lineKey(line: AssetLike | LiquidityPoolAsset): string {
  if (line instanceof LiquidityPoolAsset) {
    const id = getLiquidityPoolId("constant_product", line.getLiquidityPoolParameters());
    return `pool:${Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  return assetKey(line);
}

function balanceLineKey(b: Record<string, unknown>): string | null {
  if (b.asset_type === "native") return null;
  if (b.asset_type === "liquidity_pool_shares") return `pool:${String(b.liquidity_pool_id)}`;
  return `${String(b.asset_code)}:${String(b.asset_issuer)}`;
}

function label(key: string): string {
  if (key.startsWith("pool:")) return `pool share ${shortAddress(key.slice(5), 8, 0)}`;
  const [code, issuer] = key.split(":");
  return `${code} (${shortAddress(issuer ?? "")})`;
}

export function checkBundleFreshness(input: FreshnessInput): FreshnessResult {
  const reasons: string[] = [];
  const tx = TransactionBuilder.fromXdr(input.xdr, input.passphrase) as Transaction;
  const account = input.account;
  const closing = account.account_id;
  const ops = tx.operations as unknown as readonly RawOp[];
  const now = input.nowMs ?? Date.now();

  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (maxTime > 0 && maxTime * 1000 <= now) {
    reasons.push("The signed transaction has expired.");
  }

  if (BigInt(tx.sequence) !== BigInt(account.sequence) + 1n) {
    reasons.push(
      "The account's sequence number moved since the request was built (another transaction from this account landed), so the bundle can no longer be submitted.",
    );
  }

  if (input.snapshot !== undefined) {
    const live = account.signers
      .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
      .map((s) => `${s.key}:${s.weight}`)
      .sort();
    const stored = input.snapshot.signers.map((s) => `${s.key}:${s.weight}`).sort();
    const t = account.thresholds;
    const ts = input.snapshot.thresholds;
    if (live.join(",") !== stored.join(",")) {
      reasons.push(
        "The account's signers or their weights changed since the request was published.",
      );
    }
    if (t.low_threshold !== ts.low || t.med_threshold !== ts.med || t.high_threshold !== ts.high) {
      reasons.push("The account's signing thresholds changed since the request was published.");
    }
  }

  // what the bundle does to each trustline: amount paid out before removal,
  // amount claimed in, and whether the line is removed
  const paidOut = new Map<string, bigint>();
  const claimedIn = new Map<string, bigint>();
  const removed = new Set<string>();
  const cancelled = new Set<string>();
  const deleted = new Set<string>();
  // credit the bundle pays to each account, to find what the merge destination
  // has to be able to receive
  const sentTo = new Map<string, Map<string, bigint>>();
  let mergeDestination: string | undefined;
  // the close marker is set and then deleted, so the pair also removes an entry
  // of that name the account already holds
  let markerDeleted = false;
  const liveCbs = new Map(input.claimableBalances.map((c) => [c.id, c]));
  let releasedSponsoring = 0;

  for (const op of ops) {
    if ((op.source ?? tx.source) !== closing) continue;
    switch (op.type) {
      case "payment":
        if (op.asset && !op.asset.isNative() && op.amount) {
          const k = assetKey(op.asset);
          const amount = toStroops(op.amount);
          paidOut.set(k, (paidOut.get(k) ?? 0n) + amount);
          if (op.destination !== undefined) {
            const to = extractBaseAddress(op.destination);
            const sent = sentTo.get(to) ?? new Map<string, bigint>();
            sent.set(k, (sent.get(k) ?? 0n) + amount);
            sentTo.set(to, sent);
          }
        }
        break;
      case "accountMerge":
        if (op.destination !== undefined) mergeDestination = extractBaseAddress(op.destination);
        break;
      case "changeTrust":
        if (op.line && op.limit !== undefined && toStroops(op.limit) === 0n) {
          removed.add(lineKey(op.line));
        }
        break;
      case "manageSellOffer":
      case "manageBuyOffer":
        if (op.offerId !== undefined && op.offerId !== "0") cancelled.add(op.offerId);
        break;
      case "manageData":
        if (op.value === undefined && op.name === CLOSE_MARKER_NAME) markerDeleted = true;
        else if (op.value === undefined && op.name !== undefined) deleted.add(op.name);
        break;
      case "claimClaimableBalance": {
        const id = op.balanceId ?? "";
        const cb = liveCbs.get(id);
        if (cb === undefined) {
          reasons.push(
            `Claimable balance ${shortAddress(id, 12, 0)} no longer exists, so claiming it would fail.`,
          );
        } else {
          if (cb.asset !== "native") {
            claimedIn.set(cb.asset, (claimedIn.get(cb.asset) ?? 0n) + toStroops(cb.amount));
          }
          if (cb.sponsor === closing) releasedSponsoring += cb.claimants;
        }
        break;
      }
      default:
        break;
    }
  }

  if (mergeDestination !== undefined) {
    reasons.push(
      ...destinationDrift(
        mergeDestination,
        input.destination,
        sentTo.get(mergeDestination) ?? new Map(),
      ),
    );
  }

  const liveLines = new Map<string, bigint>();
  for (const b of account.balances as unknown as Record<string, unknown>[]) {
    const k = balanceLineKey(b);
    if (k !== null) liveLines.set(k, toStroops(String(b.balance)));
  }

  for (const [k, balance] of liveLines) {
    if (!removed.has(k)) {
      reasons.push(
        `The account now holds a ${label(k)} trustline the bundle doesn't remove, so the merge would fail.`,
      );
      continue;
    }
    const expected = balance + (claimedIn.get(k) ?? 0n);
    const paid = paidOut.get(k) ?? 0n;
    if (!k.startsWith("pool:") && expected !== paid) {
      reasons.push(
        `The ${label(k)} balance is now ${fromStroops(expected)} but the bundle pays out ${fromStroops(paid)}, so removing the trustline would fail.`,
      );
    }
    if (k.startsWith("pool:") && balance !== 0n) {
      reasons.push(`The account now holds ${label(k)} shares the bundle doesn't withdraw.`);
    }
  }
  for (const k of removed) {
    if (!liveLines.has(k)) {
      reasons.push(`The ${label(k)} trustline the bundle removes no longer exists.`);
    }
  }

  const liveOffers = new Set(input.offerIds);
  for (const id of liveOffers) {
    if (!cancelled.has(id)) reasons.push(`Offer ${id} is open but the bundle doesn't cancel it.`);
  }
  for (const id of cancelled) {
    if (!liveOffers.has(id)) {
      reasons.push(
        `Offer ${id} is no longer open (filled or cancelled), so cancelling it would fail.`,
      );
    }
  }

  const liveData = new Set(Object.keys(account.data_attr ?? {}));
  for (const name of liveData) {
    if (name === CLOSE_MARKER_NAME && markerDeleted) continue;
    if (!deleted.has(name))
      reasons.push(`Data entry "${name}" exists but the bundle doesn't delete it.`);
  }
  for (const name of deleted) {
    if (!liveData.has(name))
      reasons.push(`Data entry "${name}" no longer exists, so deleting it would fail.`);
  }

  // a reserve this account still pays for any entry makes the merge fail with
  // op_is_sponsor. an account can't sponsor its own subentries, so the only
  // sponsorships the bundle releases are the claimable balances it claims. the
  // others can appear without moving the sequence: a begin_sponsoring sandwich
  // sourced by this account inside another account's transaction.
  const unreleased = account.num_sponsoring - releasedSponsoring;
  if (unreleased > 0) {
    reasons.push(
      `The account now sponsors ${unreleased} ledger ${unreleased === 1 ? "entry" : "entries"} the bundle doesn't release, so the merge would fail.`,
    );
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// the merge destination is outside this account's control for the whole
// signing window. it can merge away (op_no_destination) or drop, lose
// authorization on or fill a trustline a residue payment needs, and each of
// those sinks the signed bundle
function destinationDrift(
  id: string,
  live: Horizon.AccountResponse | null,
  sent: ReadonlyMap<string, bigint>,
): string[] {
  if (live === null) {
    return [`The destination ${id} no longer exists, so the merge would fail.`];
  }
  const reasons: string[] = [];
  const lines = new Map<string, Record<string, unknown>>();
  for (const b of live.balances as unknown as Record<string, unknown>[]) {
    const k = balanceLineKey(b);
    if (k !== null) lines.set(k, b);
  }
  for (const [k, amount] of sent) {
    // a payment to the issuer burns the asset and needs no trustline
    if (k.split(":")[1] === id) continue;
    const line = lines.get(k);
    if (line === undefined) {
      reasons.push(`The destination no longer trusts ${label(k)}, so sending it would fail.`);
      continue;
    }
    if (line.is_authorized !== true) {
      reasons.push(
        `The destination's ${label(k)} trustline is no longer authorized, so sending it would fail.`,
      );
      continue;
    }
    const room =
      toStroops(String(line.limit)) -
      toStroops(String(line.balance)) -
      toStroops(String(line.buying_liabilities));
    if (room < amount) {
      const [code] = k.split(":");
      reasons.push(
        `The destination's ${label(k)} trustline now has room for ${fromStroops(room > 0n ? room : 0n)} ${code} but the bundle sends ${fromStroops(amount)}, so the payment would fail.`,
      );
    }
  }
  return reasons;
}

// load everything checkBundleFreshness needs from Horizon and run it
export async function loadBundleFreshness(
  horizon: Horizon.Server,
  xdr: string,
  passphrase: string,
  snapshot?: SignerSnapshot,
): Promise<FreshnessResult> {
  const tx = TransactionBuilder.fromXdr(xdr, passphrase) as Transaction;
  const merge = tx.operations.find((op) => op.type === "accountMerge");
  const closing = merge?.source ?? tx.source;
  const account = await horizon.loadAccount(closing);

  const offerIds: string[] = [];
  let page = await horizon.offers().forAccount(closing).limit(200).call();
  for (;;) {
    for (const o of page.records) offerIds.push(String(o.id));
    if (page.records.length < 200) break;
    page = await page.next();
  }

  const claimableBalances: LiveClaimableBalance[] = [];
  for (const op of tx.operations) {
    if (op.type !== "claimClaimableBalance") continue;
    try {
      const cb = await horizon.claimableBalances().claimableBalance(op.balanceId).call();
      claimableBalances.push({
        id: op.balanceId,
        asset: cb.asset,
        amount: cb.amount,
        ...(cb.sponsor !== undefined ? { sponsor: cb.sponsor } : {}),
        claimants: cb.claimants.length,
      });
    } catch (e) {
      // only a 404 means the balance is gone; anything else is a failed check
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  // read after the closing account, so a 404 for the closing account still
  // reaches the caller as an error and only the destination's becomes a reason
  let destination: Horizon.AccountResponse | null = null;
  if (merge !== undefined) {
    try {
      destination = await horizon.loadAccount(extractBaseAddress(merge.destination));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  return checkBundleFreshness({
    xdr,
    passphrase,
    account,
    offerIds,
    claimableBalances,
    destination,
    ...(snapshot ? { snapshot } : {}),
  });
}

// wrap a fully signed bundle in a fee bump paid by `feeSource`, for when Horizon
// answers tx_insufficient_fee. the inner signatures stay valid because the fee
// bump signs over a different payload; only the fee source has to sign it.
export function feeBumpBundle(
  innerXdr: string,
  passphrase: string,
  feeSource: Keypair | string,
  baseFeeStroops: string,
): FeeBumpTransaction {
  const inner = TransactionBuilder.fromXdr(innerXdr, passphrase) as Transaction;
  return TransactionBuilder.buildFeeBumpTransaction(feeSource, baseFeeStroops, inner, passphrase);
}
