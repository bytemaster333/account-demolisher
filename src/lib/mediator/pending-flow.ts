// Recovery records for mediator forwards. A close to an exchange merges the
// account into an ephemeral mediator and then forwards the balance out of it; if
// the page dies between the two, this record (the mediator, its flow token and
// the committed destination and memo) is what lets the user finish the forward.
//
// One record per flow, keyed by network, account and mediator, so a later close
// never overwrites or clears another close's record. A record only goes away
// when the chain shows its forward was delivered, or when the user dismisses one
// whose merge never happened.
//
// The flow token is a bearer credential in localStorage. Anyone who can read it
// can only get a forward co-signed to the destination and memo bound into it;
// script running in this page could just as well mint its own flow, so storing
// it here adds no exposure beyond what a compromised page already has.

import { resolveNetwork } from "@/lib/config/networks";
import {
  horizonFor,
  loadMediatorAccount,
  nativeBalance,
  readMediatorHistory,
} from "@/lib/mediator/chain-state";
import {
  submitMediatorForward,
  type MediatorForwardDeps,
  type MediatorForwardResult,
} from "@/lib/mediator/forward";
import type { ClassicMemo } from "@/lib/types/plan";

export interface PendingMediatorForward {
  // the account being closed (owner of the flow); a record only surfaces when
  // this matches the connected wallet
  readonly publicKey: string;
  readonly mediatorPublicKey: string;
  readonly flowToken: string;
  readonly ultimateDestination: string;
  readonly memo?: ClassicMemo;
  readonly networkId: string;
  readonly savedAt: number;
}

export interface PendingForwardKey {
  readonly networkId: string;
  readonly publicKey: string;
  readonly mediatorPublicKey: string;
}

