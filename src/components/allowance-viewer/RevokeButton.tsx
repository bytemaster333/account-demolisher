"use client";

// per-row revoke action: builds + signs + submits an approve(amount=0) tx for the row's allowance

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
}

type Phase = "idle" | "submitting" | "confirmed" | "failed";

export function RevokeButton({
  record,
  userAddress,
  network,
  connectorRef,
  onRevoked,
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
      // submit-only (enqueue-and-go). PENDING flips the row to a confirmed
      // "Revoked" state optimistically. The list re-scan, however, must wait for
      // ledger inclusion: a re-enumeration run between PENDING (~150ms) and
      // inclusion (~3-4s) still reads the OLD non-zero allowance and the row
      // would pop back as active. So confirm in the background, then re-scan; a
      // confirm timeout just skips the auto-refresh and leaves the optimistic
      // state (the user can refresh manually).
      const submitHash = await submitRevoke(network, connector, record, userAddress);
      setTxHash(submitHash);
      setPhase("confirmed");
      void confirmRevoke(network, submitHash)
        .then(() => onRevoked?.(record, submitHash))
        .catch(() => {});
    } catch (e: unknown) {
      const message = errorMessage(e, "Revoke failed.");
      setError(message);
      setPhase("failed");
    }
  }, [connectorRef, network, record, userAddress, onRevoked]);

  const noConnector = connectorRef === null;
  const inFlight = phase === "submitting";
  const testId = `revoke-button-${record.contractId}-${record.spender}`;

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
        {txHash !== null && (
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
              color: "var(--success)",
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
        )}
      </div>
    );
  }

  // in-flight: spinner + label
  if (inFlight) {
    return (
      <span
        data-testid={testId}
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
        Revoking…
      </span>
    );
  }

  // disabled (no wallet connected, or wallet doesn't own this address)
  if (noConnector) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled
        disabledReason="Connect the wallet that owns this address to revoke"
        data-testid={testId}
      >
        Revoke
      </Button>
    );
  }

  // idle / failed: clickable danger button
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
      <Button variant="danger" size="sm" onClick={() => void onClick()} data-testid={testId}>
        {phase === "failed" ? "Retry revoke" : "Revoke"}
      </Button>
      {error !== null && (
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
      )}
    </div>
  );
}
