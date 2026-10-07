// recovery records for mediator forwards. a close to an exchange merges the
// account into an ephemeral mediator and then forwards the balance out of it; if
// the page dies between the two, this record (the mediator, its flow token and
// the committed destination and memo) is what lets the user finish the forward.
//
// one record per flow, keyed by network, account and mediator, so a later close
// never overwrites or clears another close's record. a record only goes away
// when the chain shows its forward was delivered, when the user dismisses one
// whose merge never happened, or when it names a network this build does not
// serve. earlier builds also ran forwards on futurenet, but a futurenet mediator
// can only ever have held test lumens.
//
// the flow token is a bearer credential in localStorage. anyone who can read it
// can only get a forward co-signed to the destination and memo bound into it;
// script running in this page could just as well mint its own flow, so storing
// it here adds no exposure beyond what a compromised page already has.

import { parseNetworkId, type NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
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
import { isMediatorNetworkId } from "@/lib/mediator/forward-terms";
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
      `Could not ${action} the exchange-forward recovery record in browser storage: ${errorMessage(cause)}`,
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

// the network a record belongs to, or null when it names one the mediator does
// not serve. never guessed: resuming on another network would sign for nothing.
export function pendingForwardNetwork(pending: {
  readonly networkId: string;
}): NetworkConfig | null {
  return isMediatorNetworkId(pending.networkId) ? parseNetworkId(pending.networkId) : null;
}

interface ParsedMap {
  readonly map: RecordMap;
  // a record was left out on purpose (a network this build does not serve)
  readonly dropped: boolean;
  // some of the stored text could not be read as records
  readonly unreadable: boolean;
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function parseMap(raw: string | null): ParsedMap {
  if (raw === null) return { map: {}, dropped: false, unreadable: false };
  const parsed = parseJson(raw);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    return { map: {}, dropped: false, unreadable: true };
  }
  const map: RecordMap = {};
  let dropped = false;
  let unreadable = false;
  for (const value of Object.values(parsed.value as Record<string, unknown>)) {
    if (!isPendingForward(value)) {
      unreadable = true;
      continue;
    }
    if (pendingForwardNetwork(value) === null) {
      // futurenet is no longer served and its mediators only ever held test
      // lumens; any other name is corrupt. neither can be resumed here.
      console.warn(
        `Dropping an exchange-forward recovery record for mediator ${value.mediatorPublicKey}: ` +
          `network "${value.networkId}" is not one the mediator serves.`,
      );
      dropped = true;
      continue;
    }
    map[keyOf(value)] = value;
  }
  return { map, dropped, unreadable };
}

// stored text that can't be read as records may still name a mediator holding
// someone's balance, so it is set aside under its own key, never just dropped
// by the next write
function keepUnreadable(raw: string, source: "map" | "single-slot"): void {
  const key = `${STORAGE_KEY}:unreadable:${source}:${String(Date.now())}`;
  try {
    window.localStorage.setItem(key, raw);
  } catch (err) {
    throw new PendingForwardStorageError("set aside unreadable data in", err);
  }
  console.warn(
    `Some exchange-forward recovery data in browser storage could not be read. ` +
      `It was kept unchanged under "${key}".`,
  );
}

// read every record, folding in a record from the single-slot layout earlier
// builds wrote. such a record carries a flow token those builds minted, which
// the routes no longer accept (see isLegacyFlowToken).
function readAll(): RecordMap {
  let raw: string | null;
  let legacyRaw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    throw new PendingForwardStorageError("read", err);
  }
  const { map, dropped, unreadable } = parseMap(raw);
  if (legacyRaw === null && !dropped && !unreadable) return map;
  if (unreadable && raw !== null) keepUnreadable(raw, "map");
  if (legacyRaw !== null) {
    const parsed = parseJson(legacyRaw);
    const legacy = parsed.ok ? parsed.value : null;
    if (!isPendingForward(legacy)) {
      keepUnreadable(legacyRaw, "single-slot");
    } else if (pendingForwardNetwork(legacy) === null) {
      console.warn(
        `Dropping an exchange-forward recovery record for mediator ${legacy.mediatorPublicKey}: ` +
          `network "${legacy.networkId}" is not one the mediator serves.`,
      );
    } else if (map[keyOf(legacy)] === undefined) {
      map[keyOf(legacy)] = legacy;
    }
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    throw new PendingForwardStorageError("migrate", err);
  }
  return map;
}

// flow tokens minted before the memo and network were bound into them had four
// parts (nonce.expiry.destination.mac). the routes refuse them, and renewing
// one would let whoever holds it pick the memo, so the app can't finish such a
// forward. the operator can: the nonce (the first part) and MEDIATOR_SECRET
// derive the mediator key.
export function isLegacyFlowToken(flowToken: string): boolean {
  const parts = flowToken.split(".");
  return parts.length === 4 && /^[0-9a-f]{32}$/u.test(parts[0] ?? "");
}

