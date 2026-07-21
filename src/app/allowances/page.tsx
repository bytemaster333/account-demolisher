"use client";

// allowance viewer: paste a g/c address and list active SEP-41 allowances with per-row revoke

import { StrKey } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { AllowanceList } from "@/components/allowance-viewer/AllowanceList";
import { BulkRevokeBar } from "@/components/allowance-viewer/BulkRevokeBar";
import { AppShell } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  Checkbox,
  CopyableAddress,
  EmptyState,
  Field,
  InfoTip,
  Notice,
  PageContainer,
  PageHeader,
  SearchGlyph,
} from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl } from "@/lib/explorer";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import { getRpc } from "@/lib/soroban/rpc-client";
import type { Connector } from "@/lib/wallet/connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { getActiveConnector } from "@/lib/wallet/active-connector";
import { useNetworkStore } from "@/stores/network";
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

  const networkId = useNetworkStore((s) => s.networkId);
  const network = useMemo<NetworkConfig>(() => resolveNetwork(networkId), [networkId]);

  const [address, setAddress] = useState<string>("");
  const [viewedAddress, setViewedAddress] = useState<string | null>(null);
  const [records, setRecords] = useState<readonly AllowanceRecord[] | null>(null);
  const [currentLedger, setCurrentLedger] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExpired, setShowExpired] = useState(false);

  // resolve the live signing connector for the connected wallet. Prefer the
  // app-wide active connector (set at connect time, survives client-side
  // navigation). This is the ONLY way a pasted-seed connection can sign here,
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

  // monotonic scan id. every scan captures its id and only commits results if it
  // is still the latest, so a slow scan that a network switch (or a newer scan)
  // superseded can't write stale, cross-network results into state.
  const loadSeq = useRef(0);

  const onLoad = useCallback(async () => {
    const seq = ++loadSeq.current;
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
      if (loadSeq.current !== seq) return; // superseded (network switch or newer scan)
      setRecords(list);
      setCurrentLedger(ledger);
      setViewedAddress(target);
    } catch (e: unknown) {
      if (loadSeq.current !== seq) return;
      setError(errorMessage(e, "Failed to load allowances."));
    } finally {
      if (loadSeq.current === seq) setLoading(false);
    }
  }, [address, network]);

  // switching networks invalidates any results and any in-flight scan: the
  // viewed address, ledger, and per-row token metadata are all network-scoped.
  // clear them and bump the scan id so a pending scan's late completion is
  // ignored. skip the initial mount (only an actual switch should clear).
  const seenNetworkId = useRef(networkId);
  useEffect(() => {
    if (seenNetworkId.current === networkId) return;
    seenNetworkId.current = networkId;
    loadSeq.current++;
    setRecords(null);
    setViewedAddress(null);
    setCurrentLedger(null);
    setError(null);
    setLoading(false);
  }, [networkId]);

  const onRevoked = useCallback(() => {
    // re-enumerate after a revoke instead of mutating the list locally
    void onLoad();
  }, [onLoad]);

  // revoke needs the connected wallet to own the viewed address (SEP-41 requires
  // source == from) AND a live connector that can actually sign here. A
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
  // disconnected, but the scanned address has at least one still-active allowance
  // that COULD be revoked with the owning wallet. Prompt to connect proactively,
  // rather than leaving the user to discover it from a disabled Revoke button.
  const notConnectedWithRevocable =
    !hasWallet && records !== null && records.some((r) => !r.expired);

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          kicker="Allowance viewer"
          title="Active token allowances"
          subtitle={
            <>
              Every active{" "}
              <InfoTip tip="SEP-41 is Stellar's standard for smart-contract (Soroban) tokens. An allowance is a standing approval that lets another address spend your tokens up to a limit, until it expires or you revoke it.">
                SEP-41
              </InfoTip>{" "}
              allowance on an account, so you can review and revoke the ones you no longer want.
            </>
          }
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
                Scan my own address
              </Button>
            ) : null}
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
            Looking up an address is read-only and free. Connect a wallet only when you want to
            revoke an allowance on an account you own.
          </p>
          {wrongWallet ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warning" role="status">
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}
                >
                  Viewing
                  <CopyableAddress
                    value={viewedAddress!}
                    label="Viewed address"
                    head={6}
                    tail={6}
                    size={12}
                    href={explorerAccountUrl(network, viewedAddress!)}
                  />
                  in read-only mode, which is fine for inspecting. Only the wallet that controls
                  this address can revoke its allowances, so to revoke, connect that wallet.
                </span>
              </Notice>
            </div>
          ) : notConnectedWithRevocable ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="accent" role="status" title="Connect a wallet to revoke">
                Reviewing is read-only and free. To revoke an allowance here, connect the wallet
                that owns this address using Connect wallet in the top right.
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
            />
          ) : null}

          {loading ? <ScanningCard /> : null}

          {records !== null && !loading ? (
            allowEmpty ? (
              <EmptyState
                dashed={false}
                data-testid="allowance-list-empty-wrapper"
                title="No active allowances found"
                body="No approvals were found for this address in about the last 7 days of on-chain history (the RPC's event-retention limit). An older, still-standing approval may not be discoverable by this scan."
              />
            ) : (
              <>
                <BulkRevokeBar
                  records={records}
                  userAddress={viewedAddress ?? ""}
                  network={network}
                  connectorRef={canRevoke ? connectorRef : null}
                  onComplete={onRevoked}
                />
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
            )
          ) : null}
        </div>
      </PageContainer>
    </AppShell>
  );
}

const SCAN_QUIPS: readonly string[] = [
  "Reading approve events…",
  "Checking the spender directory…",
  "Measuring current spend limits…",
  "Sorting active from expired…",
];

// scanning stage: a medallion with a search glyph inside a slowly-rotating accent
// ring, plus a cycling sub-line. A step up from a bare spinner, in the spirit of
// the demolish "proving stage" loader, without pulling in its bespoke animation.
function ScanningCard(): React.JSX.Element {
  const [quip, setQuip] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setQuip((q) => (q + 1) % SCAN_QUIPS.length), 1600);
    return () => clearInterval(id);
  }, []);

  return (
    <Card style={{ padding: "44px 24px", textAlign: "center" }} data-testid="allowance-scanning">
      <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
        <div style={{ position: "relative", width: 58, height: 58 }}>
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: "3px solid var(--accent-soft)",
              borderTopColor: "var(--accent)",
              animation: "spin .9s linear infinite",
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 8,
              borderRadius: "50%",
              background: "var(--surface-2)",
              border: "1px solid var(--accent-line)",
              color: "var(--accent)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <SearchGlyph size={18} />
          </span>
        </div>
      </div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>Looking up allowances on-chain…</div>
      <div
        aria-live="polite"
        style={{ marginTop: 6, fontSize: 12.5, color: "var(--fg-3)", minHeight: 18 }}
      >
        {SCAN_QUIPS[quip]}
      </div>
    </Card>
  );
}
