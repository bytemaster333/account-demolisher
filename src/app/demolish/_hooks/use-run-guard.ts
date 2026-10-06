"use client";

import { useEffect } from "react";

import type { PageFlowInput } from "@/lib/orchestrator/page-flow-machine";

// a run is bound to the account and network it was started with (the machine
// keeps that connector and network for execution). Once the connected account
// or the navbar network no longer match, the plan on screen is for something
// else, so it must not stay confirmable.
export function runMismatch(
  input: Pick<PageFlowInput, "publicKey" | "network"> | null,
  publicKey: string | null,
  networkId: string,
): boolean {
  if (input === null) return false;
  return publicKey !== input.publicKey || networkId !== input.network.id;
}

// states where a mismatched plan is discarded. discovering and previewing are
// included so the cancel lands as soon as the machine accepts it there; until
// then the effect re-runs on the move to awaiting_confirmation and cancels at
// that point, before the plan can be confirmed.
const DISCARDABLE = new Set(["discovering", "previewing", "awaiting_confirmation"]);

export function useRunGuard(args: {
  readonly state: string;
  readonly input: PageFlowInput | null;
  readonly publicKey: string | null;
  readonly networkId: string;
  readonly send: (event: { type: "CANCEL" }) => void;
}): boolean {
  const { state, input, publicKey, networkId, send } = args;
  const mismatch = runMismatch(input, publicKey, networkId);
  useEffect(() => {
    if (mismatch && DISCARDABLE.has(state)) send({ type: "CANCEL" });
  }, [mismatch, state, send]);
  return mismatch;
}
