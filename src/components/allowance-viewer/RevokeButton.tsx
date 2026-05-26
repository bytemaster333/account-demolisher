"use client";

// per-row revoke action: builds + signs + submits an approve(amount=0) tx for the row's allowance

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useState } from "react";

import { buildRevoke, type AllowanceRecord } from "@/lib/soroban/allowances";
import type { NetworkConfig } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { cn } from "@/lib/utils";
import type { Connector } from "@/lib/wallet/connector";

export interface RevokeButtonProps {
  readonly record: AllowanceRecord;
  readonly userAddress: string;
  readonly network: NetworkConfig;
  // null = disabled. ref is read only in the click handler (react-hooks/refs forbids during render).
  readonly connectorRef: React.RefObject<Connector | null> | null;
  // explicit `| undefined` keeps this forwardable under exactOptionalPropertyTypes
  readonly onRevoked?: ((record: AllowanceRecord, txHash: string) => void) | undefined;
  readonly className?: string | undefined;
}

type Phase = "idle" | "building" | "signing" | "submitting" | "confirmed" | "failed";

export function RevokeButton({
  record,
  userAddress,
  network,
  connectorRef,
  onRevoked,
  className,
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

      // PENDING is success-on-enqueue. user can re-load the list to confirm finality.
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
  const disabled =
    noConnector ||
    phase === "building" ||
    phase === "signing" ||
    phase === "submitting" ||
    phase === "confirmed";
  const label = (() => {
    switch (phase) {
      case "building":
        return "Building…";
      case "signing":
        return "Signing…";
      case "submitting":
        return "Submitting…";
      case "confirmed":
        return "Revoked";
      case "failed":
        return "Retry revoke";
      default:
        return noConnector ? "Revoke (connect wallet)" : "Revoke";
    }
  })();

  return (
    <div className={cn("flex flex-col items-start gap-1", className)}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-testid={`revoke-button-${record.contractId}-${record.spender}`}
        className={cn(
          "inline-flex items-center justify-center rounded-md px-3 py-1.5",
          "text-xs font-medium transition-colors",
          phase === "confirmed"
            ? "bg-emerald-700 text-white"
            : "bg-red-700 text-white hover:bg-red-800",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {label}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      {txHash !== null && phase === "confirmed" && (
        <p className="text-xs text-emerald-700">
          tx: <code className="font-mono">{txHash.slice(0, 12)}…</code>
        </p>
      )}
    </div>
  );
}
