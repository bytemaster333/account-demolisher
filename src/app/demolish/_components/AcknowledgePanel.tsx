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
export function AcknowledgePanel({
  network,
  scamFindings,
  discoveryWarnings,
  autoHandled,
  highValue,
  tokensSlot,
  onBack,
  onContinue,
}: {
  readonly network: NetworkConfig;
  readonly scamFindings: readonly ScamFinding[];
  readonly discoveryWarnings: readonly string[];
  readonly autoHandled: { readonly claimableCount: number; readonly sponsorshipCount: number };
  readonly highValue: { readonly totalXlm: string } | null;
  // optional standalone-token section (opt-in sweep + manual-add); not gated by an
  // ack checkbox — it's an action, not just a read — so it never blocks Continue.
  readonly tokensSlot?: React.ReactNode;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const setAck = (key: string, v: boolean) => setAcks((a) => ({ ...a, [key]: v }));

  const hasScam = scamFindings.length > 0;
  const hasDiscovery = discoveryWarnings.length > 0;
  const autoParts: string[] = [];
  if (autoHandled.claimableCount > 0) {
    const n = autoHandled.claimableCount;
    autoParts.push(
      `Collects ${n} pending payment${n === 1 ? "" : "s"} waiting for this account (a “claimable balance”) into your XLM before closing.`,
    );
  }
  if (autoHandled.sponsorshipCount > 0) {
    const n = autoHandled.sponsorshipCount;
    autoParts.push(
      `Frees ${n} XLM deposit${n === 1 ? "" : "s"} this account had locked up as a reserve (a “sponsorship”) back into your balance.`,
    );
  }
  const hasAutoHandled = autoParts.length > 0;
  const hasHighValue = highValue !== null;

  const requiredAckKeys = requiredAcknowledgements({
    hasScam,
    hasDiscovery,
    hasAutoHandled,
    hasHighValue,
  });
  const allAcked = allAcknowledged(requiredAckKeys, acks);

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

      {tokensSlot}

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
          disabled={!allAcked}
          disabledReason={allAcked ? undefined : "Tick every box above to continue"}
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
