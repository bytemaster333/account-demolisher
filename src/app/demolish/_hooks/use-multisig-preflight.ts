"use client";

import { useCallback, useEffect, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { AccountNotFoundError, auditAccount } from "@/lib/stellar/account-audit";
import type { AuditSigner } from "@/lib/types/account";

export interface MultisigInfo {
  readonly required: boolean;
  readonly threshold: number;
  readonly signers: readonly AuditSigner[];
}

export type Preflight =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly info: MultisigInfo }
  | { readonly status: "error"; readonly message: string };

type Entry =
  | { readonly key: string; readonly status: "ready"; readonly info: MultisigInfo }
  | { readonly key: string; readonly status: "error"; readonly message: string };

// a read-only audit of the connected account at Configure, to learn whether it
// is shared before the plan is built. The result is keyed to the account and
// network it was read for, so a switch of either reads as loading again
// instead of reusing a stale answer, and a failure is reported, not swallowed.
export function useMultisigPreflight(
  publicKey: string | null,
  network: NetworkConfig,
): { readonly preflight: Preflight; readonly retry: () => void } {
  const key = publicKey === null ? null : `${publicKey}:${network.id}`;
  const [entry, setEntry] = useState<Entry | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (publicKey === null || key === null) return;
    let cancelled = false;
    auditAccount(publicKey, network)
      .then((a) => {
        if (cancelled) return;
        setEntry({
          key,
          status: "ready",
          info: { required: a.requiresMultisig, threshold: a.thresholds.high, signers: a.signers },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntry({
          key,
          status: "error",
          message:
            err instanceof AccountNotFoundError
              ? `this account has no record on ${network.id}. Check the network selector (top right) and that the account is funded there.`
              : errorMessage(err, "the account lookup failed."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey, network, key, attempt]);

  const retry = useCallback(() => {
    setEntry(null);
    setAttempt((n) => n + 1);
  }, []);

  let preflight: Preflight;
  if (key === null) preflight = { status: "idle" };
  else if (entry === null || entry.key !== key) preflight = { status: "loading" };
  else if (entry.status === "ready") preflight = { status: "ready", info: entry.info };
  else preflight = { status: "error", message: entry.message };
  return { preflight, retry };
}
