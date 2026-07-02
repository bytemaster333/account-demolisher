"use client";

// wallet-kit entry point. opens the auth modal and pushes the address into the zustand store

import { useCallback, useEffect, useState } from "react";

import { TESTNET, type NetworkConfig } from "@/lib/config/networks";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { setActiveConnector } from "@/lib/wallet/active-connector";
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
      // share the live connector app-wide so other pages (e.g. /allowances) can
      // sign with it after a client-side navigation
      setActiveConnector(next);
      setConnected(address, "kit");
    } catch {
      // lead with a plain, actionable message rather than a raw library error;
      // the underlying wallet failures aren't meaningful to a beginner
      setError(
        "Couldn't connect to your wallet. Make sure the wallet extension is installed and unlocked, then try again.",
      );
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
      setActiveConnector(null);
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
        // this button only renders the button + error text, so there's no inline
        // spot for reassurance copy; the connect screen shows the "only your public
        // address is shared" note. keep the intent accessible on the button itself.
        aria-label={
          isConnected
            ? `Wallet connected as ${publicKey}. Activate to disconnect.`
            : "Connect wallet: this only shares your public address, never your secret key"
        }
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
          border: `1px solid ${isConnected ? "var(--border-2)" : "var(--accent-line)"}`,
          background: "transparent",
          color: isConnected ? "var(--fg)" : "var(--accent)",
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
          <>
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--success)",
              }}
            />
            {/* text equivalent so the connected state isn't conveyed by color alone */}
            <span
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: "hidden",
                clip: "rect(0, 0, 0, 0)",
                whiteSpace: "nowrap",
                border: 0,
              }}
            >
              Connected:
            </span>
          </>
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