export class PendingForwardStorageError extends Error {
  constructor(action: string, cause: unknown) {
    super(
      `Could not ${action} the exchange-forward recovery record in browser storage: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "PendingForwardStorageError";
  }
}

const STORAGE_KEY = "account-demolisher:pending-mediator-forwards";
// the single-slot layout earlier builds wrote; folded into the map on first use
const LEGACY_STORAGE_KEY = "account-demolisher:pending-mediator-forward";

// fired on window whenever this tab changes the records; other tabs get the
// browser's own storage event
export const PENDING_FORWARDS_CHANGED_EVENT = "account-demolisher:pending-forwards-changed";

function keyOf(k: PendingForwardKey): string {
  return `${k.networkId}:${k.publicKey}:${k.mediatorPublicKey}`;
}

function isPendingForward(value: unknown): value is PendingMediatorForward {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.publicKey === "string" &&
    typeof v.mediatorPublicKey === "string" &&
    typeof v.flowToken === "string" &&
    typeof v.ultimateDestination === "string" &&
    typeof v.networkId === "string" &&
    typeof v.savedAt === "number"
  );
}

type RecordMap = Record<string, PendingMediatorForward>;

function parseMap(raw: string | null): RecordMap {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: RecordMap = {};
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (isPendingForward(value)) out[keyOf(value)] = value;
  }
  return out;
}

// read every record, folding in a legacy single-slot record so it is never lost
function readAll(): RecordMap {
  let raw: string | null;
  let legacyRaw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    throw new PendingForwardStorageError("read", err);
  }
  const map = parseMap(raw);
  if (legacyRaw === null) return map;
  let legacy: unknown = null;
  try {
    legacy = JSON.parse(legacyRaw);
  } catch {
    legacy = null;
  }
  if (isPendingForward(legacy) && map[keyOf(legacy)] === undefined) map[keyOf(legacy)] = legacy;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    throw new PendingForwardStorageError("migrate", err);
  }
  return map;
}

function writeAll(map: RecordMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    throw new PendingForwardStorageError("save", err);
  }
  window.dispatchEvent(new Event(PENDING_FORWARDS_CHANGED_EVENT));
}

// add or update this flow's record. Throws PendingForwardStorageError when it
// can't be stored: a mediator close must not start without its recovery record.
export function savePendingForward(forward: PendingMediatorForward): void {
  const map = readAll();
  map[keyOf(forward)] = forward;
  writeAll(map);
}

// every record for the connected account, oldest first, on any network
export function loadPendingForwards(publicKey: string): PendingMediatorForward[] {
  return Object.values(readAll())
    .filter((r) => r.publicKey === publicKey)
    .sort((a, b) => a.savedAt - b.savedAt);
}

export function removePendingForward(target: PendingForwardKey): void {
  const map = readAll();
  if (map[keyOf(target)] === undefined) return;
  delete map[keyOf(target)];
  writeAll(map);
}

// removes exactly the named flow's record. Without a target it removes nothing:
// a close that ran no forward has no business touching another close's record.
export function clearPendingForward(target?: PendingForwardKey): void {
  if (target !== undefined) removePendingForward(target);
}

export function subscribePendingForwards(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key === STORAGE_KEY || e.key === LEGACY_STORAGE_KEY) onChange();
  };
  window.addEventListener(PENDING_FORWARDS_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PENDING_FORWARDS_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export type PendingForwardStatus =
  // the account was merged into the mediator and the balance is still there
  | { readonly kind: "awaiting-forward" }
  // the forward already went out to the committed destination
  | { readonly kind: "delivered"; readonly txHash: string; readonly ledger: number }
  // the mediator was emptied somewhere else; should never happen with an honest server
  | { readonly kind: "misdirected"; readonly txHash: string; readonly into: string }
  // no merge of this account into the mediator; balance never moved. the mediator
  // may still hold funding from a multi-batch close that stopped early.
  | { readonly kind: "not-merged"; readonly mediatorBalance: string | null };

// decide from horizon what a record stands for. Throws when horizon can't be read.
export async function inspectPendingForward(
  pending: PendingMediatorForward,
): Promise<PendingForwardStatus> {
  const server = horizonFor(resolveNetwork(pending.networkId));
  const history = await readMediatorHistory(server, pending.mediatorPublicKey, pending.publicKey);
  if (history.mergedOut !== null) {
    return history.mergedOut.into === pending.ultimateDestination
      ? { kind: "delivered", txHash: history.mergedOut.txHash, ledger: history.mergedOut.ledger }
      : { kind: "misdirected", txHash: history.mergedOut.txHash, into: history.mergedOut.into };
  }
  if (history.mergeIn !== null) return { kind: "awaiting-forward" };
  const mediator = await loadMediatorAccount(server, pending.mediatorPublicKey);
  return {
    kind: "not-merged",
    mediatorBalance: mediator === null ? null : nativeBalance(mediator),
  };
}

// finish a persisted forward. The forward itself waits for the merge to show,
// renews an expired token and recognises a forward that already landed. The
// record is dropped once delivered, and updated when the token was renewed.
export async function resumePendingForward(
  pending: PendingMediatorForward,
  deps: MediatorForwardDeps = {},
): Promise<MediatorForwardResult> {
  const result = await submitMediatorForward(
    {
      mediatorPublicKey: pending.mediatorPublicKey,
      flowToken: pending.flowToken,
      destination: pending.ultimateDestination,
      network: resolveNetwork(pending.networkId),
      closedAccount: pending.publicKey,
      ...(pending.memo ? { memo: pending.memo } : {}),
    },
    deps,
  );
  if (result.ok) {
    removePendingForward(pending);
  } else if (result.flowToken !== pending.flowToken) {
    savePendingForward({ ...pending, flowToken: result.flowToken });
  }
  return result;
}

// A close holds this lock for its account while it runs, so other tabs can tell
// a record that belongs to a running close from an abandoned one. Web Locks are
// in every current browser; where they are missing the close runs unlocked and
// other tabs simply can't see that it is running.
function closeLockName(publicKey: string): string {
  return `account-demolisher:close:${publicKey}`;
}

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as { readonly locks?: LockManager | null }).locks ?? null;
}

export async function runWithCloseLock<T>(publicKey: string, run: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks === null) return run();
  return locks.request(closeLockName(publicKey), { mode: "exclusive" }, run);
}

export async function isCloseInFlight(publicKey: string): Promise<boolean> {
  const locks = lockManager();
  if (locks === null) return false;
  const state = await locks.query();
  return (state.held ?? []).some((l) => l.name === closeLockName(publicKey));
}

// resolves once no close for this account holds the lock
export async function waitForCloseIdle(publicKey: string, signal: AbortSignal): Promise<void> {
  const locks = lockManager();
  if (locks === null) return;
  await locks.request(closeLockName(publicKey), { mode: "shared", signal }, () => undefined);
}
