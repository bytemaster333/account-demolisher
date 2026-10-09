"use client";

// table view of SEP-41 allowances. one row per AllowanceRecord

import { memo, useEffect, useMemo, useState } from "react";

import {
  addressExplorerUrl,
  confirmationOf,
  effectiveAmount,
  isActive,
} from "@/components/allowance-viewer/allowance-state";
import { Badge, Button, Card, CopyableAddress, Dot, InfoTip } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { explorerContractUrl } from "@/lib/explorer";
import type { NetworkConfig } from "@/lib/config/networks";
import { allowanceAmountMismatch, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { MAX_TOKEN_DECIMALS } from "@/lib/soroban/sep41";
import { readTokenMetadata } from "@/lib/soroban/token-metadata";
import { hasNonAscii, safeDisplay } from "@/lib/safe-display";
import { lookupSpender, type SpenderInfo } from "@/lib/soroban/spender-registry";
import type { Connector } from "@/lib/wallet/connector";

import { RevokeButton } from "./RevokeButton";

const SECONDS_PER_LEDGER = 5;

const GRID_COLS = "minmax(0, 1.5fr) minmax(0, 1.7fr) 0.9fr 0.8fr 150px";

// any contract can emit approve events naming this address, and the per-contract
// cap in allowances.ts does not bound how many contracts do it, so the table
// renders a page at a time. each rendered row also queues a metadata read.
export const ALLOWANCE_ROWS_PER_PAGE = 50;

export interface AllowanceListProps {
  readonly records: readonly AllowanceRecord[];
  readonly userAddress: string;
  // G-address used as the source of token metadata simulations (the same one
  // the on-chain confirm uses). null when none exists, e.g. a C-address scan
  // with no wallet connected, and then metadata isn't loaded.
  readonly simulationSource: string | null;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  // null = revoke disabled. ref is only read inside the row click handler, never during render
  readonly connectorRef: React.RefObject<Connector | null> | null;
  // also show rows that are no longer active (expired, or zero on chain)
  readonly showExpired: boolean;
  // fires after a revoke is confirmed on chain; the page drops that row
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
  // a bulk sweep is running: disable the per-row revoke buttons
  readonly busy?: boolean;
  // rows per page; the page passes none and gets ALLOWANCE_ROWS_PER_PAGE
  readonly pageSize?: number;
}

const HEADER_CELL: React.CSSProperties = {
  font: "600 10px/1 Geist, sans-serif",
  color: "var(--fg-3)",
  letterSpacing: "0.06em",
};

export function AllowanceList({
  records,
  userAddress,
  simulationSource,
  network,
  currentLedger,
  connectorRef,
  showExpired,
  onRevoked,
  busy,
  pageSize = ALLOWANCE_ROWS_PER_PAGE,
}: AllowanceListProps): React.JSX.Element {
  const visible = useMemo(
    () => (showExpired ? records : records.filter(isActive)),
    [records, showExpired],
  );
  const activeCount = useMemo(() => records.filter(isActive).length, [records]);
  const [shownCount, setShownCount] = useState(pageSize);
  const shown = visible.slice(0, shownCount);

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
          <InfoTip tip="We looked back about the last 7 days of on-chain history (the RPC's event-retention limit). 'Active' approvals can still be used; the rest have expired or are already zero.">
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
            Every allowance found for this address has expired or is already zero. Toggle{" "}
            {'"Show inactive allowances"'} to view them.
          </div>
        </div>
      ) : (
        // horizontal scroll on narrow viewports: the five fixed columns would
        // otherwise crush the mono addresses and badges below legibility. The
        // header and rows share one min-width track so they scroll as a unit.
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 652 }}>
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
            {shown.map((record) => (
              <AllowanceRow
                key={`${record.contractId}|${record.spender}`}
                record={record}
                userAddress={userAddress}
                simulationSource={simulationSource}
                network={network}
                currentLedger={currentLedger}
                connectorRef={connectorRef}
                onRevoked={onRevoked}
                busy={busy ?? false}
              />
            ))}
          </div>
        </div>
      )}
      {shown.length < visible.length ? (
        <div
          data-testid="allowance-list-more"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            padding: "12px 20px",
            fontSize: 12.5,
            color: "var(--fg-2)",
          }}
        >
          <span>
            Showing {shown.length} of {visible.length}.
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShownCount((n) => n + pageSize)}
            data-testid="allowance-list-more-button"
          >
            Show {Math.min(pageSize, visible.length - shown.length)} more
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

interface AllowanceRowProps {
  readonly record: AllowanceRecord;
  readonly userAddress: string;
  readonly simulationSource: string | null;
  readonly network: NetworkConfig;
  readonly currentLedger: number;
  readonly connectorRef: React.RefObject<Connector | null> | null;
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
  readonly busy?: boolean;
}

