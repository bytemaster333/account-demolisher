"use client";

// table view of SEP-41 allowances. one row per AllowanceRecord.

import { useEffect, useMemo, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { decimals as sep41Decimals, symbol as sep41Symbol } from "@/lib/soroban/sep41";
import { lookupSpender, type SpenderInfo } from "@/lib/soroban/spender-registry";
import { cn } from "@/lib/utils";
import type { Connector } from "@/lib/wallet/connector";

import { RevokeButton } from "./RevokeButton";

const SECONDS_PER_LEDGER = 5;

export interface AllowanceListProps {
  readonly records: readonly AllowanceRecord[];
  readonly userAddress: string;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  // null = revoke disabled. ref is only read inside the row click handler, never during render.
  readonly connectorRef: React.RefObject<Connector | null> | null;
  readonly showExpired: boolean;
  // re-enumerate after a successful revoke
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
  readonly className?: string | undefined;
}

export function AllowanceList({
  records,
  userAddress,
  network,
  currentLedger,
  connectorRef,
  showExpired,
  onRevoked,
  className,
}: AllowanceListProps): React.JSX.Element {
  const visible = useMemo(
    () => (showExpired ? records : records.filter((r) => !r.expired)),
    [records, showExpired],
  );

  if (visible.length === 0) {
    return (
      <p
        role="status"
        data-testid="allowance-list-empty"
        className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600"
      >
        {records.length === 0
          ? "No active SEP-41 allowances found for this address in the scan window."
          : "All allowances for this address are expired. Toggle “Show expired” to view them."}
      </p>
    );
  }

  return (
    <ul
      data-testid="allowance-list"
      className={cn("flex flex-col gap-2", className)}
      aria-label="Active SEP-41 allowances"
    >
      {visible.map((record) => (
        <AllowanceRow
          key={`${record.contractId}|${record.spender}`}
          record={record}
          userAddress={userAddress}
          network={network}
          currentLedger={currentLedger}
          connectorRef={connectorRef}
          onRevoked={onRevoked}
        />
      ))}
    </ul>
  );
}

interface AllowanceRowProps {
  readonly record: AllowanceRecord;
  readonly userAddress: string;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  readonly connectorRef: React.RefObject<Connector | null> | null;
  // explicit `| undefined` for exactOptionalPropertyTypes forwarding
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
}

function AllowanceRow({
  record,
  userAddress,
  network,
  currentLedger,
  connectorRef,
  onRevoked,
}: AllowanceRowProps): React.JSX.Element {
  const [tokenSymbol, setTokenSymbol] = useState<string | null>(null);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // lazy per-row SEP-41 metadata fetch; sep41.ts caches per (server, contract)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rpc = getRpc(network);
        const [s, d] = await Promise.all([
          sep41Symbol(rpc, record.contractId, userAddress, network),
          sep41Decimals(rpc, record.contractId, userAddress, network),
        ]);
        if (!cancelled) {
          setTokenSymbol(s);
          setTokenDecimals(d);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setTokenError(e instanceof Error ? e.message : "Failed to load token metadata");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, record.contractId, userAddress]);

  const spenderInfo: SpenderInfo | null = useMemo(
    () => lookupSpender(record.spender),
    [record.spender],
  );

  return (
    <li
      data-testid="allowance-row"
      className={cn(
        "grid grid-cols-1 gap-3 rounded-lg border bg-white p-3 text-sm md:grid-cols-5 md:items-center",
        record.expired ? "border-amber-300 bg-amber-50" : "border-slate-300",
      )}
    >
      <div className="flex flex-col">
        <span className="font-medium" data-testid="row-token-symbol">
          {tokenSymbol ?? (tokenError ? "(unknown)" : "…")}
        </span>
        <span className="font-mono text-xs text-slate-500">{truncate(record.contractId)}</span>
        {tokenError !== null && (
          <span className="text-xs text-red-600" role="alert">
            {tokenError}
          </span>
        )}
      </div>

      <div className="flex flex-col">
        {spenderInfo !== null ? (
          <>
            <span className="font-medium">{spenderInfo.name}</span>
            <span className="text-xs text-slate-500">{spenderInfo.protocol}</span>
          </>
        ) : (
          <>
            <span className="font-mono text-xs">{truncate(record.spender)}</span>
            <span
              data-testid="unknown-spender-badge"
              className="mt-1 inline-flex w-fit items-center rounded-md bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900"
            >
              Unknown contract — verify before approving
            </span>
          </>
        )}
      </div>

      <div className="flex flex-col">
        <span className="font-medium" data-testid="row-amount">
          {formatAmount(record.amount, tokenDecimals)}
        </span>
        <span className="text-xs text-slate-500">
          {tokenDecimals !== null ? `${tokenDecimals} decimals` : "decimals: …"}
        </span>
      </div>

      <div className="flex flex-col">
        <span className="font-medium" data-testid="row-expires">
          {formatExpiry(record.live_until_ledger, currentLedger)}
        </span>
        <span className="text-xs text-slate-500">ledger {record.live_until_ledger}</span>
      </div>

      <div className="md:justify-self-end">
        <RevokeButton
          record={record}
          userAddress={userAddress}
          network={network}
          connectorRef={connectorRef}
          onRevoked={onRevoked}
        />
      </div>
    </li>
  );
}

function truncate(s: string): string {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function formatAmount(amount: bigint, decimals: number | null): string {
  if (decimals === null) return amount.toString();
  if (decimals === 0) return amount.toString();
  // bigint-safe fixed-point formatting
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/u, "");
  return fracStr.length === 0
    ? `${sign}${whole.toString()}`
    : `${sign}${whole.toString()}.${fracStr}`;
}

function formatExpiry(liveUntilLedger: number, currentLedger: number): string {
  const delta = liveUntilLedger - currentLedger;
  if (delta <= 0) return "expired";
  const seconds = delta * SECONDS_PER_LEDGER;
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `in ${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `in ${months}mo`;
  const years = Math.floor(days / 365);
  return `in ${years}y`;
}
