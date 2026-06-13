"use client";

// wallet-kit entry point. opens the auth modal and pushes the address into the zustand store

import { useCallback, useEffect, useState } from "react";

import { TESTNET, type NetworkConfig } from "@/lib/config/networks";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { useWalletStore } from "@/stores/wallet";

export interface ConnectButtonProps {
  network?: NetworkConfig;
  onConnector?: (connector: WalletKitConnector | null) => void;
}

function truncate(publicKey: string): string {
  if (publicKey.length <= 12) return publicKey;
  return `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`;
}

export function ConnectButton({
  network = TESTNET,
  onConnector,
}: ConnectButtonProps): React.JSX.Element {
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);
  const setConnected = useWalletStore((s) => s.setConnected);
  const disconnectStore = useWalletStore((s) => s.disconnect);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connector, setConnectorLocal] = useState<WalletKitConnector | null>(null);

  useEffect(() => {
    onConnector?.(connector);
  }, [connector, onConnector]);

  const onConnect = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      const next = new WalletKitConnector(network);
      const { publicKey: address } = await next.connect();
      setConnectorLocal(next);
      setConnected(address, "kit");
    } catch (e: unknown) {
      const message =
        e instanceof Error
          ? e.message
          : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message: unknown }).message)
            : "Failed to connect wallet.";
      setError(message);
    } finally {
      setPending(false);
    }
  }, [network, setConnected]);

  const onDisconnect = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      if (connector) {
        await connector.disconnect();
      }
    } catch {
      // disconnect may already be torn down (e.g. WalletConnect); clear local state regardless
    } finally {
      setConnectorLocal(null);
      disconnectStore();
      setPending(false);
    }
  }, [connector, disconnectStore]);

  const isConnected = publicKey !== null && connectorKind === "kit";
  const label = pending
    ? isConnected
      ? "Disconnecting…"
      : "Connecting…"
    : isConnected
      ? truncate(publicKey)
      : "Connect wallet";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={isConnected ? onDisconnect : onConnect}
        disabled={pending}
        aria-label={isConnected ? "Disconnect wallet" : "Connect wallet"}
        data-testid="connect-button"
        data-public-key={isConnected ? publicKey : ""}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          alignSelf: "flex-start",
          height: 38,
          padding: "0 18px",
          borderRadius: 9,
          border: isConnected ? "1px solid var(--border-2)" : "none",
          background: isConnected ? "var(--surface-2)" : "var(--accent)",
          color: isConnected ? "var(--fg)" : "var(--accent-fg)",
          fontWeight: 600,
          fontSize: 13.5,
          letterSpacing: "-0.01em",
          cursor: pending ? "not-allowed" : "pointer",
          opacity: pending ? 0.6 : 1,
          fontFamily: isConnected ? '"Geist Mono", ui-monospace, monospace' : "inherit",
          whiteSpace: "nowrap",
        }}
      >
        {isConnected ? (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--success)",
            }}
          />
        ) : null}
        {label}
      </button>
      {error !== null ? (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: 12,
            color: "var(--danger)",
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
