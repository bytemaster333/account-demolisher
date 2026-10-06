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

import type { ClaimableSplit, LeftBehindClaim, UnlockTime } from "../_lib/claimables";
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

// why a balance stays behind, in the planner's terms where it has one
function leftBehindText(c: LeftBehindClaim, baseReserveStroops: number | null): string {
  switch (c.reason) {
    case "not_claimable_yet":
      return unlockText(c.unlock);
    case "no_trustline":
      return "the account has no trustline for it, and the close can't open one because the issuer requires authorization or couldn't be found";
    case "not_authorized":
      return "the issuer hasn't authorized this account's trustline, so the claim would be refused";
    case "line_full":
      return "the trustline has no room left for it";
    case "reserve":
      return `opening its trustline needs a ${
        baseReserveStroops === null ? "base" : `${stroopsToXlm(baseReserveStroops)} XLM`
      } reserve the account can't spare`;
    case "not_selected":
    case null:
      return unlockText(c.unlock);
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
  claimChoices,
  planNotes = [],
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
  // set when the close moves a large value: the XLM it can price, and how many
  // holdings it moves whose value it can't estimate
  readonly highValue: { readonly estimatedXlm: string; readonly unpricedHoldings: number } | null;
  // the claimable balances the user may tick in or out of the close; a change
  // reaches the plan only through a rebuild
  readonly claimChoices?: ClaimChoices;
  // facts about the built plan the user should know before the review
  readonly planNotes?: readonly string[];
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
  const added = claimables.trustlineChanges.filter((t) => t.change === "add");
  if (added.length > 0) {
    const each =
      baseReserveStroops === null ? "a base" : `a ${stroopsToXlm(baseReserveStroops)} XLM`;
    autoParts.push(
      `Opens ${added.length === 1 ? "a trustline" : `${added.length} trustlines`} (${added
        .map((t) => t.asset.code)
        .join(
          ", ",
        )}) so those payments can be collected. Each holds ${each} reserve, which comes back when the close removes the trustline.`,
    );
  }
  const hasPlanNotes = planNotes.length > 0;

  const requiredAckKeys = [
    ...requiredAcknowledgements({
      hasScam,
      hasDiscovery,
      hasAutoHandled,
      hasHighValue,
    }),
    ...(hasLeftBehind ? ["lockedClaimables"] : []),
    ...(hasPlanNotes ? ["planNotes"] : []),
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
          Please read each one so nothing surprises you, then confirm you understand. Anything that
          keeps the close from running is shown in the step before this one, not here.
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
          This close moves about {highValue.estimatedXlm} XLM
          {highValue.unpricedHoldings > 0
            ? ` plus ${highValue.unpricedHoldings} holding${
                highValue.unpricedHoldings === 1 ? "" : "s"
              } whose value couldn't be estimated`
            : ""}
          . Over {HIGH_VALUE_THRESHOLD_XLM} XLM, or any value that can&apos;t be priced, counts as
          large. Closing moves it to your destination and permanently deletes this account.
          Double-check the destination before you continue. This can&apos;t be undone.
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
                {c.amount} {assetLabel(c.asset)}, {leftBehindText(c, baseReserveStroops)}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {claimChoices !== undefined && claimChoices.balances.length > 0 ? (
        <ClaimChoicesCard choices={claimChoices} />
      ) : null}

      {hasPlanNotes ? (
        <Notice
          tone="neutral"
          role="status"
          title="About this plan"
          data-testid="plan-notes"
          footer={
            <AckRow
              checked={acks.planNotes === true}
              onChange={(v) => setAck("planNotes", v)}
              testId="ack-plan-notes"
            />
          }
        >
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {planNotes.map((n) => (
              <li key={n} style={{ lineHeight: 1.5 }}>
                {n}
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

export interface ClaimChoices {
  // balances claimable now, with the asset each pays
  readonly balances: readonly {
    readonly id: string;
    readonly asset: AssetIdentifier;
    readonly amount: string;
    // a balance this account sponsors is always collected: leaving it would
    // keep the account a sponsor, which blocks the merge
    readonly locked: boolean;
  }[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (id: string, checked: boolean) => void;
}

// which pending payments the close collects. Unticking one leaves it on the
// ledger, where the deleted account can never claim it.
function ClaimChoicesCard({ choices }: { readonly choices: ClaimChoices }): React.JSX.Element {
  return (
    <Notice tone="neutral" title="Pending payments this close collects" data-testid="claim-choices">
      Each ticked payment is collected into your balance before the account closes. Untick one to
      leave it behind; once the account is deleted it can&apos;t be collected, and the sender may
      take it back. A change applies when you rebuild the plan.
      <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
        {choices.balances.map((b) => (
          <li key={b.id} style={{ padding: "6px 0", borderTop: "1px solid var(--border)" }}>
            {b.locked ? (
              <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 13 }}>
                {b.amount} {assetLabel(b.asset)}, sponsored by this account, so always collected
              </span>
            ) : (
              <Checkbox
                checked={choices.selected.has(b.id)}
                onChange={(v) => choices.onToggle(b.id, v)}
                data-testid={`cb-checkbox-${b.id}`}
                label={
                  <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 13 }}>
                    {b.amount} {assetLabel(b.asset)}
                  </span>
                }
              />
            )}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
