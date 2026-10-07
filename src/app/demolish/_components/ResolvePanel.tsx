"use client";

import { Badge, Button, Checkbox, Notice } from "@/components/ui";
import { ResidueConsent } from "@/components/warnings/ResidueConsent";
import type { NetworkConfig } from "@/lib/config/networks";
import type { UnroutableCredit } from "@/lib/plan/classic-batcher";
import type { EmissionForfeit, RefusedConversion } from "@/lib/orchestrator/page-flow-machine";

import { stroopsToXlm } from "../_lib/fees";

export type CreditChoice = "none" | "issuer" | "destination" | "accept";
export type HeldTokenChoice = "none" | "accept" | "leave";

// the Resolve step: everything that keeps the close from starting. Balances
// with no market, conversions refused for their price and backstop emissions
// that can't be claimed each need a choice from the user; anything else is
// listed with its reason. "Re-check and continue" rebuilds the plan with the
// choices made here.
export function ResolvePanel({
  credits,
  network,
  returnToIssuer,
  sendToDestination,
  acceptedPriceKeys,
  onSetDisposal,
  refused,
  heldChoices,
  onHeldChoice,
  forfeits,
  forfeitPools,
  onForfeit,
  otherBlockers,
  onRebuild,
  onBack,
}: {
  readonly credits: readonly UnroutableCredit[];
  readonly network: NetworkConfig;
  readonly returnToIssuer: readonly string[];
  readonly sendToDestination: readonly string[];
  // pathKey()s the user agreed to sell over the price-impact cap or unpriced
  readonly acceptedPriceKeys: readonly string[];
  readonly onSetDisposal: (key: string, choice: CreditChoice) => void;
  readonly refused: readonly RefusedConversion[];
  readonly heldChoices: ReadonlyMap<string, HeldTokenChoice>;
  readonly onHeldChoice: (r: RefusedConversion, choice: HeldTokenChoice) => void;
  readonly forfeits: readonly EmissionForfeit[];
  readonly forfeitPools: ReadonlySet<string>;
  readonly onForfeit: (poolId: string, agreed: boolean) => void;
  // blockers with nothing to choose here, in words
  readonly otherBlockers: readonly string[];
  readonly onRebuild: () => void;
  readonly onBack: () => void;
}): React.JSX.Element {
  const noPath = credits.filter((c) => c.reason === "no_path");
  const priced = credits.filter((c) => c.reason !== "no_path");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="warning" dot>
            You need to do something here
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Fix these before continuing
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          The close can&apos;t start while any of these is open. Handle each one below, then
          re-check.
        </p>
      </div>

      {otherBlockers.length > 0 ? (
        <Notice
          tone="danger"
          role="alert"
          title="This close can't start yet"
          data-testid="blockers"
        >
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {otherBlockers.map((b) => (
              <li key={b} style={{ lineHeight: 1.5 }}>
                {b}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <ResidueConsent
        credits={noPath}
        network={network}
        returnToIssuer={returnToIssuer}
        sendToDestination={sendToDestination}
        onSetDisposal={onSetDisposal}
        onRebuild={onRebuild}
        hideRebuild
      />

      {priced.length > 0 ? (
        <Notice
          tone="warning"
          role="note"
          title="Some conversions need your decision"
          data-testid="price-choices"
        >
          Selling these at today&apos;s market price would cost more than the 2% the close allows,
          or the price can&apos;t be checked. Nothing is sold unless you agree, per asset.
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
            {priced.map((c) => {
              const choice: CreditChoice = sendToDestination.includes(c.key)
                ? "destination"
                : returnToIssuer.includes(c.key)
                  ? "issuer"
                  : acceptedPriceKeys.includes(c.key)
                    ? "accept"
                    : "none";
              const pick = (next: CreditChoice) =>
                onSetDisposal(c.key, choice === next ? "none" : next);
              return (
                <li key={c.key} style={rowStyle} data-testid={`price-choice-${c.key}`}>
                  <span style={{ font: "600 12.5px/1.4 'Geist Mono', monospace" }}>
                    {c.amount} {c.code}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--fg-2)" }}>{creditWhy(c)}</span>
                  <div
                    role="group"
                    aria-label={`What to do with ${c.amount} ${c.code}`}
                    style={groupStyle}
                  >
                    <ChoiceButton
                      selected={choice === "accept"}
                      onClick={() => pick("accept")}
                      testId={`price-accept-${c.key}`}
                      label="Sell anyway at this price"
                    />
                    {c.destinationTrusts ? (
                      <ChoiceButton
                        selected={choice === "destination"}
                        onClick={() => pick("destination")}
                        testId={`price-send-${c.key}`}
                        label="Send it as-is to your destination"
                      />
                    ) : null}
                    <ChoiceButton
                      selected={choice === "issuer"}
                      onClick={() => pick("issuer")}
                      testId={`price-issuer-${c.key}`}
                      label="Return to issuer (keep nothing)"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </Notice>
      ) : null}

      {refused.length > 0 ? (
        <Notice
          tone="warning"
          role="note"
          title="Some token swaps were refused for their price"
          data-testid="refused-conversions"
        >
          Converting these tokens to XLM would sell below the reviewed price or past the 2% cap.
          Pick what happens to each one.
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
            {refused.map((r) => {
              const choice = heldChoices.get(r.contractId) ?? "none";
              const pick = (next: HeldTokenChoice) =>
                onHeldChoice(r, choice === next ? "none" : next);
              return (
                <li key={r.key} style={rowStyle} data-testid={`refused-${r.contractId}`}>
                  <span
                    style={{ font: "600 12px/1.4 'Geist Mono', monospace", wordBreak: "break-all" }}
                  >
                    {r.contractId}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--fg-2)" }}>
                    {shortReason(r.reason)}
                  </span>
                  <div
                    role="group"
                    aria-label={`What to do with token ${r.contractId}`}
                    style={groupStyle}
                  >
                    <ChoiceButton
                      selected={choice === "accept"}
                      onClick={() => pick("accept")}
                      testId={`refused-accept-${r.contractId}`}
                      label="Swap anyway at this price"
                    />
                    <ChoiceButton
                      selected={choice === "leave"}
                      onClick={() => pick("leave")}
                      testId={`refused-leave-${r.contractId}`}
                      label="Leave it on the account"
                    />
                  </div>
                  {choice === "leave" ? (
                    <span style={{ fontSize: 11.5, color: "var(--warning)" }}>
                      A token left out stays with the deleted account and can&apos;t be recovered.
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Notice>
      ) : null}

      {forfeits.length > 0 ? (
        <Notice
          tone="warning"
          role="note"
          title="Blend backstop rewards can't be claimed"
          data-testid="emission-forfeits"
        >
          The claim for these backstop rewards fails on the network today, so it can&apos;t run
          before the withdrawal is queued. You can leave them unclaimed and queue the withdrawal
          anyway; they never block the close.
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
            {forfeits.map((f) => (
              <li key={f.poolId} style={rowStyle}>
                <span style={{ fontSize: 12.5 }}>
                  {f.accruedEmissions === null
                    ? "The accrued BLND"
                    : `${stroopsToXlm(f.accruedEmissions)} BLND`}{" "}
                  for pool <code style={{ wordBreak: "break-all" }}>{f.poolId}</code>
                </span>
                <details style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
                  <summary style={{ cursor: "pointer" }}>Why the claim fails</summary>
                  <pre
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "6px 0 0" }}
                  >
                    {f.reason}
                  </pre>
                </details>
                <Checkbox
                  checked={forfeitPools.has(f.poolId)}
                  onChange={(v) => onForfeit(f.poolId, v)}
                  data-testid={`forfeit-${f.poolId}`}
                  label={`Leave ${
                    f.accruedEmissions === null ? "these" : stroopsToXlm(f.accruedEmissions)
                  } BLND unclaimed and continue`}
                />
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div style={{ display: "flex", gap: 11, marginTop: 4 }}>
        <Button variant="secondary" onClick={onBack} data-testid="resolve-back">
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onRebuild}
          data-testid="resolve-rebuild"
          style={{ flex: 1 }}
          iconLeft={
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
              <path d="M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
            </svg>
          }
        >
          Re-check and continue
        </Button>
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "11px 12px",
  marginTop: 8,
  borderRadius: 9,
  background: "var(--surface)",
  border: "1px solid var(--border)",
};

const groupStyle: React.CSSProperties = { display: "flex", gap: 7, flexWrap: "wrap" };

function creditWhy(c: UnroutableCredit): string {
  switch (c.reason) {
    case "price_impact":
      return `Selling all of it would move the price by about ${((c.priceImpactBps ?? 0) / 100).toFixed(2)}% against a small reference trade.`;
    case "unpriced":
      return "There is no reference price to check the sale against.";
    case "requote_worse":
      return "The market now pays less than the price you reviewed.";
    case "no_path":
      return "There is no market path to XLM.";
  }
}

// a refusal can carry a long simulation log; the first line says why
function shortReason(reason: string): string {
  const first = reason.split("\n")[0] ?? reason;
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

function ChoiceButton({
  selected,
  onClick,
  label,
  testId,
}: {
  readonly selected: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      data-testid={testId}
      style={{
        padding: "6px 11px",
        borderRadius: 8,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        color: selected ? "var(--accent)" : "var(--fg-2)",
        background: selected
          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
          : "var(--surface-2)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
      }}
    >
      {label}
    </button>
  );
}
