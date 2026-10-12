"use client";

// per-row revoke action: builds an approve(amount=0) tx for the row's allowance,
// shows its fee for the user to accept, then signs and submits it and waits for
// the ledger before calling it revoked

import { useCallback, useState } from "react";

import { Button, Spinner } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerTxUrl } from "@/lib/explorer";
import { type AllowanceRecord } from "@/lib/soroban/allowances";
import {
  confirmRevoke,
  prepareRevoke,
  RevokeFailedOnChainError,
  RevokeFeeChangedError,
  submitPreparedRevoke,
  type PreparedRevoke,
} from "@/lib/soroban/revoke";
import { stroopsToTrimmedDecimal } from "@/lib/stellar/amount";
import type { Connector } from "@/lib/wallet/connector";
import { shortAddress } from "@/lib/safe-display";

export interface RevokeButtonProps {
  readonly record: AllowanceRecord;
  readonly userAddress: string;
  readonly network: NetworkConfig;
  // null = disabled. ref is read only in the click handler (react-hooks/refs forbids during render)
  readonly connectorRef: React.RefObject<Connector | null> | null;
  // explicit `| undefined` keeps this forwardable under exactOptionalPropertyTypes
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
  // a bulk revoke sweep is running: disable per-row revokes so a click can't
  // enqueue a redundant approve(0) the bulk progress wouldn't count
  readonly busy?: boolean;
  // the row is expired or the token reports zero: approve(0) would change
  // nothing and still cost a fee
  readonly inactive?: boolean;
}

// preparing: building and simulating. review: the fee is on screen, nothing is
// signed yet. submitting: signing and sending. submitted: the rpc took it,
// waiting for a ledger. unconfirmed: the poll timed out or itself failed, so
// the revoke may still land. rejected: the ledger included it and it failed, so
// the allowance is still live.
type Phase =
  | "idle"
  | "preparing"
  | "review"
  | "submitting"
  | "submitted"
  | "confirmed"
  | "unconfirmed"
  | "rejected"
  | "failed";

