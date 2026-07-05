"use client";

// shown when the account holds credit balances with no XLM conversion path.
// Such balances block the merge (their trustlines can't be removed with a live
// balance). For each one the user picks a disposal: send it to the merge
// destination (only offered when the destination already trusts the asset, so
// the payment can't fail), or return it to its issuer (permanent, keeps
// nothing). Doing nothing leaves it in place and keeps blocking the close.

import { Button, CopyableAddress, Notice } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl } from "@/lib/explorer";

export type ResidueDisposal = "none" | "issuer" | "destination";

export interface ResidueConsentCredit {
  readonly key: string;
  readonly code: string;
  readonly issuer: string;
  readonly amount: string;
  // true when the merge destination already holds a trustline for this asset, so
  // "send to destination" is a safe option (no op_no_trust).
  readonly destinationTrusts?: boolean;
}

export interface ResidueConsentProps {
  readonly credits: readonly ResidueConsentCredit[];
  readonly network: NetworkConfig;
  // pathKey()s currently chosen for each disposal
  readonly returnToIssuer: readonly string[];
  readonly sendToDestination: readonly string[];
  readonly onSetDisposal: (key: string, mode: ResidueDisposal) => void;
  readonly onRebuild: () => void;
  // when the surrounding step owns the rebuild action (the Resolve step's single
  // bottom button), hide this notice's own inline "Rebuild plan" button
  readonly hideRebuild?: boolean;
}

export function ResidueConsent({
  credits,
  network,
  returnToIssuer,
  sendToDestination,
  onSetDisposal,
  onRebuild,
  hideRebuild = false,
}: ResidueConsentProps): React.JSX.Element | null {
  if (credits.length === 0) return null;
  const issuerSet = new Set(returnToIssuer);
  const destSet = new Set(sendToDestination);

  return (
    <Notice
      tone="warning"
      role="note"
      data-testid="residue-consent"
      title={
        credits.length === 1
          ? "1 balance can't be converted to XLM"
          : `${credits.length} balances can't be converted to XLM`
      }
    >
      We couldn&apos;t find a way to turn these tokens into XLM, so the account can&apos;t close
      while it still holds them. Sell or move them from another app first, then re-check, or choose
      what to do with each one below.
      <ul
        style={{
          listStyle: "none",
          margin: "12px 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {credits.map((c) => {
          const mode: ResidueDisposal = destSet.has(c.key)
            ? "destination"
            : issuerSet.has(c.key)
              ? "issuer"
              : "none";
          return (
            <li
              key={c.key}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: "11px 12px",
                borderRadius: 9,
                background: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span
                  style={{
                    font: "600 12.5px/1 'Geist Mono', monospace",
                    color: "var(--fg)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.amount} {c.code}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <CopyableAddress
                    value={c.issuer}
                    label="Created by"
                    full
                    size={11.5}
                    href={explorerAccountUrl(network, c.issuer)}
                  />
                </span>
              </div>
              <div
                role="radiogroup"
                aria-label={`What to do with ${c.amount} ${c.code}`}
                style={{ display: "flex", gap: 7, flexWrap: "wrap" }}
              >
                {c.destinationTrusts ? (
                  <DisposalOption
                    selected={mode === "destination"}
                    tone="accent"
                    testId={`residue-send-dest-${c.key}`}
                    onClick={() =>
                      onSetDisposal(c.key, mode === "destination" ? "none" : "destination")
                    }
                    label="Send to your destination"
                    srDetail={`: send ${c.amount} ${c.code} to your destination address, which already accepts this token. You keep it.`}
                  />
                ) : null}
                <DisposalOption
                  selected={mode === "issuer"}
                  tone="warning"
                  testId={`residue-issuer-${c.key}`}
                  onClick={() => onSetDisposal(c.key, mode === "issuer" ? "none" : "issuer")}
                  label="Return to issuer (keep nothing)"
                  srDetail={`: send ${c.amount} ${c.code} back to the address that created it. This is permanent, you'll almost certainly get nothing back, and it can't be undone.`}
                />
              </div>
              {mode === "none" ? (
                <span style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.4 }}>
                  Nothing chosen yet, so this balance still blocks the close.
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hideRebuild ? null : (
        <div style={{ marginTop: 12 }}>
          <Button variant="secondary" size="sm" onClick={onRebuild} data-testid="residue-rebuild">
            Rebuild plan with these choices
          </Button>
        </div>
      )}
    </Notice>
  );
}

function DisposalOption({
  selected,
  tone,
  label,
  srDetail,
  onClick,
  testId,
}: {
  readonly selected: boolean;
  readonly tone: "accent" | "warning";
  readonly label: string;
  readonly srDetail: string;
  readonly onClick: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const color = tone === "accent" ? "var(--accent)" : "var(--warning)";
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "6px 11px",
        borderRadius: 8,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
        color: selected ? color : "var(--fg-2)",
        background: selected ? `color-mix(in srgb, ${color} 12%, transparent)` : "var(--surface-2)",
        border: `1px solid ${selected ? color : "var(--border)"}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 13,
          height: 13,
          borderRadius: "50%",
          border: `2px solid ${selected ? color : "var(--border-2)"}`,
          display: "grid",
          placeItems: "center",
        }}
      >
        {selected ? (
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
        ) : null}
      </span>
      {label}
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {srDetail}
      </span>
    </button>
  );
}
