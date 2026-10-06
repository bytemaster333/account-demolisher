"use client";

// the transaction-level facts of a close a co-signer is asked to sign: the
// maximum fee, the memo, the window it is valid in, and any preconditions. a
// close the app builds sets only a time window, so anything else under
// preconditions is called out.

import { useEffect, useState } from "react";

import { describeCloseMemo } from "@/components/multisig/memo-label";
import { Badge } from "@/components/ui";
import type { CloseInspection } from "@/lib/multisig/signing-request";

// "2d 3h", "45m", "under a minute"; the caller handles a passed deadline
export function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

function localTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

// a clock for countdowns, refreshed every 30 seconds
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function Row({
  label,
  children,
  testId,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly testId?: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(110px, 0.35fr) 1fr",
        gap: 12,
        padding: "10px 14px",
        borderTop: "1px solid var(--border)",
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <span style={{ color: "var(--fg-3)" }}>{label}</span>
      <span data-testid={testId} style={{ color: "var(--fg)", wordBreak: "break-word" }}>
        {children}
      </span>
    </div>
  );
}

export function CloseFacts({
  inspection,
  relayExpiresAt,
}: {
  readonly inspection: CloseInspection;
  // when the relay stops serving the request, epoch ms
  readonly relayExpiresAt: number;
}): React.JSX.Element {
  const now = useNow();
  const tb = inspection.timeBounds;
  const pre = inspection.preconditions;
  const maxMs = tb !== null && tb.maxTime > 0 ? tb.maxTime * 1000 : null;

  return (
    <div
      data-testid="sign-facts"
      style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}
    >
      <div
        style={{
          padding: "9px 14px",
          fontSize: 11.5,
          color: "var(--fg-3)",
          letterSpacing: "0.05em",
          background: "var(--surface-2)",
        }}
      >
        TRANSACTION DETAILS
      </div>
      <Row label="Maximum fee" testId="sign-fee">
        {inspection.feeXlm} XLM ({inspection.feeStroops} stroops)
      </Row>
      <Row label="Memo" testId="sign-fact-memo">
        {describeCloseMemo(inspection.memo)}
      </Row>
      <Row label="Valid" testId="sign-validity">
        {tb === null ? (
          "No time limit"
        ) : (
          <>
            {tb.minTime > 0 ? `From ${localTime(tb.minTime)}. ` : null}
            {maxMs === null ? (
              "No expiry."
            ) : maxMs <= now ? (
              <span style={{ color: "var(--danger)", fontWeight: 600 }}>
                Expired at {localTime(tb.maxTime)}. It can no longer be submitted.
              </span>
            ) : (
              `Until ${localTime(tb.maxTime)} (expires in ${formatRemaining(maxMs - now)}).`
            )}
          </>
        )}
      </Row>
      <Row label="Request link" testId="sign-relay-expiry">
        {relayExpiresAt <= now
          ? "The relay has stopped serving this request."
          : `Served by the relay until ${new Date(relayExpiresAt).toLocaleString()} (in ${formatRemaining(relayExpiresAt - now)}).`}
      </Row>
      {pre !== null ? (
        <Row label="Preconditions" testId="sign-preconditions">
          <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>
              <Badge tone="danger">A close never sets these</Badge>
            </span>
            {pre.ledgerBounds ? (
              <span>
                Ledgers {pre.ledgerBounds.minLedger} to{" "}
                {pre.ledgerBounds.maxLedger === 0 ? "any" : pre.ledgerBounds.maxLedger}
              </span>
            ) : null}
            {pre.minAccountSequence !== undefined ? (
              <span>Minimum account sequence {pre.minAccountSequence}</span>
            ) : null}
            {pre.minAccountSequenceAge !== undefined ? (
              <span>Account sequence must be at least {pre.minAccountSequenceAge} seconds old</span>
            ) : null}
            {pre.minAccountSequenceLedgerGap !== undefined ? (
              <span>
                At least {pre.minAccountSequenceLedgerGap} ledgers since the account sequence moved
              </span>
            ) : null}
            {pre.extraSigners !== undefined ? (
              <span>Also needs signatures from: {pre.extraSigners.join(", ")}</span>
            ) : null}
          </span>
        </Row>
      ) : null}
    </div>
  );
}
