"use client";

// per-row revoke action: builds, signs and submits an approve(amount=0) tx for
// the row's allowance, then waits for the ledger before calling it revoked

import { useCallback, useState } from "react";

import { Button, Spinner } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerTxUrl } from "@/lib/explorer";
import { type AllowanceRecord } from "@/lib/soroban/allowances";
import { confirmRevoke, submitRevoke } from "@/lib/soroban/revoke";
import type { Connector } from "@/lib/wallet/connector";

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
}

// submitting: building and signing. submitted: the rpc took it, waiting for a
// ledger. unconfirmed: the poll ended without a success (reverted, timed out, or
// the poll itself failed), so the allowance may still be live.
type Phase = "idle" | "submitting" | "submitted" | "confirmed" | "unconfirmed" | "failed";

export function RevokeButton({
  record,
  userAddress,
  network,
  connectorRef,
  onRevoked,
  busy,
}: RevokeButtonProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    setError(null);
    // read ref only here, never during render
    const connector = connectorRef?.current ?? null;
    if (connector === null) {
      setError("Connect a wallet first.");
      return;
    }
    try {
      setPhase("submitting");
      const submitHash = await submitRevoke(network, connector, record, userAddress);
      setTxHash(submitHash);
      setPhase("submitted");
      // a security action never shows success early: only a SUCCESS from the
      // ledger turns the row green. anything else leaves a warning with the tx
      // link, because a dropped approve(0) means the allowance is still live.
      try {
        await confirmRevoke(network, submitHash);
      } catch (e: unknown) {
        setError(errorMessage(e, "The revoke did not confirm."));
        setPhase("unconfirmed");
        return;
      }
      setPhase("confirmed");
      onRevoked?.(record, submitHash);
    } catch (e: unknown) {
      const message = errorMessage(e, "Revoke failed.");
      setError(message);
      setPhase("failed");
    }
  }, [connectorRef, network, record, userAddress, onRevoked]);

  const noConnector = connectorRef === null;
  const inFlight = phase === "submitting" || phase === "submitted";
  const testId = `revoke-button-${record.contractId}-${record.spender}`;

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
        tx {txHash.slice(0, 8)}…{txHash.slice(-4)}
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
          {phase === "submitted" ? "Submitted, confirming…" : "Revoking…"}
        </span>
        {txLink("var(--fg-3)")}
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

  // disabled when no wallet that owns this address is connected, or while a bulk
  // sweep runs (a per-row revoke would be redundant and uncounted)
  const button =
    noConnector || busy ? (
      <Button
        variant="secondary"
        size="sm"
        disabled
        disabledReason={
          noConnector
            ? "Connect the wallet that owns this address to revoke"
            : "A bulk revoke is in progress"
        }
        data-testid={testId}
      >
        Revoke
      </Button>
    ) : (
      <Button variant="danger" size="sm" onClick={() => void onClick()} data-testid={testId}>
        {phase === "failed" || phase === "unconfirmed" ? "Retry revoke" : "Revoke"}
      </Button>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
      {button}
      {notice}
    </div>
  );
}