export function RevokeButton({
  record,
  userAddress,
  network,
  connectorRef,
  onRevoked,
  busy,
  inactive,
}: RevokeButtonProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedRevoke | null>(null);
  // set when the reviewed tx had to be rebuilt and now costs more
  const [feeNote, setFeeNote] = useState<string | null>(null);

  const onPrepare = useCallback(async () => {
    setError(null);
    setFeeNote(null);
    // a retry starts a new transaction; the last one's link no longer applies
    setTxHash(null);
    // read ref only here, never during render
    const connector = connectorRef?.current ?? null;
    if (connector === null) {
      setError("Connect a wallet first.");
      return;
    }
    try {
      setPhase("preparing");
      setPrepared(await prepareRevoke(network, connector, record, userAddress));
      setPhase("review");
    } catch (e: unknown) {
      setError(errorMessage(e, "Could not build the revoke."));
      setPhase("failed");
    }
  }, [connectorRef, network, record, userAddress]);

  const onSign = useCallback(async () => {
    setError(null);
    const connector = connectorRef?.current ?? null;
    if (connector === null) {
      setError("Connect a wallet first.");
      return;
    }
    if (prepared === null) return;
    try {
      setPhase("submitting");
      const submitHash = await submitPreparedRevoke(connector, prepared);
      setPrepared(null);
      setFeeNote(null);
      setTxHash(submitHash);
      setPhase("submitted");
      // a security action never shows success early: only a SUCCESS from the
      // ledger turns the row green. anything else leaves a warning with the tx
      // link, because a dropped approve(0) means the allowance is still live.
      try {
        await confirmRevoke(network, submitHash);
      } catch (e: unknown) {
        setError(errorMessage(e, "The revoke did not confirm."));
        setPhase(e instanceof RevokeFailedOnChainError ? "rejected" : "unconfirmed");
        return;
      }
      setPhase("confirmed");
      onRevoked?.(record, submitHash);
    } catch (e: unknown) {
      if (e instanceof RevokeFeeChangedError) {
        // nothing was signed; put the rebuilt revoke and its fee up for review
        setPrepared(e.current);
        setFeeNote(e.message);
        setPhase("review");
        return;
      }
      setPrepared(null);
      setError(errorMessage(e, "Revoke failed."));
      setPhase("failed");
    }
  }, [connectorRef, network, prepared, record, onRevoked]);

  const onCancel = useCallback(() => {
    setPrepared(null);
    setFeeNote(null);
    setError(null);
    setPhase("idle");
  }, []);

  const noConnector = connectorRef === null;
  const inFlight = phase === "preparing" || phase === "submitting" || phase === "submitted";
  const rowId = `${record.contractId}-${record.spender}`;
  const testId = `revoke-button-${rowId}`;

  const txLink = (color: string) =>
    txHash !== null ? (
      <a
        href={explorerTxUrl(network, txHash)}
        target="_blank"
        rel="noreferrer noopener"
        title={txHash}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          color,
          fontFamily: '"Geist Mono", monospace',
          textDecoration: "none",
        }}
      >
        tx {shortAddress(txHash, 8, 4)}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </a>
    ) : null;

  // confirmed: green check + "Revoked"
  if (phase === "confirmed") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <span
          data-testid={testId}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 600,
            fontSize: 13,
            color: "var(--success)",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Revoked
        </span>
        {txLink("var(--success)")}
      </div>
    );
  }

  // in-flight: spinner + label, plus the tx link once the rpc has it
  if (inFlight) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <span
          data-testid={testId}
          role="status"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontWeight: 600,
            fontSize: 13,
            color: "var(--fg-2)",
          }}
        >
          <Spinner size={13} />
          {phase === "preparing"
            ? "Checking the fee…"
            : phase === "submitted"
              ? "Submitted, confirming…"
              : "Revoking…"}
        </span>
        {txLink("var(--fg-3)")}
      </div>
    );
  }

  // the fee is shown and nothing is signed until the user accepts it
  if (phase === "review" && prepared !== null) {
    const signBlocked =
      noConnector || busy === true
        ? noConnector
          ? "Connect the wallet that owns this address to revoke"
          : "A bulk revoke is in progress"
        : null;
    return (
      <div
        data-testid={`revoke-review-${rowId}`}
        style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}
      >
        <span
          data-testid={`revoke-fee-${rowId}`}
          style={{ fontSize: 11, color: "var(--fg-2)", textAlign: "right", maxWidth: 220 }}
        >
          Network fee up to{" "}
          <strong style={{ fontFamily: '"Geist Mono", monospace', color: "var(--fg)" }}>
            {stroopsToTrimmedDecimal(prepared.fee.totalFee)} XLM
          </strong>
        </span>
        {feeNote !== null ? (
          <p
            role="alert"
            style={{
              fontSize: 11,
              color: "var(--warning)",
              margin: 0,
              maxWidth: 220,
              textAlign: "right",
            }}
          >
            {feeNote} Check the new fee.
          </p>
        ) : null}
        <div style={{ display: "flex", gap: 6 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            data-testid={`revoke-cancel-${rowId}`}
          >
            Cancel
          </Button>
          {signBlocked !== null ? (
            <Button
              variant="secondary"
              size="sm"
              disabled
              disabledReason={signBlocked}
              data-testid={`revoke-sign-${rowId}`}
            >
              Sign
            </Button>
          ) : (
            <Button
              variant="danger"
              size="sm"
              onClick={() => void onSign()}
              data-testid={`revoke-sign-${rowId}`}
            >
              Sign
            </Button>
          )}
        </div>
      </div>
    );
  }

  // a warning about an unconfirmed revoke stays visible even when the button
  // below is disabled, since the allowance may still be live
  const notice =
    phase === "unconfirmed" ? (
      <div
        role="alert"
        data-testid="revoke-unconfirmed"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 3,
          fontSize: 11,
          color: "var(--warning)",
          maxWidth: 220,
          textAlign: "right",
        }}
      >
        <span>
          <strong>Not confirmed.</strong> {error} Refresh the list to see the current allowance.
        </span>
        {txLink("var(--warning)")}
      </div>
    ) : phase === "rejected" ? (
      <div
        role="alert"
        data-testid="revoke-failed"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 3,
          fontSize: 11,
          color: "var(--danger)",
          maxWidth: 220,
          textAlign: "right",
        }}
      >
        <span>{error} The allowance is still live.</span>
        {txLink("var(--danger)")}
      </div>
    ) : error !== null ? (
      <p
        role="alert"
        style={{
          fontSize: 11,
          color: "var(--danger)",
          margin: 0,
          maxWidth: 200,
          textAlign: "right",
        }}
      >
        {error}
      </p>
    ) : null;

  // disabled when there is nothing to revoke, when no wallet that owns this
  // address is connected, or while a bulk sweep runs (a per-row revoke would be
  // redundant and uncounted)
  const disabledReason =
    inactive === true
      ? "This approval is expired or already zero, so there is nothing to revoke"
      : noConnector
        ? "Connect the wallet that owns this address to revoke"
        : busy === true
          ? "A bulk revoke is in progress"
          : null;
  const button =
    disabledReason !== null ? (
      <Button
        variant="secondary"
        size="sm"
        disabled
        disabledReason={disabledReason}
        data-testid={testId}
      >
        Revoke
      </Button>
    ) : (
      <Button variant="danger" size="sm" onClick={() => void onPrepare()} data-testid={testId}>
        {phase === "failed" || phase === "unconfirmed" || phase === "rejected"
          ? "Retry revoke"
          : "Revoke"}
      </Button>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
      {button}
      {notice}
    </div>
  );
}