// memoized: every prop is stable across the list's own renders, so showing
// another page mounts only the new rows instead of rendering every shown row again
const AllowanceRow = memo(function AllowanceRow({
  record,
  userAddress,
  simulationSource,
  network,
  currentLedger,
  connectorRef,
  onRevoked,
  busy,
}: AllowanceRowProps): React.JSX.Element {
  const [tokenSymbol, setTokenSymbol] = useState<string | null>(null);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // per-row SEP-41 metadata through one shared, bounded queue: any contract can
  // put rows on this list, so rows must not each fire their own simulations. a
  // simulation needs a G-address source, never the scanned address itself
  // (which can be a contract)
  useEffect(() => {
    if (simulationSource === null) return;
    const controller = new AbortController();
    (async () => {
      try {
        const { symbol, decimals } = await readTokenMetadata(
          getRpc(network),
          record.contractId,
          simulationSource,
          network,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          // SEP-41 symbol() is attacker-controlled on-chain text; strip bidi /
          // control characters so a crafted symbol can't reorder or spoof the row
          setTokenSymbol(safeDisplay(symbol));
          setTokenDecimals(decimals);
        }
      } catch (e: unknown) {
        // an aborted read belongs to a row that is gone; it is not a token error
        if (!controller.signal.aborted) {
          setTokenError(errorMessage(e, "Failed to load token metadata"));
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [network, record.contractId, simulationSource]);

  const spenderInfo: SpenderInfo | null = useMemo(
    () => lookupSpender(record.spender, network),
    [record.spender, network],
  );

  const noSource = simulationSource === null;
  const avatarText = tokenSymbol
    ? tokenSymbol.slice(0, 2).toUpperCase()
    : tokenError || noSource
      ? "?"
      : "…";
  const confirmation = confirmationOf(record);
  const shownAmount = effectiveAmount(record);
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
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span data-testid="row-token-symbol" style={{ fontWeight: 600, fontSize: 14 }}>
              {tokenSymbol ?? (tokenError || noSource ? "(unknown)" : "…")}
            </span>
            {tokenSymbol !== null && hasNonAscii(tokenSymbol) ? (
              <span data-testid="row-token-nonascii" style={{ fontSize: 10.5 }}>
                <Badge tone="warning">
                  <InfoTip tip="This symbol uses characters outside plain ASCII. Some look exactly like Latin letters (a Cyrillic С next to a Latin C), so a token can pose as a familiar one. Check the token contract address, not the symbol.">
                    non-ASCII
                  </InfoTip>
                </Badge>
              </span>
            ) : null}
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
          {noSource ? (
            <div
              data-testid="row-token-hint"
              style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 3 }}
            >
              Connect a wallet to load token details.
            </div>
          ) : null}
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
              <Badge tone="warning">
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

      {/* amount (spend limit): the token's own allowance() when it was read,
          otherwise the event amount, marked unconfirmed. a hostile token can
          emit a fabricated approve event, so the event value never leads when
          the on-chain one is known. */}
      <div data-testid="row-amount" style={{ minWidth: 0 }}>
        <div
          style={{ display: "flex", alignItems: "baseline", gap: 5 }}
          title={tokenDecimals !== null ? `${tokenDecimals} decimals` : undefined}
        >
          <span
            data-testid="row-amount-primary"
            style={{ font: "600 13px/1 'Geist Mono', monospace" }}
          >
            {formatAmount(shownAmount, tokenDecimals)}
          </span>
          {tokenSymbol !== null ? (
            <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 500 }}>
              {tokenSymbol}
            </span>
          ) : tokenDecimals === null && shownAmount < UNLIMITED_ALLOWANCE_THRESHOLD ? (
            <span style={{ fontSize: 11, color: "var(--fg-3)", fontWeight: 500 }}>base units</span>
          ) : null}
        </div>
        {confirmation === "unconfirmed" ? (
          <div data-testid="row-unconfirmed" style={{ marginTop: 4, fontSize: 10.5 }}>
            <Badge tone="warning">
              <InfoTip tip="This amount comes from approval events and could not be checked against the token's current allowance() (the read failed or wasn't possible). A token can emit a fabricated event, so treat it as unverified. Revoking is the safe choice if you don't recognize this spender.">
                unconfirmed
              </InfoTip>
            </Badge>
          </div>
        ) : allowanceAmountMismatch(record) ? (
          <div data-testid="row-amount-mismatch" style={{ marginTop: 4, fontSize: 10.5 }}>
            <InfoTip tip="The approval events reported a different amount than the token's current allowance(). The event may be fabricated or stale. The amount above is the on-chain value.">
              <span style={{ color: "var(--warning)", fontWeight: 600 }}>
                ⚠ events: {formatAmount(record.amount, tokenDecimals)}
              </span>
            </InfoTip>
          </div>
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
          busy={busy ?? false}
          inactive={!isActive(record)}
        />
      </div>
    </div>
  );
});

// an "unlimited" approval sets the allowance to a type-max sentinel (i128/u128
// max) far beyond any real token balance; no legitimate allowance reaches 1e30.
const UNLIMITED_ALLOWANCE_THRESHOLD = 10n ** 30n;

// bigint-safe thousands grouping for the integer part
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

// decimals come from the token contract, so the formatter takes nothing on
// trust: anything an i128 can't need is shown as raw base units
function formatAmount(amount: bigint, decimals: number | null): string {
  if (amount >= UNLIMITED_ALLOWANCE_THRESHOLD) return "Unlimited";
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  if (
    decimals === null ||
    !Number.isInteger(decimals) ||
    decimals <= 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return `${sign}${groupThousands(abs.toString())}`;
  }
  // bigint-safe fixed-point formatting
  const divisor = 10n ** BigInt(decimals);
  const whole = groupThousands((abs / divisor).toString());
  const frac = (abs % divisor).toString().padStart(decimals, "0");
  // a plain scan instead of a /0+$/ regex, which backtracks quadratically
  let end = frac.length;
  while (end > 0 && frac[end - 1] === "0") end -= 1;
  const fracStr = frac.slice(0, end);
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
