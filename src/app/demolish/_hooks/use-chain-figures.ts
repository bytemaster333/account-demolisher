"use client";

import { useEffect, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { getHorizon } from "@/lib/stellar/horizon-client";

import type { DeliveredAmount } from "../_components/StatusWidget";
import { fetchDeliveredXlm } from "../_lib/receipt";

// the network's current base reserve from the latest ledger, in stroops. null
// until it loads or when it can't be read; callers then show no figure rather
// than assume a value.
export function useBaseReserve(network: NetworkConfig, enabled: boolean): number | null {
  const [entry, setEntry] = useState<{ readonly id: string; readonly value: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getHorizon(network)
      .ledgers()
      .order("desc")
      .limit(1)
      .call()
      .then((page) => {
        const reserve = page.records[0]?.base_reserve_in_stroops;
        if (!cancelled && typeof reserve === "number" && reserve > 0) {
          setEntry({ id: network.id, value: reserve });
        }
      })
      .catch((err: unknown) => {
        // display-only figure: the panels say it couldn't be loaded
        console.warn("[demolish] base reserve lookup failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [network, enabled]);
  return entry !== null && entry.id === network.id ? entry.value : null;
}

// what the destination actually received, read from the delivering
// transaction's effects (the merge for a direct close, the forward out of the
// helper account for an exchange close)
export function useDeliveredAmount(
  network: NetworkConfig,
  txHash: string | null,
  destination: string,
): DeliveredAmount {
  const [entry, setEntry] = useState<{
    readonly hash: string;
    readonly result: DeliveredAmount;
  } | null>(null);
  useEffect(() => {
    if (txHash === null) return;
    let cancelled = false;
    fetchDeliveredXlm(getHorizon(network), txHash, destination)
      .then((xlm) => {
        if (!cancelled) setEntry({ hash: txHash, result: { status: "ok", xlm } });
      })
      .catch((err: unknown) => {
        console.warn("[demolish] delivered amount lookup failed:", err);
        if (!cancelled) setEntry({ hash: txHash, result: { status: "unavailable" } });
      });
    return () => {
      cancelled = true;
    };
  }, [network, txHash, destination]);
  if (txHash === null) return { status: "unavailable" };
  return entry !== null && entry.hash === txHash ? entry.result : { status: "loading" };
}
