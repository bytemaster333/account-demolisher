"use client";

// wallet-kit entry point. opens the auth modal and pushes the address into the zustand store

import { useCallback, useEffect, useState } from "react";

import { describeConnectError } from "@/components/wallet/connect-error";
import { walletTeardownNotice } from "@/components/wallet/teardown-message";
import type { NetworkConfig } from "@/lib/config/networks";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { disconnectSession, setActiveConnector } from "@/lib/wallet/active-connector";
import { useWalletStore } from "@/stores/wallet";
import { shortAddress } from "@/lib/safe-display";

export interface ConnectButtonProps {
  network: NetworkConfig;
  onConnector?: (connector: WalletKitConnector | null) => void;
}

export function ConnectButton({ network, onConnector }: ConnectButtonProps): React.JSX.Element {
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);
  const setConnected = useWalletStore((s) => s.setConnected);
  const disconnectStore = useWalletStore((s) => s.disconnect);

  // which action is running, not just that one is: disconnectSession clears the
  // store before it waits on the wallet, so isConnected can't tell the two apart
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connector, setConnectorLocal] = useState<WalletKitConnector | null>(null);

  useEffect(() => {
    onConnector?.(connector);
  }, [connector, onConnector]);

  const onConnect = useCallback(async () => {
    setError(null);
    setBusy("connect");
    try {
      const next = new WalletKitConnector(network);
      const { publicKey: address } = await next.connect();
      setConnectorLocal(next);
      // share the live connector app-wide so other pages (e.g. /allowances) can
      // sign with it after a client-side navigation
      setActiveConnector(next);
      setConnected(address, "kit");
    } catch (e: unknown) {
      // closing the picker is a cancel, not an error; anything else keeps the
      // wallet's own reason (unsupported network, ledger app closed, declined)
      setError(describeConnectError(e));
    } finally {
      setBusy(null);
    }
  }, [network, setConnected]);

  // every disconnect goes through disconnectSession so the connector, the store
  // and the kit's persisted selection are torn down together. the app lets go
  // either way; a failed wallet teardown (a walletconnect pairing left live on
  // the phone) is said here instead of only in the console
  const onDisconnect = useCallback(async () => {
    setError(null);
    setBusy("disconnect");
    try {
      await disconnectSession(disconnectStore, (e) => setError(walletTeardownNotice(e)));
    } finally {
      setConnectorLocal(null);
      setBusy(null);
    }
  }, [disconnectStore]);

  const isConnected = publicKey !== null && connectorKind === "kit";
  const label =
    busy === "disconnect"
      ? "Disconnecting…"
      : busy === "connect"
        ? "Connecting…"
        : isConnected
          ? shortAddress(publicKey)
          : "Connect wallet";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={isConnected ? onDisconnect : onConnect}
        disabled={busy !== null}
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
          cursor: busy !== null ? "not-allowed" : "pointer",
          opacity: busy !== null ? 0.6 : 1,
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
