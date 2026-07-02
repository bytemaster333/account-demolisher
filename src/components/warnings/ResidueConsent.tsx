"use client";

// shown when the account holds credit balances with no XLM conversion path.
// Such balances block the merge (their trustlines can't be removed with a live
// balance). The user must either handle them off-app, or explicitly consent to
// return each to its issuer, an irreversible transfer we never do silently.

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
      role="note"
      data-testid="residue-consent"
      title={
        credits.length === 1
          ? "1 balance can't be converted to XLM"
          : `${credits.length} balances can't be converted to XLM`
      }
    >
      We couldn&apos;t find a way to turn these tokens into XLM, so the account can&apos;t close
      while it still holds them. Either sell or move them from another app first, then re-check, or
      tick “return to issuer” below to send a token back to whoever created it. That&apos;s
      permanent, you&apos;ll almost certainly get nothing back, and it can&apos;t be undone.
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
            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: "inline-flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <CopyableAddress
                value={c.issuer}
                label="Created by"
                head={4}
                tail={4}
                size={11.5}
                href={explorerAccountUrl(network, c.issuer)}
              />
              <span style={{ fontSize: 11, color: "var(--fg-3)", lineHeight: 1.4 }}>
                This is where “return to issuer” would send the token.
              </span>
            </span>
            <Checkbox
              tone="warning"
              checked={consentedSet.has(c.key)}
              onChange={(v) => onToggle(c.key, v)}
              label={
                <span style={{ color: "var(--warning)", fontWeight: 600, whiteSpace: "nowrap" }}>
                  Return to issuer (permanent, you keep nothing)
                  {/* screen-reader-only: the full, unambiguous consequence for this
                      specific balance, so the checkbox never reads as a bare toggle */}
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
                    {`: return ${c.amount} ${c.code} to the address that created it. This is permanent, you'll almost certainly get nothing back, and it can't be undone.`}
                  </span>
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
