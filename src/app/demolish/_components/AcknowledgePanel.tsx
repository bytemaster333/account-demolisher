"use client";

import { useState } from "react";

import { Badge, Button, Checkbox, Notice } from "@/components/ui";
import { DiscoveryWarnings } from "@/components/warnings/DiscoveryWarnings";
import { ScamTokenNotice } from "@/components/warnings/ScamTokenNotice";
import type { NetworkConfig } from "@/lib/config/networks";
import {
  HIGH_VALUE_THRESHOLD_XLM,
  allAcknowledged,
  requiredAcknowledgements,
} from "@/lib/safety/high-value";
import type { ScamFinding } from "@/lib/safety/scam-heuristics";
import type { AssetIdentifier } from "@/lib/types/account";

import type { ClaimableSplit, UnlockTime } from "../_lib/claimables";
import { stroopsToXlm } from "../_lib/fees";

// small acknowledgment control rendered in each resolution card's footer
function AckRow({
  checked,
  onChange,
  testId,
  label = "I've read and understand this",
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly testId: string;
  readonly label?: string;
}): React.JSX.Element {
  return <Checkbox checked={checked} onChange={onChange} data-testid={testId} label={label} />;
}

const ARROW_RIGHT = (
  <svg
    width="15"
    height="15"
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
);

// The Acknowledge step, INFORMATION only. Warnings and info that don't block
// the close-out but must be read and understood. "Continue to review" is gated
// until every card is acknowledged.
function assetLabel(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "XLM";
    case "credit":
      return asset.code;
    case "contract":
      return asset.symbol ?? "token";
    case "liquidity_pool_shares":
      return "pool shares";
  }
}

function unlockText(unlock: UnlockTime): string {
  switch (unlock.kind) {
    case "now":
      return "could be collected now, but isn't part of this close";
    case "at":
      return `can be collected from ${unlock.at.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}`;
    case "never":
      return "can no longer be collected by this account";
    case "unknown":
      return "unlock time can't be worked out here";
  }
}

