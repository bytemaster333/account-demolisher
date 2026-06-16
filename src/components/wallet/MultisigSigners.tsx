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
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>
          This account needs multiple signatures to close
        </div>
        <div style={{ marginTop: 3, fontSize: 12.5, lineHeight: 1.5, color: "var(--fg-2)" }}>
          Signing weight {currentWeight} of {threshold} required. Add the secret keys of enough
          authorized signers to reach the threshold — they sign locally and are never sent anywhere.
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
          {error ? <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div> : null}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--success)" }}>
          Threshold met — ready to demolish.
        </div>
      )}
    </div>
  );
}
