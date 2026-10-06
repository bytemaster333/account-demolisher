"use client";

import { useEffect, useMemo, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { requireMemoEnforcement, validateMemoFormat } from "@/lib/safety/cex-registry";
import { getHorizon } from "@/lib/stellar/horizon-client";

import { G_ADDRESS, parseMemo, type FormState } from "../_lib/form";

export interface Gate {
  readonly ready: boolean;
  readonly hint: string | null;
}

export function useDestinationChecks(
  form: FormState,
  publicKey: string | null,
  network: NetworkConfig,
): { readonly destinationGate: Gate; readonly destExistsGate: Gate; readonly memoGate: Gate } {
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

  // Existence check for the destination. ACCOUNT_MERGE (and, on the exchange path,
  // the mediator's forward payment) fails if the destination account does not
  // exist on-chain, and that failure only surfaces at the final, irreversible step
  // AFTER the DeFi exits have already run. So verify up-front that the destination
  // exists and block the close until it does, instead of failing late. Debounced,
  // and keyed to the address so a stale in-flight result can't leak onto a newer
  // one. A transient (non-404) read error does not hard-block (the merge would
  // still fail loudly); only a confirmed "missing" (404) blocks.
  const [destCheck, setDestCheck] = useState<{
    addr: string;
    net: string;
    state: "checking" | "exists" | "missing" | "error";
  } | null>(null);
  useEffect(() => {
    const trimmed = form.destination.trim();
    // invalid / self address: destinationGate owns the gate; leave destCheck as
    // is (destExistsGate defers to destinationGate for these). Setting state
    // synchronously in an effect body is a cascading-render smell, so every
    // setDestCheck below runs inside the debounce timer / async resolution.
    if (!G_ADDRESS.safeParse(trimmed).success || trimmed === publicKey) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setDestCheck({ addr: trimmed, net: network.id, state: "checking" });
      void getHorizon(network)
        .loadAccount(trimmed)
        .then(() => {
          if (!cancelled) setDestCheck({ addr: trimmed, net: network.id, state: "exists" });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const e = err as { response?: { status?: number }; name?: string; message?: string };
          const notFound =
            e?.response?.status === 404 ||
            e?.name === "NotFoundError" ||
            /404|not[_ ]?found|resource missing/i.test(e?.message ?? "");
          setDestCheck({ addr: trimmed, net: network.id, state: notFound ? "missing" : "error" });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.destination, publicKey, network]);

  const destExistsGate = useMemo<Gate>(() => {
    const trimmed = form.destination.trim();
    // defer to destinationGate until the address is well-formed and not self
    if (!G_ADDRESS.safeParse(trimmed).success || trimmed === publicKey) {
      return { ready: true, hint: null };
    }
    if (
      !destCheck ||
      destCheck.addr !== trimmed ||
      destCheck.net !== network.id ||
      destCheck.state === "checking"
    ) {
      return { ready: false, hint: "Checking the destination account…" };
    }
    if (destCheck.state === "missing") {
      return {
        ready: false,
        hint: "This destination account doesn't exist on the network yet. A close merges into it, which needs an existing, funded account. Fund it first, or use a different address.",
      };
    }
    return { ready: true, hint: null };
  }, [form.destination, publicKey, destCheck, network.id]);

  // gate the Continue CTA on a required exchange memo (and a well-formed memo
  // value), so the requirement shows inline instead of bouncing the user back
  // after they press Continue. Reuses the exact checks onStart runs
  // (validateMemoFormat + requireMemoEnforcement) so the gate and the submit path
  // can never disagree. Only engages once the destination itself is valid; until
  // then destinationGate owns the hint.
  const memoGate = useMemo<Gate>(() => {
    const trimmed = form.destination.trim();
    if (!G_ADDRESS.safeParse(trimmed).success) return { ready: true, hint: null };
    const memo = parseMemo(form);
    if (memo !== undefined) {
      const formatError = validateMemoFormat(memo.type, memo.value);
      if (formatError !== null) return { ready: false, hint: formatError };
    }
    const check = requireMemoEnforcement(trimmed, memo);
    if (!check.ok) return { ready: false, hint: check.reason };
    return { ready: true, hint: null };
  }, [form]);

  return { destinationGate, destExistsGate, memoGate };
}
