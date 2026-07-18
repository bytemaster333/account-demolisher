"use client";

// table view of SEP-41 allowances. one row per AllowanceRecord

import { useEffect, useMemo, useState } from "react";

import { Badge, Card, CopyableAddress, Dot, InfoTip } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl, explorerContractUrl } from "@/lib/explorer";
import type { NetworkConfig } from "@/lib/config/networks";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { decimals as sep41Decimals, symbol as sep41Symbol } from "@/lib/soroban/sep41";
import { lookupSpender, type SpenderInfo } from "@/lib/soroban/spender-registry";
import type { Connector } from "@/lib/wallet/connector";

import { RevokeButton } from "./RevokeButton";

const SECONDS_PER_LEDGER = 5;

const GRID_COLS = "minmax(0, 1.5fr) minmax(0, 1.7fr) 0.9fr 0.8fr 118px";

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

const HEADER_CELL: React.CSSProperties = {
  font: "600 10px/1 Geist, sans-serif",
  color: "var(--fg-3)",
  letterSpacing: "0.06em",
};

// stellar.expert link for a stellar address: contract (C…) or account (G…)
function addressExplorerUrl(network: NetworkConfig, addr: string): string {
  return addr.startsWith("C")
    ? explorerContractUrl(network, addr)
    : explorerAccountUrl(network, addr);
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
  const activeCount = useMemo(() => records.filter((r) => !r.expired).length, [records]);

  return (
    <Card padding={0} style={{ overflow: "hidden" }} data-testid="allowance-list">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {activeCount} active {activeCount === 1 ? "approval" : "approvals"}
        </span>
        <span style={{ fontSize: 12, color: "var(--fg-3)" }}>
          <InfoTip tip="We looked back about the last 7 days of on-chain history (the RPC's event-retention limit). 'Active' approvals can still be used; the rest have already expired.">
            {records.length} found
          </InfoTip>
        </span>
      </div>

      {visible.length === 0 ? (
        <div
          data-testid="allowance-list-empty"
          style={{ padding: "48px 24px", textAlign: "center" }}
        >
          <div style={{ fontWeight: 600, fontSize: 15 }}>No active allowances found</div>
          <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6 }}>
            All allowances for this address are expired. Toggle {'"Show expired allowances"'} to
            view them.
          </div>
        </div>
      ) : (
        // horizontal scroll on narrow viewports: the five fixed columns would
        // otherwise crush the mono addresses and badges below legibility. The
        // header and rows share one min-width track so they scroll as a unit.
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 620 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: GRID_COLS,
                gap: 14,
                padding: "11px 20px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={HEADER_CELL}>TOKEN</span>
              <span style={HEADER_CELL}>SPENDER</span>
              <span style={HEADER_CELL}>
                <InfoTip tip="The most this spender is still allowed to move of this token. Revoking sets it to zero.">
                  SPEND LIMIT
                </InfoTip>
              </span>
              <span style={HEADER_CELL}>
                <InfoTip tip="After this time the approval ends on its own and the spender can no longer move your tokens. Expired approvals are already harmless.">
                  EXPIRES
                </InfoTip>
              </span>
              <span />
            </div>
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
          </div>
        </div>
      )}
    </Card>
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
          setTokenError(errorMessage(e, "Failed to load token metadata"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, record.contractId, userAddress]);

  const spenderInfo: SpenderInfo | null = useMemo(
    () => lookupSpender(record.spender, network),
    [record.spender, network],
  );

  const avatarText = tokenSymbol ? tokenSymbol.slice(0, 2).toUpperCase() : tokenError ? "?" : "…";
  // reserve the accent avatar for a resolved token; a still-loading ("…") or
  // errored ("?") token gets a neutral chip so its state reads at a glance
  const avatarResolved = tokenSymbol !== null;

  return (
    <div
      data-testid="allowance-row"
      style={{
        display: "grid",
        gridTemplateColumns: GRID_COLS,
        gap: 14,
        alignItems: "center",
        padding: "14px 20px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {/* token */}
      <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "var(--surface-2)",
            border: avatarResolved ? "1px solid var(--accent-line)" : "1px solid var(--border-2)",
            color: avatarResolved ? "var(--accent)" : "var(--fg-3)",
            display: "grid",
            placeItems: "center",
            font: '700 12px/1 "Geist Mono", monospace',
          }}
        >
          {avatarText}
        </span>
        <div style={{ minWidth: 0 }}>
          <div data-testid="row-token-symbol" style={{ fontWeight: 600, fontSize: 14 }}>
            {tokenSymbol ?? (tokenError ? "(unknown)" : "…")}
          </div>
          <div style={{ marginTop: 2 }}>
            <CopyableAddress
              value={record.contractId}
              label="Token contract"
              size={11}
              href={explorerContractUrl(network, record.contractId)}
            />
          </div>
          {tokenError !== null && (
            <div role="alert" style={{ fontSize: 11, color: "var(--danger)", marginTop: 3 }}>
              {tokenError}
            </div>
          )}
        </div>
      </div>

      {/* spender */}
      <div style={{ minWidth: 0 }}>
        {spenderInfo !== null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              <Dot tone="success" />
              {spenderInfo.name}
              <span style={{ color: "var(--fg-3)", fontSize: 11, fontWeight: 500 }}>
                · {spenderInfo.protocol}
              </span>
            </span>
            <CopyableAddress
              value={record.spender}
              label="Spender"
              size={11}
              href={addressExplorerUrl(network, record.spender)}
            />
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <CopyableAddress
              value={record.spender}
              label="Spender"
              size={12}
              href={addressExplorerUrl(network, record.spender)}
            />
            <span data-testid="unknown-spender-badge" style={{ fontSize: 11.5 }}>
              <Badge tone="warning" bordered>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
                <InfoTip tip="We don't recognize this address as a known app or protocol on this network. That doesn't make it malicious, only that we can't vouch for it. It can spend up to the limit shown. Inspect it with the explorer link, and if you don't recognize it, revoking is the safe choice.">
                  Unrecognized spender
                </InfoTip>
              </Badge>
            </span>
          </div>
        )}
      </div>

      {/* amount (spend limit) */}
      <div
        data-testid="row-amount"
        style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}
        title={tokenDecimals !== null ? `${tokenDecimals} decimals` : undefined}
      >
        <span style={{ font: "600 13px/1 'Geist Mono', monospace" }}>
          {formatAmount(record.amount, tokenDecimals)}
        </span>
        {tokenSymbol !== null ? (
          <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 500 }}>{tokenSymbol}</span>
        ) : null}
      </div>

      {/* expires */}
      <div data-testid="row-expires">
        {record.expired ? (
          <Badge tone="neutral">expired</Badge>
        ) : (
          <span style={{ font: "500 12.5px/1 'Geist Mono', monospace", color: "var(--fg-2)" }}>
            {formatExpiry(record.live_until_ledger, currentLedger)}
          </span>
        )}
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

