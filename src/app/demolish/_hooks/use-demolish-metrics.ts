"use client";

import { useEffect, useRef } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { trackClose, trackFunnel, trackVisit } from "@/lib/metrics/beacon";

// usage metrics (aggregate, no PII): one page-view on mount, then one beacon per
// funnel milestone and one for the verified close (its on-chain merge hash) as
// the machine advances. Each fires at most once per mount; all are
// fire-and-forget and never affect the flow. Run milestones and the close are
// reported on the network the run is on, not the navbar's.
export function useDemolishMetrics(args: {
  readonly networkId: NetworkConfig["id"];
  readonly runNetworkId: NetworkConfig["id"];
  readonly connected: boolean;
  readonly state: string;
  // the merge hash of a close that succeeded, else null
  readonly mergedTxHash: string | null;
}): void {
  const { networkId, runNetworkId, connected, state, mergedTxHash } = args;
  const sentRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const once = (key: string, fn: () => void): void => {
      if (sentRef.current.has(key)) return;
      sentRef.current.add(key);
      fn();
    };
    once("visit", () => trackVisit("demolish", networkId));
    if (connected) once("wallet_connected", () => trackFunnel(networkId, "wallet_connected"));
    if (state === "previewing")
      once("discovery_completed", () => trackFunnel(runNetworkId, "discovery_completed"));
    if (state === "awaiting_confirmation")
      once("plan_built", () => trackFunnel(runNetworkId, "plan_built"));
    if (state === "executing")
      once("close_started", () => trackFunnel(runNetworkId, "close_started"));
    if (state === "succeeded" && mergedTxHash !== null) {
      const hash = mergedTxHash;
      once("close_completed", () => trackClose(runNetworkId, hash));
    }
  }, [networkId, runNetworkId, connected, state, mergedTxHash]);
}
