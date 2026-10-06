"use client";

import { Badge, Button } from "@/components/ui";
import { ResidueConsent, type ResidueConsentCredit } from "@/components/warnings/ResidueConsent";
import type { NetworkConfig } from "@/lib/config/networks";

// The Resolve step, ACTIONS only. Blockers (balances with no XLM path) each
// need to be gone before the close-out: either return it to its issuer here, or
// dispose of it yourself elsewhere. "Rebuild plan" re-scans with whatever choices
// you've made, including none, for the dispose-it-yourself path (after which a
// fresh scan simply finds no blocker).
export function ResolvePanel({
  credits,
  network,
  returnToIssuer,
  sendToDestination,
  onSetDisposal,
  onRebuild,
  onBack,
}: {
  readonly credits: readonly ResidueConsentCredit[];
  readonly network: NetworkConfig;
  readonly returnToIssuer: readonly string[];
  readonly sendToDestination: readonly string[];
  readonly onSetDisposal: (key: string, mode: "none" | "issuer" | "destination") => void;
  readonly onRebuild: () => void;
  readonly onBack: () => void;
}): React.JSX.Element {
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
          A few things on this account have to be cleared before it can close. Handle each one
          below, then re-check.
        </p>
      </div>

      <ResidueConsent
        credits={credits}
        network={network}
        returnToIssuer={returnToIssuer}
        sendToDestination={sendToDestination}
        onSetDisposal={onSetDisposal}
        onRebuild={onRebuild}
        hideRebuild
      />

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
