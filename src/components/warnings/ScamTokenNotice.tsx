"use client";

// informational notice for tokens the account holds that trip the scam
// heuristics (look-alike symbols, homoglyphs, off-allowlist contracts). The
// demolition removes these anyway; this just makes sure the user recognizes
// what they held. Not a blocker — the typed confirmation is the safety net.

import type { ScamFinding } from "@/lib/safety/scam-heuristics";
import type { AssetIdentifier } from "@/lib/types/account";

export interface ScamTokenNoticeProps {
  readonly findings: readonly ScamFinding[];
}

function assetLabel(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "XLM";
    case "credit":
      return `${asset.code}:${asset.issuer.slice(0, 6)}…`;
    case "liquidity_pool_shares":
      return `pool ${asset.poolId.slice(0, 8)}…`;
  }
}

function assetKey(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "native";
    case "credit":
      return `${asset.code}:${asset.issuer}`;
    case "liquidity_pool_shares":
      return `pool:${asset.poolId}`;
  }
}

export function ScamTokenNotice({ findings }: ScamTokenNoticeProps): React.JSX.Element | null {
  if (findings.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="scam-token-notice"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderRadius: 11,
        background: "color-mix(in srgb, var(--danger-soft) 70%, transparent)",
        border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
        color: "var(--fg)",
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>
        {findings.length === 1
          ? "1 token looks suspicious"
          : `${findings.length} tokens look suspicious`}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        {findings.map((f) => (
          <li
            key={`${assetKey(f.asset)}-${f.flag.id}`}
            style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--fg-2)" }}
          >
            <span style={{ font: "600 12px/1 'Geist Mono', monospace", color: "var(--fg)" }}>
              {assetLabel(f.asset)}
            </span>{" "}
            — {f.flag.message}
          </li>
        ))}
      </ul>
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>
        These are removed as part of the close-out. Make sure you recognize them before proceeding.
      </div>
    </div>
  );
}
