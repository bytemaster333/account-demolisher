"use client";

import { useEffect, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { getHorizon } from "@/lib/stellar/horizon-client";

import type { DeliveredAmount } from "../_components/StatusWidget";
import { fetchDeliveredXlm } from "../_lib/receipt";

// the network's current base reserve from the latest ledger, in stroops. stroops
// stays null until it loads or when it can't be read; callers then show no figure
// rather than assume a value, and error says why it couldn't be read.
export interface BaseReserve {
  readonly stroops: number | null;
  readonly error: string | null;
}

const NO_BASE_RESERVE: BaseReserve = { stroops: null, error: null };

export function useBaseReserve(network: NetworkConfig, enabled: boolean): BaseReserve {
  const [entry, setEntry] = useState<{ readonly id: string; readonly value: BaseReserve } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getHorizon(network)
      .ledgers()
      .order("desc")
      .limit(1)
      .call()
      .then((page) => {
        if (cancelled) return;
        const reserve = page.records[0]?.base_reserve_in_stroops;
        setEntry({
          id: network.id,
          value:
            typeof reserve === "number" && reserve > 0
              ? { stroops: reserve, error: null }
              : { stroops: null, error: "Horizon's latest ledger reported no base reserve" },
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEntry({ id: network.id, value: { stroops: null, error: errorMessage(err) } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [network, enabled]);
  return entry !== null && entry.id === network.id ? entry.value : NO_BASE_RESERVE;
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
        if (!cancelled) {
          setEntry({ hash: txHash, result: { status: "unavailable", reason: errorMessage(err) } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [network, txHash, destination]);
  if (txHash === null) {
    return { status: "unavailable", reason: "the run recorded no delivering transaction to read" };
  }
  return entry !== null && entry.hash === txHash ? entry.result : { status: "loading" };
}