export function legacyFlowId(flowToken: string): string | null {
  return isLegacyFlowToken(flowToken) ? (flowToken.split(".")[0] ?? null) : null;
}

function writeAll(map: RecordMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (err) {
    throw new PendingForwardStorageError("save", err);
  }
  window.dispatchEvent(new Event(PENDING_FORWARDS_CHANGED_EVENT));
}

// add or update this flow's record. throws PendingForwardStorageError when it
// can't be stored: a mediator close must not start without its recovery record.
export function savePendingForward(forward: PendingMediatorForward): void {
  if (pendingForwardNetwork(forward) === null) {
    throw new PendingForwardStorageError(
      "save",
      new Error(`network "${forward.networkId}" is not one the mediator serves`),
    );
  }
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

// the record the account's most recent exchange close on this network saved,
// or null. a close that is retried looks here for the mediator it already
// minted (and possibly funded) instead of starting over.
export function latestPendingForward(
  publicKey: string,
  networkId: string,
): PendingMediatorForward | null {
  const own = loadPendingForwards(publicKey).filter((r) => r.networkId === networkId);
  return own.at(-1) ?? null;
}

export function removePendingForward(target: PendingForwardKey): void {
  const map = readAll();
  if (map[keyOf(target)] === undefined) return;
  delete map[keyOf(target)];
  writeAll(map);
}

// removes exactly the named flow's record. without a target it removes nothing:
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

// decide from horizon what a record stands for. throws when horizon can't be read.
export async function inspectPendingForward(
  pending: PendingMediatorForward,
): Promise<PendingForwardStatus> {
  const network = pendingForwardNetwork(pending);
  if (network === null) {
    throw new Error(`The recovery record names an unknown network "${pending.networkId}".`);
  }
  const server = horizonFor(network);
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

// finish a persisted forward. the forward itself waits for the merge to show,
// renews an expired token and recognises a forward that already landed. the
// record is dropped once delivered, and updated when the token was renewed.
export async function resumePendingForward(
  pending: PendingMediatorForward,
  deps: MediatorForwardDeps = {},
): Promise<MediatorForwardResult> {
  const network = pendingForwardNetwork(pending);
  if (network === null) {
    return {
      ok: false,
      error: `The recovery record names an unknown network "${pending.networkId}".`,
      flowToken: pending.flowToken,
    };
  }
  const legacyId = legacyFlowId(pending.flowToken);
  if (legacyId !== null) {
    return {
      ok: false,
      error:
        "This record was saved by an earlier version of the app, whose flow token can no longer " +
        `be renewed. Contact the operator with the temporary account ${pending.mediatorPublicKey} ` +
        `and flow id ${legacyId} to have the forward finished.`,
      flowToken: pending.flowToken,
    };
  }
  const result = await submitMediatorForward(
    {
      mediatorPublicKey: pending.mediatorPublicKey,
      flowToken: pending.flowToken,
      destination: pending.ultimateDestination,
      network,
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

// a close holds this lock for its account while it runs, so other tabs can tell
// a record that belongs to a running close from an abandoned one. web locks are
// in every current browser; where they are missing the close runs unlocked and
// other tabs simply can't see that it is running.
function closeLockName(publicKey: string): string {
  return `account-demolisher:close:${publicKey}`;
}

function lockManager(): LockManager | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as { readonly locks?: LockManager | null }).locks ?? null;
}

// waits for the lock when another close holds it. a close should use
// tryRunWithCloseLock instead, since a lock wait can't be stopped.
export async function runWithCloseLock<T>(publicKey: string, run: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (locks === null) return run();
  return locks.request(closeLockName(publicKey), { mode: "exclusive" }, run);
}

export type CloseLockAttempt<T> =
  | { readonly ran: true; readonly value: T }
  // another close for this account holds the lock; run was not called
  | { readonly ran: false };

// takes the lock only if it is free right now, in the same step as the check,
// so a close another tab starts after an isCloseInFlight check can't leave this
// one waiting on the lock with no word to the user
export async function tryRunWithCloseLock<T>(
  publicKey: string,
  run: () => Promise<T>,
): Promise<CloseLockAttempt<T>> {
  const locks = lockManager();
  if (locks === null) return { ran: true, value: await run() };
  return locks.request(
    closeLockName(publicKey),
    { mode: "exclusive", ifAvailable: true },
    async (lock): Promise<CloseLockAttempt<T>> =>
      lock === null ? { ran: false } : { ran: true, value: await run() },
  );
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
