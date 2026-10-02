"use client";

import {
  AddressActions,
  Badge,
  Button,
  Card,
  CopyableAddress,
  InfoTip,
  SectionLabel,
  StatGrid,
} from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl } from "@/lib/explorer";
import type { PlanNode } from "@/lib/plan/tree";

import { nodeFeeStroops, stroopsToXlm, xlmToStroops } from "../_lib/fees";
import { phasePlainLabel } from "../_lib/plan-copy";
import { PlanRow } from "./PlanRow";

// Human QA sign-off, the dedicated step before anything executes. Lists every
// operation to be run, requires an explicit acknowledgment and a typed
// last-4-char confirmation (with a short unlock delay), then triggers execution.
// This replaces the old stacked high-value + typed-confirmation modals.
// The combined Review step, the clean "here is what will happen". Plan
// overview, every operation grouped, destination + account snapshot. No
// cautions or warnings (those are acknowledged in the Resolve step); the final
// gate is the typed-confirmation dialog opened by "Demolish account".
export function ReviewPanel({
  planGroups,
  totalXlm,
  activeCount,
  destination,
  network,
  snapshot,
  onBack,
  onDemolish,
  createRequest,
}: {
  readonly planGroups: ReadonlyArray<{ phase: string; nodes: readonly PlanNode[] }>;
  readonly totalXlm: string;
  readonly activeCount: number;
  readonly destination: string;
  readonly network: NetworkConfig;
  readonly snapshot: {
    readonly pk: string;
    readonly sub: number;
    readonly trustlines: number;
    readonly offers: number;
    readonly data: number;
    readonly claimable: number;
  } | null;
  readonly onBack: () => void;
  readonly onDemolish: () => void;
  // present for a shared account whose keys aren't all on this device: the
  // terminal packages this exact reviewed close as a signing request for the
  // other signers, instead of executing it immediately.
  readonly createRequest?: {
    readonly onCreate: () => void;
    readonly creating: boolean;
    readonly error: string | null;
  };
}): React.JSX.Element {
  const required = destination.length >= 4 ? destination.slice(-4) : destination;
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";

  // flatten for numbering + total network cost
  const allNodes = planGroups.flatMap((g) => g.nodes);
  const totalFeeStroops = allNodes.reduce((sum, n) => sum + nodeFeeStroops(n), 0);
  const indexOf = new Map(allNodes.map((n, i) => [n.id, i + 1]));

  // Money math the user can trust. `totalXlm` is the WHOLE native balance, the
  // locked reserve is already inside it, not on top. What the destination
  // actually receives is that balance minus network fees. The freed reserve is
  // shown only as context (part of the amount above), never as a bonus, and is
  // the real figure: Stellar locks 0.5 XLM for the account base (×2) plus 0.5
  // per subentry (trustline/offer/signer/data), all released on close.
  const reserveStroops = (2 + (snapshot?.sub ?? 0)) * 5_000_000;
  const netReceivedStroops = Math.max(0, xlmToStroops(totalXlm) - totalFeeStroops);

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="success" dot>
            PLAN READY
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Review before closing
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          {activeCount} {activeCount === 1 ? "step runs" : "steps run"} in order, here is exactly
          what will happen. Nothing happens until you confirm below.
        </p>
      </div>

      <StatGrid
        stats={[
          {
            label: "Destination receives",
            value: `≈ ${stroopsToXlm(netReceivedStroops)} XLM`,
            tone: "accent",
          },
          { label: "Network fees", value: `≈ ${stroopsToXlm(totalFeeStroops)} XLM` },
          { label: "Reserve released (included)", value: `≈ ${stroopsToXlm(reserveStroops)} XLM` },
        ]}
      />
      <p style={{ margin: "-6px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--fg-3)" }}>
        Your whole balance goes to the destination, minus a small{" "}
        <InfoTip tip="A small charge the Stellar network takes to process each step. It is not paid to us.">
          network fee
        </InfoTip>
        . The{" "}
        <InfoTip tip="XLM the network keeps locked in every account while it is open. It is released when the account closes, and is already included in the amount above, not extra.">
          reserve
        </InfoTip>{" "}
        is already part of that amount.
      </p>

      {/* every operation, grouped */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
        {planGroups.map((g, gi) => {
          const irreversible = g.phase === "Merge" || g.phase === "Mediator forward";
          return (
            <div
              key={g.phase}
              style={{ borderTop: gi > 0 ? "1px solid var(--border)" : undefined }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 14px 5px",
                }}
              >
                <SectionLabel>{phasePlainLabel(g.phase)}</SectionLabel>
                {irreversible ? <Badge tone="danger">Irreversible</Badge> : null}
              </div>
              <div style={{ padding: "0 6px 6px" }}>
                {g.nodes.map((n) => (
                  <PlanRow
                    key={n.id}
                    node={n}
                    network={network}
                    mode="plan"
                    index={indexOf.get(n.id) ?? 0}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* destination + amount + account snapshot */}
      <div
        style={{
          borderRadius: 12,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 6 }}>
            SENDING EVERYTHING TO
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={{ font: "600 13.5px/1.5 'Geist Mono', monospace", wordBreak: "break-all" }}>
              <span style={{ color: "var(--fg-2)" }}>{destHead}</span>
              <span
                style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "underline" }}
              >
                {required}
              </span>
            </div>
            <AddressActions
              value={destination}
              href={explorerAccountUrl(network, destination)}
              label="destination"
            />
          </div>
          <div style={{ marginTop: 9, fontSize: 13, color: "var(--fg-2)" }}>
            Your balance is sent to this address and the account is permanently closed. The
            destination receives{" "}
            <span style={{ font: "600 13px 'Geist Mono', monospace", color: "var(--fg)" }}>
              ≈ {stroopsToXlm(netReceivedStroops)} XLM
            </span>{" "}
            after network fees.
          </div>
        </div>
        {snapshot ? (
          <div
            style={{
              padding: "12px 16px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              gap: 22,
              flexWrap: "wrap",
              alignItems: "flex-start",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--fg-3)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                Account
              </span>
              <CopyableAddress
                value={snapshot.pk}
                label="account"
                size={13}
                href={explorerAccountUrl(network, snapshot.pk)}
              />
            </div>
            <SnapStat
              label="Subentries"
              value={snapshot.sub}
              tip="Extra things attached to the account (trustlines, offers, saved data, signers). Each one locks a little XLM as a reserve; all of it is freed when the account closes."
            />
            <SnapStat
              label="Trustlines"
              value={snapshot.trustlines}
              tip="Tokens the account is set up to hold, besides XLM. Each is emptied and removed as part of closing."
            />
            <SnapStat
              label="Offers"
              value={snapshot.offers}
              tip="Open buy/sell orders on Stellar's built-in exchange. They're cancelled before the account closes."
            />
            <SnapStat
              label="Data"
              value={snapshot.data}
              tip="Small key-value notes stored on the account. They're deleted as part of closing."
            />
            <SnapStat
              label="Claimable"
              value={snapshot.claimable}
              tip="Payments set aside for this account that haven't been collected yet. They're claimed into your balance before closing."
            />
          </div>
        ) : null}
      </div>

      {createRequest ? (
        <>
          <div
            role="note"
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--fg-3)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginTop: 1 }}
              aria-hidden
            >
              <path d="M12 16v-4M12 8h.01" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span>
              This packages the exact close above into one transaction and signs it with your key.
              Nothing is submitted yet, and{" "}
              <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
                the account stays open until enough signers sign.
              </strong>{" "}
              You&apos;ll get a link to share, and collect the rest here.
            </span>
          </div>

          {createRequest.error !== null ? (
            <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
              {createRequest.error}
            </p>
          ) : null}

          <div style={{ display: "flex", gap: 11 }}>
            <Button variant="secondary" onClick={onBack} data-testid="review-back">
              Back
            </Button>
            <Button
              onClick={createRequest.onCreate}
              loading={createRequest.creating}
              disabled={createRequest.creating}
              data-testid="review-create-request"
              style={{ flex: 1 }}
            >
              {createRequest.creating ? "Creating request…" : "Create signing request"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div
            role="note"
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--danger)"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginTop: 1 }}
              aria-hidden
            >
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
            <span>
              This permanently deletes your Stellar account and sends all its XLM to the address
              above.{" "}
              <strong style={{ color: "var(--fg)", fontWeight: 600 }}>It cannot be undone.</strong>{" "}
              Double-check the address before continuing.
            </span>
          </div>

          <div style={{ display: "flex", gap: 11 }}>
            <Button variant="secondary" onClick={onBack} data-testid="review-back">
              Back
            </Button>
            <Button
              variant="danger"
              onClick={onDemolish}
              data-testid="demolish-confirm"
              style={{ flex: 1 }}
              iconRight={
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              }
            >
              Continue to final confirmation
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// consolidated "handled automatically, no action needed" line, replaces the
// separate claimable + sponsorship notices that used to stack in Review.
function SnapStat({
  label,
  value,
  mono = false,
  tip,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly mono?: boolean;
  readonly tip?: string;
}): React.JSX.Element {
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: "var(--fg-3)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontWeight: 600,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {tip ? (
        <InfoTip tip={tip}>
          <span style={labelStyle}>{label}</span>
        </InfoTip>
      ) : (
        <span style={labelStyle}>{label}</span>
      )}
      <span
        style={{
          font: mono ? "500 12px/1 'Geist Mono', monospace" : "600 14px/1 'Geist Mono', monospace",
          color: "var(--fg)",
        }}
      >
        {value}
      </span>
    </div>
  );
}
