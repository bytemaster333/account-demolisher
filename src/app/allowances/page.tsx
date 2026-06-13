"use client";

// allowance viewer — paste a g/c address and list active SEP-41 allowances with per-row revoke

import { StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AllowanceList } from "@/components/allowance-viewer/AllowanceList";
import { AppShell } from "@/components/layout/AppShell";
import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
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
  // connector is created lazily on demand. it's only used inside click handlers,
  // so the ref never participates in render
  const connectorRef = useRef<Connector | null>(null);
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

  // mint a WalletKitConnector lazily whenever the store has a connected wallet so that
  useEffect(() => {
    if (publicKey === null) {
      connectorRef.current = null;
      return;
    }
    if (connectorRef.current === null) {
      connectorRef.current = new WalletKitConnector(network);
    }
  }, [publicKey, network]);

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
  const canRevoke = publicKey !== null && viewedAddress !== null && publicKey === viewedAddress;

  const hasWallet = publicKey !== null;
  const allowInput = records === null && !loading && error === null;
  const allowEmpty = records !== null && !loading && records.length === 0;

  return (
    <AppShell>
      <main
        style={{
          maxWidth: 980,
          margin: "0 auto",
          padding: "40px 28px 96px",
        }}
      >
        <div
          style={{
            font: "600 12px/1 Geist, sans-serif",
            color: "var(--accent)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: 13,
          }}
        >
          Allowance viewer
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 36,
            fontWeight: 600,
            letterSpacing: "-0.03em",
          }}
        >
          Active token allowances
        </h1>
        <p
          style={{
            margin: "13px 0 28px",
            fontSize: 16,
            lineHeight: 1.55,
            color: "var(--fg-2)",
            maxWidth: 560,
          }}
        >
          Inspect every active SEP-41 approval on any account. Revoke standing allowances to known,
          or unknown, spenders. No demolition required.
        </p>

        {/* search bar */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: 18,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.currentTarget.value)}
              placeholder="G… or C… address"
              spellCheck={false}
              autoComplete="off"
              aria-label="Stellar address"
              data-testid="address-input"
              style={{
                flex: 1,
                minWidth: 240,
                padding: "13px 15px",
                borderRadius: 11,
                border: "1px solid var(--border-2)",
                background: "var(--surface-2)",
                color: "var(--fg)",
                font: "500 13px/1.3 'Geist Mono', monospace",
                boxSizing: "border-box",
              }}
            />
            {hasWallet ? (
              <button
                type="button"
                onClick={onUseWallet}
                data-testid="use-wallet-button"
                style={{
                  padding: "13px 16px",
                  borderRadius: 11,
                  border: "1px solid var(--border-2)",
                  background: "var(--surface)",
                  color: "var(--fg)",
                  fontWeight: 600,
                  fontSize: 13.5,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Use connected wallet
              </button>
            ) : null}
            <button
              type="button"
              onClick={onLoad}
              disabled={loading || address.trim().length === 0}
              data-testid="load-allowances-button"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "13px 20px",
                borderRadius: 11,
                border: "none",
                background: "var(--accent)",
                color: "var(--accent-fg)",
                fontWeight: 600,
                fontSize: 14,
                cursor: loading || address.trim().length === 0 ? "not-allowed" : "pointer",
                opacity: loading || address.trim().length === 0 ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              {loading ? "Scanning…" : "Scan"}
            </button>
          </div>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showExpired}
              onChange={(e) => setShowExpired(e.currentTarget.checked)}
              data-testid="show-expired-toggle"
              style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
            />
            <span style={{ fontSize: 13, color: "var(--fg-2)" }}>Show expired allowances</span>
          </label>
          {error !== null ? (
            <p
              role="alert"
              data-testid="allowance-error"
              style={{
                margin: "12px 0 0",
                fontSize: 13,
                color: "var(--danger)",
              }}
            >
              {error}
            </p>
          ) : null}
          {viewedAddress !== null && publicKey !== null && publicKey !== viewedAddress ? (
            <p
              role="status"
              style={{
                margin: "12px 0 0",
                fontSize: 12.5,
                color: "var(--warning)",
              }}
            >
              Viewing <code style={{ fontFamily: "'Geist Mono', monospace" }}>{viewedAddress}</code>{" "}
              in read-only mode. To revoke, connect the wallet that owns this address.
            </p>
          ) : null}
        </div>

        {/* input prompt */}
        {allowInput ? (
          <div
            data-testid="allowance-initial-empty"
            style={{
              marginTop: 18,
              border: "1px dashed var(--border-2)",
              borderRadius: 16,
              padding: "54px 24px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                margin: "0 auto 16px",
                borderRadius: 13,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fg-3)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>Enter an address to scan</div>
            <div style={{ fontSize: 13.5, color: "var(--fg-2)", marginTop: 6 }}>
              A live RPC scan of{" "}
              <span style={{ fontFamily: "'Geist Mono', monospace" }}>approve</span> events
              typically takes 5–15 seconds.
            </div>
          </div>
        ) : null}

        {/* loading */}
        {loading ? (
          <div
            style={{
              marginTop: 18,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              borderRadius: 16,
              padding: "54px 24px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                margin: "0 auto 18px",
                borderRadius: "50%",
                border: "3px solid var(--accent-soft)",
                borderTopColor: "var(--accent)",
                animation: "spin .8s linear infinite",
              }}
            />
            <div style={{ fontWeight: 600, fontSize: 15 }}>Scanning approve events…</div>
            <div
              style={{
                fontSize: 13,
                color: "var(--fg-2)",
                marginTop: 6,
                fontFamily: "'Geist Mono', monospace",
              }}
            >
              retention-clamped to the last 30 days
            </div>
          </div>
        ) : null}

        {/* list */}
        {records !== null && !loading ? (
          allowEmpty ? (
            <div
              data-testid="allowance-list-empty-wrapper"
              style={{
                marginTop: 18,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 16,
                overflow: "hidden",
                boxShadow: "var(--shadow-sm)",
                padding: "54px 24px",
                textAlign: "center",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>No active allowances found</div>
              <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 6 }}>
                This address has no standing approvals in the scanned window.
              </div>
            </div>
          ) : (
            <AllowanceList
              records={records}
              userAddress={viewedAddress ?? ""}
              network={network}
              currentLedger={currentLedger ?? 0}
              connectorRef={canRevoke ? connectorRef : null}
              showExpired={showExpired}
              onRevoked={onRevoked}
            />
          )
        ) : null}
      </main>
    </AppShell>
  );
}
