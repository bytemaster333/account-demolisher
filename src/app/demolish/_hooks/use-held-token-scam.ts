"use client";

import { useEffect, useMemo, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import {
  runHeldTokenScamHeuristics,
  type HeldTokenSubject,
  type ScamFinding,
} from "@/lib/safety/scam-heuristics";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import { getRpc } from "@/lib/soroban/rpc-client";
import { name as tokenName, symbol as tokenSymbol } from "@/lib/soroban/sep41";

export interface HeldTokenScam {
  // findings over the held tokens, with the symbol and name each contract reports
  readonly findings: readonly ScamFinding[];
  // true while the names are still being read
  readonly pending: boolean;
  // tokens whose symbol or name couldn't be read, with the reason; they are still
  // checked by contract id
  readonly unreadable: readonly string[];
  // set when the check itself failed, so none of the tokens was checked
  readonly error: string | null;
}

const NONE: HeldTokenScam = { findings: [], pending: false, unreadable: [], error: null };
const PENDING: HeldTokenScam = { findings: [], pending: true, unreadable: [], error: null };

// a standalone token's symbol and name are set by its own contract, so the
// look-alike, homoglyph and hidden-character checks have to see them. read once
// per discovery and network, so a rebuild after a failed check reads them again.
export function useHeldTokenScam(
  tokens: readonly HeldToken[],
  network: NetworkConfig,
  sourcePublicKey: string | null,
): HeldTokenScam {
  const ids = useMemo(() => [...new Set(tokens.map((t) => t.contractId))].sort(), [tokens]);
  const key = `${network.id}|${ids.join(",")}`;
  const [result, setResult] = useState<{
    readonly key: string;
    readonly tokens: readonly HeldToken[];
    readonly value: HeldTokenScam;
  } | null>(null);

  useEffect(() => {
    if (ids.length === 0 || sourcePublicKey === null) return;
    let cancelled = false;
    const read = async (id: string): Promise<{ subject: HeldTokenSubject; error?: string }> => {
      const server = getRpc(network);
      const [sym, nm] = await Promise.allSettled([
        tokenSymbol(server, id, sourcePublicKey, network),
        tokenName(server, id, sourcePublicKey, network),
      ]);
      const subject: HeldTokenSubject = {
        contractId: id,
        ...(sym.status === "fulfilled" ? { symbol: sym.value } : {}),
        ...(nm.status === "fulfilled" ? { name: nm.value } : {}),
      };
      const failure = [sym, nm].find((r) => r.status === "rejected");
      return failure?.status === "rejected"
        ? { subject, error: errorMessage(failure.reason) }
        : { subject };
    };
    const check = async (): Promise<HeldTokenScam> => {
      const subjects = await Promise.all(ids.map(read));
      return {
        findings: runHeldTokenScamHeuristics(
          subjects.map((r) => r.subject),
          network.id,
        ),
        pending: false,
        unreadable: subjects.flatMap((r) =>
          r.error === undefined
            ? []
            : [`Couldn't read the name of token ${r.subject.contractId} (${r.error}).`],
        ),
        error: null,
      };
    };
    void check().then(
      (value) => {
        if (!cancelled) setResult({ key, tokens, value });
      },
      (err: unknown) => {
        if (cancelled) return;
        setResult({
          key,
          tokens,
          value: { findings: [], pending: false, unreadable: [], error: errorMessage(err) },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, ids, tokens, network, sourcePublicKey]);

  if (ids.length === 0) return NONE;
  if (result === null || result.key !== key || result.tokens !== tokens) return PENDING;
  return result.value;
}
