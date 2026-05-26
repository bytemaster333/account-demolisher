"use client";

// allowance viewer — paste a G/C address and list active SEP-41 allowances with per-row revoke

import { StrKey } from "@stellar/stellar-sdk";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AllowanceList } from "@/components/allowance-viewer/AllowanceList";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import { cn } from "@/lib/utils";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { useWalletStore } from "@/stores/wallet";

const STELLAR_ADDRESS = z
  .string()
  .min(1, { message: "Address is required." })
  .refine((v) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v), {
    message: "Not a valid Stellar G... or C... address.",
  });

export default function AllowancesPage(): React.JSX.Element {
  const connectorRef = useRef<Connector | null>(null);
  const [hasConnector, setHasConnector] = useState(false);
  const publicKey = useWalletStore((s) => s.publicKey);

  const network = useMemo<NetworkConfig>(() => {
    return resolveNetwork(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK);
  }, []);

  const [address, setAddress] = useState<string>("");
  const [viewedAddress, setViewedAddress] = useState<string | null>(null);
  const [records, setRecords] = useState<readonly AllowanceRecord[] | null>(null);
  const [currentLedger, setCurrentLedger] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExpired, setShowExpired] = useState(false);

  const setConnector = useCallback((c: WalletKitConnector | null) => {
    connectorRef.current = c;
    setHasConnector(c !== null);
  }, []);

  const onUseWallet = useCallback(() => {
    if (publicKey !== null) {
      setAddress(publicKey);
    }
  }, [publicKey]);

  const onLoad = useCallback(async () => {
    setError(null);
    setRecords(null);
    setCurrentLedger(null);

    const parsed = STELLAR_ADDRESS.safeParse(address.trim());
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join("; "));
      return;
    }
    const target = parsed.data;

    setLoading(true);
    try {
      const rpc = getRpc(network);
      const latest = await rpc.getLatestLedger();
      const ledger = latest.sequence;
      const list = await enumerateAllowances(rpc, target, ledger, undefined, {
        includeExpired: true,
      });
      setRecords(list);
      setCurrentLedger(ledger);
      setViewedAddress(target);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load allowances.");
    } finally {
      setLoading(false);
    }
  }, [address, network]);

  const onRevoked = useCallback(() => {
    // re-enumerate after a revoke instead of mutating the list locally
    void onLoad();
  }, [onLoad]);

  // revoke needs the connected wallet to own the viewed address (SEP-41 requires source == from)
  const canRevoke =
    hasConnector && viewedAddress !== null && publicKey !== null && publicKey === viewedAddress;

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-10">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Allowance Viewer</h1>
        <Link href="/" className="text-xs underline text-slate-600 hover:text-slate-900">
          Home
        </Link>
      </header>
      <p className="text-sm text-slate-700">
        Inspect and revoke active SEP-41 token allowances for any Stellar address. Paste a G… or C…
        address, or use your connected wallet. Network:{" "}
        <code className="font-mono">{network.id}</code>.
      </p>

      <section className="flex flex-col gap-2 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">Wallet (optional)</h2>
        <p className="text-xs text-slate-600">
          Connect a wallet to revoke allowances. View-only mode does not require a wallet.
        </p>
        <ConnectButton network={network} onConnector={setConnector} />
        {publicKey !== null ? (
          <p className="text-xs text-slate-600">
            Connected as <code className="font-mono">{publicKey}</code>
          </p>
        ) : null}
        <input
          type="hidden"
          data-testid="connector-ready"
          value={hasConnector ? "true" : "false"}
          readOnly
        />
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">Address</h2>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            placeholder="G... or C..."
            spellCheck={false}
            autoComplete="off"
            aria-label="Stellar address"
            data-testid="address-input"
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
          />
          <button
            type="button"
            onClick={onUseWallet}
            disabled={publicKey === null}
            data-testid="use-wallet-button"
            className={cn(
              "rounded-md px-3 py-2 text-xs font-medium transition-colors",
              "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Use connected wallet
          </button>
          <button
            type="button"
            onClick={onLoad}
            disabled={loading || address.trim().length === 0}
            data-testid="load-allowances-button"
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium transition-colors",
              "bg-slate-900 text-white hover:bg-slate-800",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {loading ? "Loading…" : "Load Allowances"}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={showExpired}
            onChange={(e) => setShowExpired(e.currentTarget.checked)}
            data-testid="show-expired-toggle"
          />
          Show expired allowances
        </label>
        {error !== null ? (
          <p role="alert" data-testid="allowance-error" className="text-xs text-red-600">
            {error}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4">
        <h2 className="text-base font-semibold">Allowances</h2>
        {records === null ? (
          <p
            role="status"
            data-testid="allowance-initial-empty"
            className="rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600"
          >
            Enter a Stellar address above and click <strong>Load Allowances</strong> to scan.
          </p>
        ) : (
          <>
            {viewedAddress !== null && publicKey !== null && publicKey !== viewedAddress ? (
              <p
                role="status"
                className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-900"
              >
                Viewing <code className="font-mono">{viewedAddress}</code> in read-only mode. To
                revoke, connect the wallet that owns this address.
              </p>
            ) : null}
            <AllowanceList
              records={records}
              userAddress={viewedAddress ?? ""}
              network={network}
              currentLedger={currentLedger ?? 0}
              connectorRef={canRevoke ? connectorRef : null}
              showExpired={showExpired}
              onRevoked={onRevoked}
            />
          </>
        )}
      </section>
    </main>
  );
}
