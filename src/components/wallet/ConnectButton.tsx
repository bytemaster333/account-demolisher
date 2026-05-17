"use client";

// wallet-kit entry point. opens the auth modal and pushes the address into the zustand store.

import { useCallback, useEffect, useState } from "react";

import { TESTNET, type NetworkConfig } from "@/lib/config/networks";
import { cn } from "@/lib/utils";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { useWalletStore } from "@/stores/wallet";

export interface ConnectButtonProps {
  // defaults to testnet
  network?: NetworkConfig;
  // receives the live connector after connect, or null after disconnect
  onConnector?: (connector: WalletKitConnector | null) => void;
  className?: string;
}

function truncate(publicKey: string): string {
  if (publicKey.length <= 12) return publicKey;
  return `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`;
}

export function ConnectButton({
  network = TESTNET,
  onConnector,
  className,
}: ConnectButtonProps): React.JSX.Element {
  const publicKey = useWalletStore((s) => s.publicKey);
  const connectorKind = useWalletStore((s) => s.connectorKind);
  const setConnected = useWalletStore((s) => s.setConnected);
  const disconnectStore = useWalletStore((s) => s.disconnect);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connector, setConnectorLocal] = useState<WalletKitConnector | null>(null);

  // keep the parent in sync with our local connector ref
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
      // kit rejects with { code, message } on modal-close; surface a readable line and let the user retry
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
      // disconnect failures (e.g. WalletConnect already torn down) shouldn't block clearing local state
    } finally {
      setConnectorLocal(null);
      disconnectStore();
      setPending(false);
    }
  }, [connector, disconnectStore]);

  const isConnected = publicKey !== null && connectorKind === "kit";

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <button
        type="button"
        onClick={isConnected ? onDisconnect : onConnect}
        disabled={pending}
        aria-label={isConnected ? "Disconnect wallet" : "Connect wallet"}
        data-testid="connect-button"
        data-public-key={isConnected ? publicKey : ""}
        className={cn(
          "inline-flex items-center justify-center rounded-md px-4 py-2",
          "text-sm font-medium transition-colors",
          "bg-slate-900 text-white hover:bg-slate-800",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {pending
          ? isConnected
            ? "Disconnecting…"
            : "Connecting…"
          : isConnected
            ? truncate(publicKey)
            : "Connect wallet"}
      </button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