// an "unlimited" approval sets the allowance to a type-max sentinel (i128/u128
// max) far beyond any real token balance; no legitimate allowance reaches 1e30.
const UNLIMITED_ALLOWANCE_THRESHOLD = 10n ** 30n;

// bigint-safe thousands grouping for the integer part
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatAmount(amount: bigint, decimals: number | null): string {
  if (amount >= UNLIMITED_ALLOWANCE_THRESHOLD) return "Unlimited";
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  if (decimals === null || decimals === 0) return `${sign}${groupThousands(abs.toString())}`;
  // bigint-safe fixed-point formatting
  const divisor = 10n ** BigInt(decimals);
  const whole = groupThousands((abs / divisor).toString());
  const fracStr = (abs % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/u, "");
  return fracStr.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fracStr}`;
}

function formatExpiry(liveUntilLedger: number, currentLedger: number): string {
  const delta = liveUntilLedger - currentLedger;
  // an allowance is live *through* its live_until_ledger, so it's only expired
  // once the current ledger passes it. Matches enumerateAllowances' `expired`.
  if (delta < 0) return "expired";
  const seconds = delta * SECONDS_PER_LEDGER;
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `in ${days}d`;
  // only escalate to years once we're genuinely at/over a year. Using 30-day
  // months and 365-day years together left a dead zone (360-364 days floored to
  // "12 months" but rounded to "0 years" -> "in 0y"). Guard on the same 365-day
  // boundary the year bucket uses.
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `in ${months}mo`;
  }
  const years = Math.floor(days / 365);
  return `in ${years}y`;
}
