// SEC-01 part B: durably persist an in-flight mediator forward so it survives a
// crash / reload in the window between the merge-into-mediator landing and the
// forward sweeping the balance back out. SEC-01 part A (execute-time re-mint)
// already removes the common stranding case (a slow review/execution outrunning
// the token TTL); this covers the rarer crash IN that window.
//
// Exposure trade-off: this writes the bearer flow token to localStorage. That is
// bounded by SEC-16 — the token HMAC-commits the destination, so even if read by
// an XSS the co-signer can only move THIS flow's funds to the destination the
// user already committed to. It is cleared the moment the forward confirms.
//
// The mediator forward type mirrors submitMediatorForward's memo shape.

import { resolveNetwork } from "@/lib/config/networks";
import { submitMediatorForward, type MediatorForwardResult } from "@/lib/mediator/forward";

export interface PendingMediatorForward {
  // the account being closed (owner of the flow); a pending forward only surfaces
  // when this matches the currently-connected wallet
  readonly publicKey: string;
  readonly mediatorPublicKey: string;
  readonly flowToken: string;
  readonly ultimateDestination: string;
  readonly memo?: { readonly type: "text" | "id" | "hash" | "return"; readonly value: string };
  readonly networkId: string;
  readonly savedAt: number;
}

const STORAGE_KEY = "account-demolisher:pending-mediator-forward";

export function savePendingForward(forward: PendingMediatorForward): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(forward));
  } catch {
    // storage disabled — the in-memory flow still completes normally; only
    // crash-recovery is unavailable, which is acceptable
  }
}

// Return a persisted pending forward, but ONLY for the given (connected) account,
// so one user can't be shown another's pending forward on a shared machine.
export function loadPendingForward(publicKey: string): PendingMediatorForward | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPendingForward(parsed) || parsed.publicKey !== publicKey) return null;
  return parsed;
}

export function clearPendingForward(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
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

// Resume a persisted forward after a crash/reload by re-submitting it with the
// stored token; clears the record on success. The token HMAC-binds the
// destination (SEC-16), so this can only sweep the flow's own funds to the
// destination the user already committed to.
export async function resumePendingForward(
  pending: PendingMediatorForward,
): Promise<MediatorForwardResult> {
  const network = resolveNetwork(pending.networkId);
  const result = await submitMediatorForward({
    mediatorPublicKey: pending.mediatorPublicKey,
    flowToken: pending.flowToken,
    destination: pending.ultimateDestination,
    network,
    ...(pending.memo ? { memo: pending.memo } : {}),
  });
  if (result.ok) clearPendingForward();
  return result;
}
