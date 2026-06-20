"use client";

import type { CSSProperties, ReactNode } from "react";
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
  "data-testid": testId,
}: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly label: ReactNode;
  readonly "data-testid"?: string;
}): React.JSX.Element {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        data-testid={testId}
        style={{ width: 16, height: 16, accentColor: "var(--accent)", cursor: "pointer" }}
      />
      <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{label}</span>
    </label>
  );
}
