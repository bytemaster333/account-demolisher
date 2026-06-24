"use client";

// informational notice for tokens the account holds that trip the scam
// heuristics (look-alike symbols, homoglyphs, off-allowlist contracts). The
// demolition removes these anyway; this just makes sure the user recognizes
// what they held. Not a blocker — the typed confirmation is the safety net.

import type { ReactNode } from "react";

import { CopyableAddress, Notice } from "@/components/ui";
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

// UI-facing reason, address-free — the address is shown separately as a
// copyable, linkable element below (so it's readable and verifiable, not buried
// mid-sentence).
function reasonFor(flag: ScamFlag): string {
  switch (flag.id) {
    case "exact_symbol_collision": {
      const symbol = String(flag.detail?.symbol ?? "");
      return `Uses the symbol “${symbol}” of a trusted tier-1 asset, but is issued by a different address than the real one — a classic impersonation.`;
    }
    case "lookalike_symbol": {
      const symbol = String(flag.detail?.symbol ?? "");
      const near = String(flag.detail?.lookalikeOf ?? "");
      const d = Number(flag.detail?.distance ?? 0);
      return `Symbol “${symbol}” is only ${d} character${d === 1 ? "" : "s"} away from “${near}” — a common look-alike trick.`;
    }
    case "suspicious_character": {
      const symbol = String(flag.detail?.symbol ?? "");
      return `Symbol “${symbol}” contains characters outside A–Z and 0–9 (homoglyphs/accents), which legitimate issuers don’t use.`;
    }
    case "unknown_contract":
      return "This token’s contract isn’t on the verified allow-list.";
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
      role="alert"
      data-testid="scam-token-notice"
      {...(footer !== undefined ? { footer } : {})}
      title={
        findings.length === 1
          ? "1 token looks suspicious"
          : `${findings.length} tokens look suspicious`
      }
    >
      <ul
        style={{
          listStyle: "none",
          margin: "2px 0 8px",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 11,
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
          return (
            <li
              key={`${assetKey(f.asset)}-${f.flag.id}`}
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <span style={{ font: "600 12.5px/1 'Geist Mono', monospace", color: "var(--fg)" }}>
                {assetCode(f.asset)}
              </span>
              <span style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--fg-2)" }}>
                {reasonFor(f.flag)}
              </span>
              {address !== null ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 11, color: "var(--fg-3)" }}>{addrLabel}</span>
                  <CopyableAddress
                    value={address}
                    label={addrLabel}
                    size={11.5}
                    {...(href !== undefined ? { href } : {})}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <span style={{ color: "var(--fg-3)", fontSize: 12 }}>
        These are removed as part of the close-out. Make sure you recognize them before proceeding.
      </span>
    </Notice>
  );
}
