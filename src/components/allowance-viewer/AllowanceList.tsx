"use client";

// table view of SEP-41 allowances. one row per AllowanceRecord, design-matched layout

import { useEffect, useMemo, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { decimals as sep41Decimals, symbol as sep41Symbol } from "@/lib/soroban/sep41";
import { lookupSpender, type SpenderInfo } from "@/lib/soroban/spender-registry";
import type { Connector } from "@/lib/wallet/connector";

import { RevokeButton } from "./RevokeButton";

const SECONDS_PER_LEDGER = 5;

const GRID_COLS = "1.4fr 1.6fr 1fr 1fr 110px";

export interface AllowanceListProps {
  readonly records: readonly AllowanceRecord[];
  readonly userAddress: string;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  // null = revoke disabled. ref is only read inside the row click handler, never during render
  readonly connectorRef: React.RefObject<Connector | null> | null;
  readonly showExpired: boolean;
  // re-enumerate after a successful revoke
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
}

export function AllowanceList({
  records,
  userAddress,
  network,
  currentLedger,
  connectorRef,
  showExpired,
  onRevoked,
}: AllowanceListProps): React.JSX.Element {
  const visible = useMemo(
    () => (showExpired ? records : records.filter((r) => !r.expired)),
    [records, showExpired],
  );

  return (
    <div
      data-testid="allowance-list"
      style={{
        marginTop: 18,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLS,
          gap: 14,
          padding: "13px 20px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <span
          style={{
            font: "600 10px/1 Geist, sans-serif",
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
          }}
        >
          TOKEN
        </span>
        <span
          style={{
            font: "600 10px/1 Geist, sans-serif",
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
          }}
        >
          SPENDER
        </span>
        <span
          style={{
            font: "600 10px/1 Geist, sans-serif",
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
          }}
        >
          ALLOWANCE
        </span>
        <span
          style={{
            font: "600 10px/1 Geist, sans-serif",
            color: "var(--fg-3)",
            letterSpacing: "0.06em",
          }}
        >
          EXPIRES
        </span>
        <span />
      </div>

      {visible.length === 0 ? (
        <div
          data-testid="allowance-list-empty"
          style={{ padding: "54px 24px", textAlign: "center" }}
        >
          <div style={{ fontWeight: 600, fontSize: 15 }}>No active allowances found</div>
          <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6 }}>
            {records.length === 0
              ? "This address has no standing approvals in the scanned window."
              : "All allowances for this address are expired. Toggle “Show expired” to view them."}
          </div>
        </div>
      ) : (
        visible.map((record) => (
          <AllowanceRow
            key={`${record.contractId}|${record.spender}`}
            record={record}
            userAddress={userAddress}
            network={network}
            currentLedger={currentLedger}
            connectorRef={connectorRef}
            onRevoked={onRevoked}
          />
        ))
      )}
    </div>
  );
}

interface AllowanceRowProps {
  readonly record: AllowanceRecord;
  readonly userAddress: string;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  readonly connectorRef: React.RefObject<Connector | null> | null;
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
    <div
      data-testid="allowance-row"
      style={{
        display: "grid",
        gridTemplateColumns: GRID_COLS,
        gap: 14,
        alignItems: "center",
        padding: "15px 20px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div>
        <div data-testid="row-token-symbol" style={{ fontWeight: 600, fontSize: 14 }}>
          {tokenSymbol ?? (tokenError ? "(unknown)" : "…")}
        </div>
        <div
          style={{
            font: "500 11px/1.3 'Geist Mono', monospace",
            color: "var(--fg-3)",
            marginTop: 3,
          }}
        >
          {truncate(record.contractId)}
        </div>
        {tokenError !== null && (
          <div
            role="alert"
            style={{
              fontSize: 11,
              color: "var(--danger)",
              marginTop: 3,
            }}
          >
            {tokenError}
          </div>
        )}
      </div>

      <div>
        {spenderInfo !== null ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontWeight: 500,
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--success)",
              }}
            />
            <span>{spenderInfo.name}</span>
            <span style={{ color: "var(--fg-3)", fontSize: 11 }}>· {spenderInfo.protocol}</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span
              style={{
                font: "500 11px/1.3 'Geist Mono', monospace",
                color: "var(--fg-2)",
              }}
            >
              {truncate(record.spender)}
            </span>
            <span
              data-testid="unknown-spender-badge"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                padding: "4px 9px",
                borderRadius: 7,
                background: "var(--danger-soft)",
                border: "1px solid color-mix(in srgb, var(--danger) 32%, transparent)",
                width: "fit-content",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--danger)"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </svg>
              <span style={{ fontWeight: 600, fontSize: 12, color: "var(--danger)" }}>
                Unknown, verify
              </span>
            </span>
          </div>
        )}
      </div>

      <div
        data-testid="row-amount"
        style={{ font: "600 13px/1 'Geist Mono', monospace" }}
        title={tokenDecimals !== null ? `${tokenDecimals} decimals` : undefined}
      >
        {formatAmount(record.amount, tokenDecimals)}
      </div>

      <div
        data-testid="row-expires"
        style={{
          font: "500 12.5px/1 'Geist Mono', monospace",
          color: record.expired ? "var(--warning)" : "var(--fg-2)",
        }}
        title={`ledger ${record.live_until_ledger}`}
      >
        {formatExpiry(record.live_until_ledger, currentLedger)}
      </div>

      <div style={{ justifySelf: "end" }}>
        <RevokeButton
          record={record}
          userAddress={userAddress}
          network={network}
          connectorRef={connectorRef}
          onRevoked={onRevoked}
        />
      </div>
    </div>
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