export function AcknowledgePanel({
  network,
  scamFindings,
  discoveryWarnings,
  claimables,
  sponsorshipCount,
  baseReserveStroops,
  highValue,
  tokensSlot,
  rebuildRequired,
  onRebuild,
  onBack,
  onContinue,
}: {
  readonly network: NetworkConfig;
  readonly scamFindings: readonly ScamFinding[];
  readonly discoveryWarnings: readonly string[];
  // what the reviewed close collects, and the balances it leaves behind
  readonly claimables: ClaimableSplit;
  readonly sponsorshipCount: number;
  // the network's base reserve; null when it couldn't be read
  readonly baseReserveStroops: number | null;
  readonly highValue: { readonly totalXlm: string } | null;
  // optional standalone-token section (opt-in sweep + manual-add); not gated by an
  // ack checkbox, it's an action rather than a read
  readonly tokensSlot?: React.ReactNode;
  // set when choices made on this step (token sweep, convert) aren't in the built
  // plan yet: Continue stays off until the plan is rebuilt with them
  readonly rebuildRequired: string | null;
  readonly onRebuild: () => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const setAck = (key: string, v: boolean) => setAcks((a) => ({ ...a, [key]: v }));

  const hasScam = scamFindings.length > 0;
  const hasDiscovery = discoveryWarnings.length > 0;
  const autoParts: string[] = [];
  if (claimables.collectCount > 0) {
    const n = claimables.collectCount;
    autoParts.push(
      `Collects ${n} pending payment${n === 1 ? "" : "s"} waiting for this account (a “claimable balance”) into your balance before closing.`,
    );
  }
  if (sponsorshipCount > 0) {
    const n = sponsorshipCount;
    const each =
      baseReserveStroops === null ? "" : ` (${stroopsToXlm(baseReserveStroops)} XLM each)`;
    autoParts.push(
      `Frees ${n} sponsored reserve${n === 1 ? "" : "s"}${each} this account had locked up for entries it sponsors, back into your balance.`,
    );
  }
  const hasAutoHandled = autoParts.length > 0;
  const hasHighValue = highValue !== null;
  const hasLeftBehind = claimables.leftBehind.length > 0;

  const requiredAckKeys = [
    ...requiredAcknowledgements({
      hasScam,
      hasDiscovery,
      hasAutoHandled,
      hasHighValue,
    }),
    ...(hasLeftBehind ? ["lockedClaimables"] : []),
  ];
  const allAcked = allAcknowledged(requiredAckKeys, acks);
  const canContinue = allAcked && rebuildRequired === null;
  const blockedReason =
    rebuildRequired ?? (allAcked ? undefined : "Tick every box above to continue");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warning" dot>
            Just read, nothing to fix
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          A few things to know
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          None of these stop you from closing the account. Please read each one so nothing surprises
          you, then confirm you understand.
        </p>
      </div>

      {hasScam ? (
        <ScamTokenNotice
          findings={scamFindings}
          network={network}
          footer={
            <AckRow
              checked={acks.scam === true}
              onChange={(v) => setAck("scam", v)}
              testId="ack-scam"
            />
          }
        />
      ) : null}

      {hasDiscovery ? (
        <DiscoveryWarnings
          warnings={discoveryWarnings}
          footer={
            <AckRow
              checked={acks.discovery === true}
              onChange={(v) => setAck("discovery", v)}
              testId="ack-discovery"
            />
          }
        />
      ) : null}

      {hasAutoHandled ? (
        <Notice
          tone="neutral"
          role="status"
          data-testid="auto-handled-notice"
          title="Handled for you, nothing to do"
          footer={
            <AckRow
              checked={acks.autoHandled === true}
              onChange={(v) => setAck("autoHandled", v)}
              testId="ack-autohandled"
              label="Got it"
            />
          }
        >
          Closing the account takes care of these automatically. You keep the value, and there is
          nothing for you to do:
          <ul
            style={{
              listStyle: "disc",
              margin: "7px 0 0",
              paddingLeft: 18,
              display: "flex",
              flexDirection: "column",
              gap: 5,
            }}
          >
            {autoParts.map((p) => (
              <li key={p} style={{ lineHeight: 1.5 }}>
                {p}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {highValue ? (
        <Notice
          tone="warning"
          title="Large balance, double-check before closing"
          data-testid="high-value-notice"
          footer={
            <AckRow
              checked={acks.highValue === true}
              onChange={(v) => setAck("highValue", v)}
              testId="ack-highvalue"
            />
          }
        >
          This account holds {highValue.totalXlm} XLM, a large balance (over{" "}
          {HIGH_VALUE_THRESHOLD_XLM} XLM). Closing it moves this XLM to your destination and
          permanently deletes this account. Double-check the amount and the destination before you
          continue. This can&apos;t be undone.
        </Notice>
      ) : null}

      {hasLeftBehind ? (
        <Notice
          tone="warning"
          title="Some pending payments will be left behind"
          data-testid="locked-claimables-notice"
          footer={
            <AckRow
              checked={acks.lockedClaimables === true}
              onChange={(v) => setAck("lockedClaimables", v)}
              testId="ack-locked-claimables"
            />
          }
        >
          This close doesn&apos;t collect these payments set aside for this account. Once the
          account is deleted it can&apos;t collect them, and the sender may take them back. If you
          want them, collect them first (a locked one only once it unlocks), then close.
          <ul style={{ margin: "7px 0 0", paddingLeft: 18 }}>
            {claimables.leftBehind.map((c) => (
              <li key={c.id} style={{ lineHeight: 1.5 }}>
                {c.amount} {assetLabel(c.asset)}, {unlockText(c.unlock)}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {tokensSlot}

      {rebuildRequired !== null ? (
        <div
          role="status"
          data-testid="acknowledge-rebuild-needed"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
            padding: "11px 13px",
            borderRadius: 11,
            border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)",
            fontSize: 12.5,
            color: "var(--fg-2)",
          }}
        >
          <span>{rebuildRequired}</span>
          <Button variant="secondary" onClick={onRebuild} data-testid="acknowledge-rebuild">
            Rebuild plan
          </Button>
        </div>
      ) : null}

      {!allAcked ? (
        <p
          role="status"
          data-testid="acknowledge-hint"
          style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--warning)", lineHeight: 1.5 }}
        >
          Tick every box above to continue.
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 11, marginTop: 4 }}>
        <Button variant="secondary" onClick={onBack} data-testid="acknowledge-back">
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={!canContinue}
          disabledReason={blockedReason}
          data-testid="acknowledge-continue"
          style={{ flex: 1 }}
          iconRight={ARROW_RIGHT}
        >
          Continue to review
        </Button>
      </div>
    </div>
  );
}
