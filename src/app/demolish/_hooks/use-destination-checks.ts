"use client";

import { useEffect, useMemo, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { requireMemoEnforcement, validateMemoFormat } from "@/lib/safety/cex-registry";
import { checkDestination } from "@/lib/stellar/destination";

import { G_ADDRESS, parseMemo, type FormState } from "../_lib/form";

export interface Gate {
  readonly ready: boolean;
  readonly hint: string | null;
}

// what the destination read found, for the address and network it was made for
export type DestinationState =
  | { readonly state: "checking" }
  | { readonly state: "exists"; readonly sep29MemoRequired: boolean }
  | { readonly state: "missing" }
  | { readonly state: "error"; readonly message: string };

// an unreadable destination is checked again after this long
export const DESTINATION_RECHECK_MS = 5_000;

export function useDestinationChecks(
  form: FormState,
  publicKey: string | null,
  network: NetworkConfig,
): {
  readonly destinationGate: Gate;
  readonly destExistsGate: Gate;
  readonly memoGate: Gate;
  // the SEP-29 flag of the destination on screen; null until it has been read
  readonly sep29MemoRequired: boolean | null;
} {
  // gate the "Build & simulate" button on a usable destination so the user gets
  // immediate feedback instead of being able to proceed and only then hit an
  // error. Empty is left hint-free (self-evident); a bad or self address is
  // explained inline. (onStart still re-validates as the authoritative check.)
  const destinationGate = useMemo<Gate>(() => {
    const trimmed = form.destination.trim();
    if (trimmed.length === 0) return { ready: false, hint: null };
    if (!G_ADDRESS.safeParse(trimmed).success) {
      return { ready: false, hint: "That isn't a valid Stellar G… address." };
    }
    if (trimmed === publicKey) {
      return {
        ready: false,
        hint: "Destination can't be your own account, the network rejects a self-merge.",
      };
    }
    return { ready: true, hint: null };
  }, [form.destination, publicKey]);

  // the destination is read up front. ACCOUNT_MERGE (and, on the exchange path,
  // the mediator's forward payment) fails if it doesn't exist, and that only
  // surfaces at the final, irreversible step after the DeFi exits ran. Its SEP-29
  // flag decides whether the close needs a memo and the mediator, so an
  // unreadable destination blocks too: it is neither confirmed present nor
  // confirmed free of a memo requirement. Debounced, and keyed to the address
  // and network so a stale in-flight result can't leak onto a newer one.
  const [destCheck, setDestCheck] = useState<{
    readonly addr: string;
    readonly net: string;
    readonly result: DestinationState;
  } | null>(null);
  // bumps to read an unreadable destination again
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const trimmed = form.destination.trim();
    // invalid / self address: destinationGate owns the gate. Every setDestCheck
    // runs inside the debounce timer or the async resolution, never in the body.
    if (!G_ADDRESS.safeParse(trimmed).success || trimmed === publicKey) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setDestCheck({ addr: trimmed, net: network.id, result: { state: "checking" } });
      checkDestination(trimmed, network)
        .then((result) => {
          if (!cancelled) setDestCheck({ addr: trimmed, net: network.id, result });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setDestCheck({
            addr: trimmed,
            net: network.id,
            result: { state: "error", message: errorMessage(err) },
          });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.destination, publicKey, network, attempt]);

  const current: DestinationState | null = (() => {
    const trimmed = form.destination.trim();
    if (destCheck === null || destCheck.addr !== trimmed || destCheck.net !== network.id) {
      return null;
    }
    return destCheck.result;
  })();

  const failed = current?.state === "error";
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), DESTINATION_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [failed]);

  const destExistsGate = useMemo<Gate>(() => {
    const trimmed = form.destination.trim();
    // defer to destinationGate until the address is well-formed and not self
    if (!G_ADDRESS.safeParse(trimmed).success || trimmed === publicKey) {
      return { ready: true, hint: null };
    }
    if (current === null || current.state === "checking") {
      return { ready: false, hint: "Checking the destination account…" };
    }
    if (current.state === "missing") {
      return {
        ready: false,
        hint: "This destination account doesn't exist on the network yet. A close merges into it, which needs an existing, funded account. Fund it first, or use a different address.",
      };
    }
    if (current.state === "error") {
      return {
        ready: false,
        hint: `We couldn't read the destination account (${current.message}), so we can't tell whether it needs a memo. Checking again shortly.`,
      };
    }
    return { ready: true, hint: null };
  }, [form.destination, publicKey, current]);

  const sep29MemoRequired = current?.state === "exists" ? current.sep29MemoRequired : null;

  // gate the Continue CTA on a required memo (a registry exchange, or a SEP-29
  // flag on the destination) and a well-formed memo value, so the requirement
  // shows inline. Reuses the exact checks onStart runs, so the gate and the
  // submit path can never disagree. Only engages once the destination itself is
  // valid; until then destinationGate owns the hint.
  const memoGate = useMemo<Gate>(() => {
    const trimmed = form.destination.trim();
    if (!G_ADDRESS.safeParse(trimmed).success) return { ready: true, hint: null };
    const memo = parseMemo(form);
    if (memo !== undefined) {
      const formatError = validateMemoFormat(memo.type, memo.value);
      if (formatError !== null) return { ready: false, hint: formatError };
    }
    const check = requireMemoEnforcement(trimmed, memo, {
      sep29MemoRequired: sep29MemoRequired === true,
    });
    if (!check.ok) return { ready: false, hint: check.reason };
    return { ready: true, hint: null };
  }, [form, sep29MemoRequired]);

  return { destinationGate, destExistsGate, memoGate, sep29MemoRequired };
}
