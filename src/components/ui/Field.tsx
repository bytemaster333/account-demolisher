"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { MONO, RADIUS } from "./tokens";

const inputBase: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: RADIUS.md,
  border: "1px solid var(--border-2)",
  background: "var(--surface-2)",
  color: "var(--fg)",
  fontSize: 14,
  boxSizing: "border-box",
};

export interface FieldProps {
  readonly label?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
  readonly type?: "text" | "password";
  readonly mono?: boolean;
  readonly onEnter?: () => void;
  readonly autoComplete?: string;
  readonly spellCheck?: boolean;
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
  readonly right?: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  value,
  onChange,
  placeholder,
  type = "text",
  mono = false,
  onEnter,
  autoComplete,
  spellCheck,
  "aria-label": ariaLabel,
  "data-testid": testId,
  right,
}: FieldProps): React.JSX.Element {
  return (
    <div>
      {label ? (
        <label
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--fg-2)",
            marginBottom: 7,
          }}
        >
          {label}
        </label>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={onEnter ? (e) => e.key === "Enter" && onEnter() : undefined}
          placeholder={placeholder}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          aria-label={ariaLabel}
          data-testid={testId}
          style={{
            ...inputBase,
            flex: 1,
            fontFamily: mono ? MONO : undefined,
            fontSize: mono ? 13 : 14,
            borderColor: error ? "color-mix(in srgb, var(--danger) 55%, transparent)" : undefined,
          }}
        />
        {right}
      </div>
      {error ? (
        <p role="alert" style={{ margin: "7px 0 0", fontSize: 12.5, color: "var(--danger)" }}>
          {error}
        </p>
      ) : hint ? (
        <p style={{ margin: "7px 0 0", fontSize: 12, color: "var(--fg-3)" }}>{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  tone = "accent",
  "data-testid": testId,
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly label: ReactNode;
  // border + checkmark color when checked (flat: no filled background)
  readonly tone?: "accent" | "warning";
  readonly "data-testid"?: string;
}): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const toneVar = tone === "warning" ? "var(--warning)" : "var(--accent)";
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
      <span
        style={{
          position: "relative",
          width: 17,
          height: 17,
          flexShrink: 0,
          borderRadius: 5,
          border: `1px solid ${checked ? toneVar : "var(--border-2)"}`,
          background: "var(--surface-2)",
          display: "grid",
          placeItems: "center",
          boxShadow: focused ? `0 0 0 3px color-mix(in srgb, ${toneVar} 22%, transparent)` : "none",
          transition: "border-color .12s, box-shadow .12s",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          data-testid={testId}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            margin: 0,
            opacity: 0,
            cursor: "pointer",
          }}
        />
        {checked ? (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke={toneVar}
            strokeWidth={3.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : null}
      </span>
      <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{label}</span>
    </label>
  );
}
