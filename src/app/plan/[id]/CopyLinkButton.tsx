"use client";

// copy-link button for the plan card

import { useCallback, useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 1800;

export function CopyLinkButton(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  const onClick = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setUnsupported(false);
      } else {
        setUnsupported(true);
        return;
      }
    } catch {
      setUnsupported(true);
      return;
    }
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, []);

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      aria-live="polite"
      data-testid="plan-copy-link"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "7px 12px",
        borderRadius: 9,
        border: "1px solid var(--border-2)",
        background: "var(--surface)",
        color: "var(--fg)",
        font: "600 12.5px/1 Geist,sans-serif",
        cursor: "pointer",
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {copied ? (
          <path d="M20 6L9 17l-5-5" />
        ) : (
          <>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </>
        )}
      </svg>
      {copied ? "Copied" : unsupported ? "Copy failed" : "Copy link"}
    </button>
  );
}
