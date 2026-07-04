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
  href,
}: {
  readonly value: string;
  readonly head?: number;
  readonly tail?: number;
  readonly label?: string;
  readonly size?: number;
  // when set, adds an "open in explorer" link button next to copy
  readonly href?: string;
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
        /* clipboard blocked, ignore */
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
      {href !== undefined ? <ExplorerLinkButton href={href} label={label} /> : null}
    </span>
  );
}

// copy + explorer icon buttons on their own, for places that already render the
// full address themselves (e.g. the Review / confirmation destination, where the
// last 4 characters are highlighted) but still want "copy" and "inspect on
// explorer" affordances.
export function AddressActions({
  value,
  href,
  label,
}: {
  readonly value: string;
  readonly href?: string | undefined;
  readonly label?: string | undefined;
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
        /* clipboard blocked, ignore */
      });
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy full address"}
        aria-label={copied ? "Copied to clipboard" : `Copy ${label ?? "address"}`}
        style={{ ...ACTION_BTN, color: copied ? "var(--success)" : "var(--fg-3)" }}
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
      {href !== undefined ? <ExplorerLinkButton href={href} label={label} /> : null}
    </span>
  );
}

const ACTION_BTN: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 24,
  height: 24,
  flexShrink: 0,
  borderRadius: RADIUS.sm,
  border: "1px solid var(--border)",
  background: "var(--surface-2)",
  color: "var(--fg-3)",
  cursor: "pointer",
  textDecoration: "none",
};

function ExplorerLinkButton({
  href,
  label,
}: {
  readonly href: string;
  readonly label?: string | undefined;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${label ?? "address"} on stellar.expert`}
      aria-label={`Open ${label ?? "address"} in block explorer`}
      style={ACTION_BTN}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </a>
  );
}
