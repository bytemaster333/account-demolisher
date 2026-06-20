"use client";

// allowance viewer — paste a g/c address and list active SEP-41 allowances with per-row revoke

import { StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AllowanceList } from "@/components/allowance-viewer/AllowanceList";
import { AppShell } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Notice,
  PageContainer,
  PageHeader,
  SearchGlyph,
  Spinner,
} from "@/components/ui";
import { getPublicEnv } from "@/lib/config/env";
import { errorMessage } from "@/lib/errors";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { getActiveConnector } from "@/lib/wallet/active-connector";
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
  const connectorKind = useWalletStore((s) => s.connectorKind);

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

  // resolve the live signing connector for the connected wallet. Prefer the
  // app-wide active connector (set at connect time, survives client-side
  // navigation) — this is the ONLY way a pasted-seed connection can sign here,
  // since its seed is never persisted. Fall back to reconstructing a
  // WalletKitConnector for a "kit" connection whose live object was lost (the
  // kit reads its own persisted selection). A "secret" connection with no live
  // connector stays unsignable, so revoke is correctly gated off below.
  useEffect(() => {
    if (publicKey === null) {
      connectorRef.current = null;
      return;
    }
    const active = getActiveConnector();
    if (active !== null) {
      connectorRef.current = active;
      return;
    }
    connectorRef.current = connectorKind === "kit" ? new WalletKitConnector(network) : null;
  }, [publicKey, connectorKind, network]);

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
      setError(errorMessage(e, "Failed to load allowances."));
    } finally {
      setLoading(false);
    }
  }, [address, network]);

  const onRevoked = useCallback(() => {
    // re-enumerate after a revoke instead of mutating the list locally
    void onLoad();
  }, [onLoad]);

  // revoke needs the connected wallet to own the viewed address (SEP-41 requires
  // source == from) AND a live connector that can actually sign here — a
  // pasted-seed session whose connector didn't survive to this page cannot, so
  // don't present an actionable Revoke we can't fulfill.
  const canRevoke =
    publicKey !== null &&
    viewedAddress !== null &&
    publicKey === viewedAddress &&
    (getActiveConnector() !== null || connectorKind === "kit");

  const hasWallet = publicKey !== null;
  const wrongWallet = viewedAddress !== null && publicKey !== null && publicKey !== viewedAddress;
  const allowInput = records === null && !loading && error === null;
  const allowEmpty = records !== null && !loading && records.length === 0;

  return (
    <AppShell>
      <PageContainer width={1080}>
        <PageHeader
          kicker="Allowance viewer"
          title="Active token allowances"
          subtitle="Inspect every active SEP-41 approval on any account, then revoke standing approvals to known — or unknown — spenders. No demolition required."
        />

        {/* search */}
        <Card padding={18}>
          <Field
            value={address}
            onChange={setAddress}
            onEnter={() => void onLoad()}
            placeholder="G… or C… address to inspect"
            mono
            spellCheck={false}
            autoComplete="off"
            aria-label="Stellar address"
            data-testid="address-input"
            error={error}
            right={
              <Button
                onClick={() => void onLoad()}
                disabled={address.trim().length === 0}
                loading={loading}
                iconLeft={loading ? undefined : <SearchGlyph size={15} />}
                data-testid="load-allowances-button"
              >
                {loading ? "Scanning…" : "Scan"}
              </Button>
            }
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 14,
            }}
          >
            <Checkbox
              checked={showExpired}
              onChange={setShowExpired}
              label="Show expired allowances"
              data-testid="show-expired-toggle"
            />
            {hasWallet ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onUseWallet}
                data-testid="use-wallet-button"
              >
                Use connected wallet
              </Button>
            ) : null}
          </div>
          {wrongWallet ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warning" role="status">
                Viewing{" "}
                <code style={{ fontFamily: '"Geist Mono", monospace' }}>
                  {viewedAddress!.slice(0, 6)}…{viewedAddress!.slice(-6)}
                </code>{" "}
                in read-only mode. To revoke, connect the wallet that owns this address.
              </Notice>
            </div>
          ) : null}
        </Card>

        {/* results */}
        <div style={{ marginTop: 18 }}>
          {allowInput ? (
            <EmptyState
              data-testid="allowance-initial-empty"
              icon={<SearchGlyph />}
              title="Enter an address to scan"
              body={
                <>
                  A live RPC scan of{" "}
                  <code style={{ fontFamily: '"Geist Mono", monospace' }}>approve</code> events
                  typically takes 5–15 seconds.
                </>
              }
            />
          ) : null}

          {loading ? (
            <Card style={{ padding: "48px 24px", textAlign: "center" }}>
              <div style={{ display: "grid", placeItems: "center", marginBottom: 16 }}>
                <Spinner size={38} />
              </div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>Scanning approve events…</div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--fg-3)",
                  marginTop: 6,
                  fontFamily: '"Geist Mono", monospace',
                }}
              >
                retention-clamped to the last 30 days
              </div>
            </Card>
          ) : null}

          {records !== null && !loading ? (
            allowEmpty ? (
              <EmptyState
                dashed={false}
                data-testid="allowance-list-empty-wrapper"
                title="No active allowances found"
                body="This address has no standing approvals in the scanned window."
              />
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
        </div>
      </PageContainer>
    </AppShell>
  );
}
