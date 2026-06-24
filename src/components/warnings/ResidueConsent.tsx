"use client";

// shown when the account holds credit balances with no XLM conversion path.
// Such balances block the merge (their trustlines can't be removed with a live
// balance). The user must either handle them off-app, or explicitly consent to
// return each to its issuer — an irreversible transfer we never do silently.

import { Button, Checkbox, CopyableAddress, Notice } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl } from "@/lib/explorer";

export interface ResidueConsentCredit {
  readonly key: string;
  readonly code: string;
  readonly issuer: string;
  readonly amount: string;
}

export interface ResidueConsentProps {
  readonly credits: readonly ResidueConsentCredit[];
  readonly network: NetworkConfig;
  // pathKey()s currently consented to return-to-issuer
  readonly consented: readonly string[];
  readonly onToggle: (key: string, consent: boolean) => void;
  readonly onRebuild: () => void;
  // when the surrounding step owns the rebuild action (the Resolve step's single
  // bottom button), hide this notice's own inline "Rebuild plan" button
  readonly hideRebuild?: boolean;
}

export function ResidueConsent({
  credits,
  network,
  consented,
  onToggle,
  onRebuild,
  hideRebuild = false,
}: ResidueConsentProps): React.JSX.Element | null {
  if (credits.length === 0) return null;
  const consentedSet = new Set(consented);

  return (
    <Notice
      tone="warning"
      role="alert"
      data-testid="residue-consent"
      title={
        credits.length === 1
          ? "1 balance can't be converted to XLM"
          : `${credits.length} balances can't be converted to XLM`
      }
    >
      No market path to XLM was found for these assets, so the account can&apos;t be closed while it
      holds them. Sell or move them yourself first, or tick “return to issuer” to send a balance
      back to the asset that issued it — this is irreversible and most issuers credit nothing in
      return.
      <ul
        style={{
          listStyle: "none",
          margin: "12px 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {credits.map((c) => (
          <li
            key={c.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 11px",
              borderRadius: 9,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
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
                label="Issuer"
                head={4}
                tail={4}
                size={11.5}
                href={explorerAccountUrl(network, c.issuer)}
              />
            </span>
            <Checkbox
              tone="warning"
              checked={consentedSet.has(c.key)}
              onChange={(v) => onToggle(c.key, v)}
              label={
                <span style={{ color: "var(--warning)", fontWeight: 600, whiteSpace: "nowrap" }}>
                  return to issuer
                </span>
              }
            />
          </li>
        ))}
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
