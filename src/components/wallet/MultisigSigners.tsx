"use client";

import { useState } from "react";

// shown when the account being closed requires more signature weight than the
// connected signer provides. The user pastes additional signer secret keys
// until the combined weight meets the account's threshold.

export interface AddedSigner {
  readonly publicKey: string;
  readonly weight: number;
}

export interface MultisigSignersProps {
  readonly threshold: number;
  readonly currentWeight: number;
  readonly added: readonly AddedSigner[];
  // validate + register a pasted secret key; return an error string, or null on success
  readonly onAddSecret: (secret: string) => string | null;
  readonly onRemove: (publicKey: string) => void;
}

export function MultisigSigners({
  threshold,
  currentWeight,
  added,
  onAddSecret,
  onRemove,
}: MultisigSignersProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const met = currentWeight >= threshold;

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    // a Stellar public key starts with "G"; the secret key starts with "S".
    // catch the common paste-the-wrong-one mistake with an actionable message.
    if (/^G[A-Z2-7]{55}$/.test(trimmed)) {
      setError("That's a public key (G…). Paste the secret key, which starts with S.");
      return;
    }
    const err = onAddSecret(trimmed);
    if (err) {
      setError(err);
      return;
    }
    setValue("");
    setError(null);
  };

  return (
    <div
      role="group"
      aria-label="Multisig signers"
      data-testid="multisig-signers"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 12,
        background: met
          ? "color-mix(in srgb, var(--success-soft) 55%, transparent)"
          : "color-mix(in srgb, var(--warning-soft) 60%, transparent)",
        border: `1px solid color-mix(in srgb, var(--${met ? "success" : "warning"}) 26%, transparent)`,
        color: "var(--fg)",
      }}
    >
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            This account needs more than one person to approve closing it
          </div>
          <span
            data-testid="multisig-status"
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 9px",
              borderRadius: 999,
              fontSize: 11.5,
              fontWeight: 700,
              whiteSpace: "nowrap",
              color: met ? "var(--success)" : "var(--warning)",
              border: `1px solid color-mix(in srgb, var(--${met ? "success" : "warning"}) 40%, transparent)`,
              background: "var(--surface)",
            }}
          >
            <span aria-hidden="true">{met ? "✓" : "!"}</span>
            {met ? "Ready" : "Not enough yet"}
          </span>
        </div>
        <div
          style={{
            marginTop: 6,
            fontSize: 12.5,
            fontWeight: 600,
            lineHeight: 1.5,
            color: "var(--fg)",
          }}
        >
          Keys are used only in your browser to sign, and are never uploaded or stored.
        </div>
        <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
          You need signatures adding up to {threshold}; you currently have {currentWeight}. Paste
          the secret keys of enough authorized signers to reach that total.
        </div>
      </div>

      {added.length > 0 ? (
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
          {added.map((s) => (
            <li
              key={s.publicKey}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 11px",
                borderRadius: 8,
                background: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <span
                style={{
                  flex: 1,
                  font: "500 12px/1 'Geist Mono', monospace",
                  color: "var(--fg)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={s.publicKey}
              >
                {s.publicKey.slice(0, 8)}…{s.publicKey.slice(-6)}
              </span>
              <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>weight {s.weight}</span>
              <button
                type="button"
                onClick={() => onRemove(s.publicKey)}
                aria-label={`Remove signer ${s.publicKey}`}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--fg-3)",
                  cursor: "pointer",
                  fontSize: 15,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!met ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Signer secret key (S…)"
              aria-label="Signer secret key"
              data-testid="multisig-secret-input"
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 9,
                border: "1px solid var(--border-2)",
                background: "var(--surface)",
                color: "var(--fg)",
                font: "500 13px/1 'Geist Mono', monospace",
              }}
            />
            <button
              type="button"
              onClick={submit}
              data-testid="multisig-add-signer"
              style={{
                padding: "10px 14px",
                borderRadius: 9,
                border: "1px solid var(--border-2)",
                background: "var(--surface)",
                color: "var(--fg)",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Add signer
            </button>
          </div>
          {error ? (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger)" }}>
              {error}
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--success)" }}>
          <span aria-hidden="true">✓ </span>Ready. You have enough signatures to close the account.
        </div>
      )}
    </div>
  );
}
