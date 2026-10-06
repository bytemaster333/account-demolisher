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
}

const NONE: HeldTokenScam = { findings: [], pending: false, unreadable: [] };

// a standalone token's symbol and name are set by its own contract, so the
// look-alike, homoglyph and hidden-character checks have to see them. read once
// per discovered token set and network.
export function useHeldTokenScam(
  tokens: readonly HeldToken[],
  network: NetworkConfig,
  sourcePublicKey: string | null,
): HeldTokenScam {
  const ids = useMemo(() => [...new Set(tokens.map((t) => t.contractId))].sort(), [tokens]);
  const key = `${network.id}|${ids.join(",")}`;
  const [result, setResult] = useState<{ readonly key: string; readonly value: HeldTokenScam }>({
    key: "",
    value: NONE,
  });

  useEffect(() => {
    if (ids.length === 0 || sourcePublicKey === null) return;
    let cancelled = false;
    const server = getRpc(network);
    const read = async (id: string): Promise<{ subject: HeldTokenSubject; error?: string }> => {
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
    void Promise.all(ids.map(read)).then((read) => {
      if (cancelled) return;
      setResult({
        key,
        value: {
          findings: runHeldTokenScamHeuristics(
            read.map((r) => r.subject),
            network.id,
          ),
          pending: false,
          unreadable: read.flatMap((r) =>
            r.error === undefined
              ? []
              : [`Couldn't read the name of token ${r.subject.contractId} (${r.error}).`],
          ),
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, ids, network, sourcePublicKey]);

  if (ids.length === 0) return NONE;
  if (result.key !== key) return { findings: [], pending: true, unreadable: [] };
  return result.value;
}
