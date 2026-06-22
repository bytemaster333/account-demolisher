"use client";

// surfaced when a best-effort discovery step (allowance scan / DeFi position
// probe) failed. The plan can still run, but it may be incomplete — so we say
// so plainly instead of hiding the failure in the console.

import type { ReactNode } from "react";

import { Notice } from "@/components/ui";

export interface DiscoveryWarningsProps {
  readonly warnings: readonly string[];
  // optional acknowledgment region rendered inside the notice (Resolve step)
  readonly footer?: ReactNode;
}

export function DiscoveryWarnings({
  warnings,
  footer,
}: DiscoveryWarningsProps): React.JSX.Element | null {
  if (warnings.length === 0) return null;

  return (
    <Notice
      tone="warning"
      role="alert"
      data-testid="discovery-warnings"
      {...(footer !== undefined ? { footer } : {})}
      title="Discovery was incomplete — this plan may be missing some entries"
    >
      <ul
        style={{
          listStyle: "disc",
          margin: "4px 0 0",
          paddingLeft: 18,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        {warnings.map((w) => (
          <li key={w} style={{ lineHeight: 1.5 }}>
            {w}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
