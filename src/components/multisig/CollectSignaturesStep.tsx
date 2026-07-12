"use client";

// Inline "collect signatures" step for the multisig close flow. After the
// initiator creates a signing plan we DON'T send them off to /plan in another
// tab (that drops them out of the close flow). Instead this renders in place:
// the shareable link for the other signers, live progress, and the closed
// state, all polled here. /plan/<hash> remains the standalone page the OTHER
// signers open from the link.

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CopyableAddress, Notice, Progress, Spinner } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import { getStatus, type RefractorTxStatus } from "@/lib/multisig/refractor";
import { getHorizon } from "@/lib/stellar/horizon-client";

const POLL_MS = 8000;

export interface CollectSignaturesStepProps {
  readonly hash: string;
  readonly network: NetworkConfig;
  // the initiator's key, to tag their row "You"
  readonly connectedKey: string | null;
}

export function CollectSignaturesStep({
  hash,
  network,
  connectedKey,
}: CollectSignaturesStepProps): React.JSX.Element {
  const [status, setStatus] = useState<RefractorTxStatus | null>(null);
  const [closed, setClosed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const planUrl =
    typeof window !== "undefined" ? `${window.location.origin}/plan/${hash}` : `/plan/${hash}`;

  const poll = useCallback(async () => {
    setRefreshing(true);
    try {
      // Horizon is the source of truth for closure (the plan id IS the tx hash)
      let isClosed = false;
      try {
        const tx = (await getHorizon(network).transactions().transaction(hash).call()) as {
          successful?: boolean;
        };
        if (tx.successful === true) isClosed = true;
      } catch {
        // not on chain yet
      }
      const s = await getStatus(hash).catch(() => null);
      if (s !== null) setStatus(s);
      if (!isClosed && s?.submitted === true) isClosed = true;
      setClosed(isClosed);
    } finally {
      setRefreshing(false);
    }
  }, [hash, network]);

  // poll once immediately, then on an interval, until closed. The first poll is
  // scheduled (not called synchronously in the effect body) so it doesn't set
  // state during render; the interval stops once the account has closed.
  useEffect(() => {
    if (closed) return;
    const kickoff = setTimeout(() => void poll(), 0);
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      clearTimeout(kickoff);
      clearInterval(id);
    };
  }, [closed, poll]);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(planUrl);
    setCopied(true);
  }, [planUrl]);

  if (closed) {
    return (
      <div data-testid="collect-signatures-closed">
        <Notice
          tone="success"
          title="Enough signatures collected, the account is closed"
          role="status"
        >
          The transaction was submitted and the account has been closed. Any remaining XLM has been
          sent to your destination.{" "}
          <a
            href={explorerTxUrl(network, hash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
          >
            View transaction ↗
          </a>
        </Notice>
      </div>
    );
  }

  const knownSigners = status !== null && status.signers.length > 0;
  const signerCount = status?.signers.length ?? 0;
  const collected = status !== null ? Math.max(0, signerCount - status.signaturesNeeded) : 0;
  const signedSet = new Set(status?.signedBy ?? []);

  return (
    <Card padding={22} data-testid="collect-signatures-step">
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--accent)",
            boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)",
          }}
        />
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Waiting for the other signers
        </h3>
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--fg-2)" }}>
        Your signature is in. Send the link below to the other signers, they each open it and sign
        on their own device. Once enough have signed, the account closes automatically and this page
        updates, no need to keep it open.
      </p>

      {/* share link, the one thing the initiator does next */}
      <div style={{ marginTop: 16 }}>
        <div
          style={{ fontSize: 11.5, color: "var(--fg-3)", letterSpacing: "0.05em", marginBottom: 6 }}
        >
          SHARE WITH THE OTHER SIGNERS
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code
            data-testid="collect-plan-url"
            style={{
              flex: 1,
              minWidth: 220,
              padding: "10px 12px",
              borderRadius: 9,
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              font: "500 12px/1.4 'Geist Mono', monospace",
              color: "var(--fg-2)",
              wordBreak: "break-all",
            }}
          >
            {planUrl}
          </code>
          <Button variant="primary" size="sm" onClick={onCopy} data-testid="collect-copy-link">
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </div>

      {/* live status */}
      <div style={{ marginTop: 20 }}>
        {status === null ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            <Spinner size={14} /> Loading signing status…
          </div>
        ) : knownSigners ? (
          <>
            <Progress
              value={collected}
              max={signerCount}
              tone="accent"
              label="Signatures collected"
              valueLabel={`${collected} of ${signerCount}`}
              data-testid="collect-progress"
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}
              data-testid="collect-signers"
            >
              {status.signers.map((key) => {
                const signed = signedSet.has(key);
                const isYou = connectedKey !== null && key === connectedKey;
                return (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 13px",
                      borderRadius: 11,
                      border: signed
                        ? "1px solid color-mix(in srgb, var(--success) 30%, transparent)"
                        : "1px solid var(--border)",
                      background: "var(--surface-2)",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        background: "var(--surface)",
                        border: signed ? "1px solid var(--success)" : "1px solid var(--border-2)",
                        display: "grid",
                        placeItems: "center",
                        font: "600 11px/1 'Geist Mono', monospace",
                        color: signed ? "var(--success)" : "var(--fg-2)",
                        flexShrink: 0,
                      }}
                    >
                      {signed ? "✓" : key.slice(0, 2)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <CopyableAddress
                        value={key}
                        label="Signer"
                        head={8}
                        tail={6}
                        size={12}
                        href={explorerAccountUrl(network, key)}
                      />
                    </span>
                    {isYou ? <Badge tone="neutral">You</Badge> : null}
                    {signed ? (
                      <Badge tone="success">Signed</Badge>
                    ) : (
                      <Badge tone="warning">Pending</Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <Notice tone="neutral" role="status">
            Refractor is still working out which signers this account requires. This page keeps
            checking, or open the full plan below.
          </Notice>
        )}
      </div>

      {/* refresh controls + standalone link */}
      <div
        style={{
          marginTop: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--fg-3)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: refreshing ? "var(--accent)" : "var(--success)",
            }}
          />
          {refreshing ? "Checking…" : "Auto-refreshing every few seconds"}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <a
            href={planUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              font: "600 12px/1 Geist, sans-serif",
              color: "var(--fg-3)",
              textDecoration: "none",
            }}
          >
            Open the full plan page ↗
          </a>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void poll()}
            loading={refreshing}
            disabled={refreshing}
            data-testid="collect-refresh"
          >
            Refresh
          </Button>
        </div>
      </div>
    </Card>
  );
}
