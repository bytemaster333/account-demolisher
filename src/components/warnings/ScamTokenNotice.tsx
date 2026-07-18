"use client";

// informational notice for tokens the account holds that trip the scam
// heuristics (look-alike symbols, homoglyphs, off-allowlist contracts). The
// demolition removes these anyway; this just makes sure the user recognizes
// what they held. Not a blocker; the typed confirmation is the safety net.

import type { ReactNode } from "react";

import { Badge, CopyableAddress, Notice } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerContractUrl } from "@/lib/explorer";
import type { ScamFinding, ScamFlag } from "@/lib/safety/scam-heuristics";
import type { AssetIdentifier } from "@/lib/types/account";

export interface ScamTokenNoticeProps {
  readonly findings: readonly ScamFinding[];
  readonly network: NetworkConfig;
  // optional acknowledgment region rendered inside the notice (Resolve step)
  readonly footer?: ReactNode;
}

function assetCode(asset: AssetIdentifier): string {
  switch (asset.kind) {
    case "native":
      return "XLM";
    case "credit":
      return asset.code;
    case "liquidity_pool_shares":
      return "pool shares";
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

// UI-facing reason, address-free. The address is shown separately as a
// copyable, linkable element below (so it's readable and verifiable, not buried
// mid-sentence).
function reasonFor(flag: ScamFlag): string {
  switch (flag.id) {
    case "exact_symbol_collision": {
      const symbol = String(flag.detail?.symbol ?? "");
      return `Uses the symbol “${symbol}” of a well-known asset, but a different issuer than the official one on record (shown below). A classic impersonation.`;
    }
    case "lookalike_symbol": {
      const symbol = String(flag.detail?.symbol ?? "");
      const near = String(flag.detail?.lookalikeOf ?? "");
      const d = Number(flag.detail?.distance ?? 0);
      return `Symbol “${symbol}” is only ${d} character${d === 1 ? "" : "s"} away from “${near}”, a common look-alike trick.`;
    }
    case "suspicious_character": {
      const symbol = String(flag.detail?.symbol ?? "");
      return `Symbol “${symbol}” contains characters outside A-Z and 0-9 (homoglyphs/accents), which legitimate issuers don’t use.`;
    }
    case "unknown_contract":
      return "We don’t recognize this token: it isn’t on our list of known, trusted tokens. That doesn’t prove it’s a scam, but make sure you recognize it.";
  }
}

// short category chip for a flag, so the type of trick is scannable at a glance
function flagTag(flag: ScamFlag): string {
  switch (flag.id) {
    case "exact_symbol_collision":
      return "Impersonation";
    case "lookalike_symbol":
      return "Look-alike";
    case "suspicious_character":
      return "Hidden characters";
    case "unknown_contract":
      return "Unrecognized";
  }
}

export function ScamTokenNotice({
  findings,
  network,
  footer,
}: ScamTokenNoticeProps): React.JSX.Element | null {
  if (findings.length === 0) return null;

  return (
    <Notice
      tone="danger"
      role="note"
      data-testid="scam-token-notice"
      {...(footer !== undefined ? { footer } : {})}
      title={
        findings.length === 1
          ? "1 token looks suspicious"
          : `${findings.length} tokens look suspicious`
      }
    >
      <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
        Closing the account discards these, which is safe, they hold no real value. We&apos;re only
        flagging them so you recognize what you held.
      </span>
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
        {findings.map((f) => {
          const isCredit = f.asset.kind === "credit";
          const isContract = f.flag.id === "unknown_contract" && f.flag.detail?.contractId;
          const address = isContract
            ? String(f.flag.detail?.contractId)
            : isCredit
              ? f.asset.issuer
              : null;
          const addrLabel = isContract ? "Contract" : "Issuer";
          const href =
            address === null
              ? undefined
              : isContract
                ? explorerContractUrl(network, address)
                : explorerAccountUrl(network, address);
          // the verified official issuer for this symbol, so the user can compare
          // it against the impersonator above instead of trusting our word
          const canonicalIssuer =
            f.flag.id === "exact_symbol_collision" && f.flag.detail?.canonicalIssuer
              ? String(f.flag.detail.canonicalIssuer)
              : null;
          return (
            <li
              key={`${assetKey(f.asset)}-${f.flag.id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "11px 12px",
                borderRadius: 10,
                background: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span
                  style={{
                    font: "700 12.5px/1 'Geist Mono', monospace",
                    color: "var(--fg)",
                  }}
                >
                  {assetCode(f.asset)}
                </span>
                <Badge tone="danger">{flagTag(f.flag)}</Badge>
              </div>
              <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--fg-2)" }}>
                {reasonFor(f.flag)}
              </span>
              {address !== null ? (
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}
                >
                  <span
                    style={{ fontSize: 10.5, color: "var(--danger)", textTransform: "uppercase" }}
                  >
                    {addrLabel} on account
                  </span>
                  <CopyableAddress
                    value={address}
                    label={addrLabel}
                    size={11.5}
                    {...(href !== undefined ? { href } : {})}
                  />
                </span>
              ) : null}
              {canonicalIssuer !== null ? (
                <span
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}
                >
                  <span
                    style={{ fontSize: 10.5, color: "var(--accent)", textTransform: "uppercase" }}
                  >
                    Official issuer
                  </span>
                  <CopyableAddress
                    value={canonicalIssuer}
                    label="Official issuer"
                    size={11.5}
                    href={explorerAccountUrl(network, canonicalIssuer)}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Notice>
  );
}
