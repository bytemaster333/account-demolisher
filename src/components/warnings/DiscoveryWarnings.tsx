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
      role="note"
      data-testid="discovery-warnings"
      {...(footer !== undefined ? { footer } : {})}
      title="We couldn't finish scanning this account"
    >
      It&apos;s possible this account has some token permissions or DeFi positions we didn&apos;t
      find. If you&apos;ve used apps like Blend or Soroswap, check them before closing — leftover
      items could be left behind.
      <ul
        style={{
          listStyle: "disc",
          margin: "10px 0 0",
          paddingLeft: 18,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          fontSize: 12,
          color: "var(--fg-3)",
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
