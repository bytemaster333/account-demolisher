"use client";

// shown when the account holds credit balances with no XLM conversion path.
// Such balances block the merge (their trustlines can't be removed with a live
// balance). The user must either handle them off-app, or explicitly consent to
// return each to its issuer — an irreversible transfer we never do silently.

export interface ResidueConsentCredit {
  readonly key: string;
  readonly code: string;
  readonly issuer: string;
  readonly amount: string;
}

export interface ResidueConsentProps {
  readonly credits: readonly ResidueConsentCredit[];
  // pathKey()s currently consented to return-to-issuer
  readonly consented: readonly string[];
  readonly onToggle: (key: string, consent: boolean) => void;
  readonly onRebuild: () => void;
}

function shortIssuer(issuer: string): string {
  if (issuer.length <= 12) return issuer;
  return `${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
}

export function ResidueConsent({
  credits,
  consented,
  onToggle,
  onRebuild,
}: ResidueConsentProps): React.JSX.Element | null {
  if (credits.length === 0) return null;
  const consentedSet = new Set(consented);

  return (
    <div
      role="alert"
      data-testid="residue-consent"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 12,
        background: "color-mix(in srgb, var(--warning-soft) 60%, transparent)",
        border: "1px solid color-mix(in srgb, var(--warning) 26%, transparent)",
        color: "var(--fg)",
      }}
    >
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>
          {credits.length === 1
            ? "1 balance can't be converted to XLM"
            : `${credits.length} balances can't be converted to XLM`}
        </div>
        <div style={{ marginTop: 3, fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
          No market path to XLM was found for these assets, so the account cannot be closed while it
          holds them. Sell or move them yourself first, or tick “return to issuer” to send a balance
          back to the asset that issued it — this is irreversible and most issuers will not credit
          anything in return.
        </div>
      </div>

      <ul
        style={{
          listStyle: "none",
          margin: 0,
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
              padding: "8px 11px",
              borderRadius: 8,
              background: "var(--surface)",
              border: "1px solid var(--border)",
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
                font: "500 11.5px/1 'Geist Mono', monospace",
                color: "var(--fg-3)",
                whiteSpace: "nowrap",
              }}
              title={c.issuer}
            >
              {shortIssuer(c.issuer)}
            </span>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--warning)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                checked={consentedSet.has(c.key)}
                onChange={(e) => onToggle(c.key, e.target.checked)}
              />
              return to issuer
            </label>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onRebuild}
        data-testid="residue-rebuild"
        style={{
          alignSelf: "flex-start",
          padding: "9px 14px",
          borderRadius: 9,
          border: "1px solid var(--border-2)",
          background: "var(--surface)",
          color: "var(--fg)",
          fontWeight: 600,
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        Rebuild plan with these choices
      </button>
    </div>
  );
}
