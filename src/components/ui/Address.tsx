"use client";

import { useState } from "react";
import { MONO, RADIUS } from "./tokens";

function middleTruncate(value: string, head = 6, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// Truncated monospace address with an inline copy button and full-value title.
// Fixes the /allowances gap where spender/contract were truncated with no way
// to read or copy them.
export function CopyableAddress({
  value,
  head = 6,
  tail = 6,
  label,
  size = 12.5,
}: {
  readonly value: string;
  readonly head?: number;
  readonly tail?: number;
  readonly label?: string;
  readonly size?: number;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* clipboard blocked — ignore */
      });
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
      <code
        title={label ? `${label}: ${value}` : value}
        style={{
          fontFamily: MONO,
          fontSize: size,
          color: "var(--fg)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {middleTruncate(value, head, tail)}
      </code>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy full address"}
        aria-label={copied ? "Copied to clipboard" : `Copy ${label ?? "address"}`}
        style={{
          display: "grid",
          placeItems: "center",
          width: 24,
          height: 24,
          flexShrink: 0,
          borderRadius: RADIUS.sm,
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          color: copied ? "var(--success)" : "var(--fg-3)",
          cursor: "pointer",
        }}
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>
    </span>
  );
}
