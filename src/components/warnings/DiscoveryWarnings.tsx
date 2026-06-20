"use client";

// surfaced when a best-effort discovery step (allowance scan / DeFi position
// probe) failed. The plan can still run, but it may be incomplete — so we say
// so plainly instead of hiding the failure in the console.

import { Notice } from "@/components/ui";

export interface DiscoveryWarningsProps {
  readonly warnings: readonly string[];
}

export function DiscoveryWarnings({ warnings }: DiscoveryWarningsProps): React.JSX.Element | null {
  if (warnings.length === 0) return null;

  return (
    <Notice
      tone="warning"
      role="alert"
      data-testid="discovery-warnings"
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
