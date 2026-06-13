"use client";

// per-row revoke action: builds + signs + submits an approve(amount=0) tx for the row's allowance

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useState } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import { buildRevoke, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { getHorizon } from "@/lib/stellar/horizon-client";
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

type Phase = "idle" | "building" | "signing" | "submitting" | "confirmed" | "failed";

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
  const [hover, setHover] = useState(false);

  const onClick = useCallback(async () => {
    setError(null);
    // read ref only here, never during render
    const connector = connectorRef?.current ?? null;
    if (connector === null) {
      setError("Connect a wallet first.");
      return;
    }
    try {
      // immediate expiry on top of amount=0
      setPhase("building");
      const rpc = getRpc(network);
      const { sequence: currentLedger } = await rpc.getLatestLedger();

      const horizon = getHorizon(network);
      const sourceAccount = await horizon.loadAccount(userAddress);

      const tx: Transaction = await buildRevoke(
        rpc,
        record.contractId,
        userAddress,
        record.spender,
        currentLedger,
        network,
        sourceAccount,
      );

      setPhase("signing");
      const signed = await connector.signTransaction(tx, network.passphrase);

      setPhase("submitting");
      const reconstructed = TransactionBuilder.fromXDR(
        signed.signedXdr,
        network.passphrase,
      ) as Transaction;
      const send = await rpc.sendTransaction(reconstructed);

      // PENDING is success-on-enqueue. user can re-load the list to confirm finality
      const submitHash = send.hash;
      if (send.status === "ERROR") {
        const detail = send.errorResult ? ` (${send.errorResult.result().switch().name})` : "";
        throw new Error(`RPC rejected transaction${detail}.`);
      }
      setTxHash(submitHash);
      setPhase("confirmed");
      onRevoked?.(record, submitHash);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Revoke failed.";
      setError(message);
      setPhase("failed");
    }
  }, [connectorRef, network, record, userAddress, onRevoked]);

  // render-safe disabled signal — parent passes null when no wallet or wrong wallet
  const noConnector = connectorRef === null;
  const inFlight = phase === "building" || phase === "signing" || phase === "submitting";

  // confirmed: green check + "Revoked"
  if (phase === "confirmed") {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <span
          data-testid={`revoke-button-${record.contractId}-${record.spender}`}
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
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Revoked
        </span>
        {txHash !== null && (
          <span
            style={{
              fontSize: 11,
              color: "var(--success)",
              fontFamily: "'Geist Mono', monospace",
            }}
          >
            tx {txHash.slice(0, 10)}…
          </span>
        )}
      </div>
    );
  }

  // in-flight: spinner + "Revoking…"
  if (inFlight) {
    return (
      <span
        data-testid={`revoke-button-${record.contractId}-${record.spender}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontWeight: 600,
          fontSize: 13,
          color: "var(--fg-2)",
        }}
      >
        <span
          style={{
            width: 13,
            height: 13,
            borderRadius: "50%",
            border: "2px solid var(--border-2)",
            borderTopColor: "var(--accent)",
            animation: "spin .8s linear infinite",
          }}
        />
        Revoking…
      </span>
    );
  }

  // disabled (no wallet connected, or wallet doesn't own this address)
  if (noConnector) {
    return (
      <span
        title="Connect a wallet to revoke"
        data-testid={`revoke-button-${record.contractId}-${record.spender}`}
        style={{
          padding: "8px 14px",
          borderRadius: 9,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: "var(--fg-3)",
          fontWeight: 600,
          fontSize: 13,
          cursor: "not-allowed",
          display: "inline-block",
        }}
      >
        Revoke
      </span>
    );
  }

  const label = phase === "failed" ? "Retry revoke" : "Revoke";

  // idle / failed: clickable button
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        data-testid={`revoke-button-${record.contractId}-${record.spender}`}
        style={{
          padding: "8px 14px",
          borderRadius: 9,
          border: `1px solid ${hover ? "var(--danger)" : "var(--border-2)"}`,
          background: "var(--surface)",
          color: hover ? "var(--danger)" : "var(--fg)",
          fontWeight: 600,
          fontSize: 13,
          cursor: "pointer",
          transition: "border-color .12s, color .12s",
        }}
      >
        {label}
      </button>
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
