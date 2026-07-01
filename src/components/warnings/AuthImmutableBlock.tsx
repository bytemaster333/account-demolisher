"use client";

// full-screen takeover when audit.flags.authImmutable is true. no continue path
// styled to match the dc design (lines 529-547): centered icon, headline, copy, back button

import { useEffect, useId, useRef } from "react";

export interface AuthImmutableBlockProps {
  // back / dismiss handler
  readonly onDismiss?: () => void;
  readonly className?: string;
}

export function AuthImmutableBlock({
  onDismiss,
  className,
}: AuthImmutableBlockProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="auth-immutable-block"
      className={className}
      style={{
        maxWidth: 560,
        margin: "50px auto 0",
        padding: "0 20px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          margin: "0 auto 24px",
          borderRadius: 20,
          background: "var(--surface-2)",
          border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <svg
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--danger)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6l12.8 12.8" />
        </svg>
      </div>
      <h1
        id={titleId}
        style={{
          margin: 0,
          fontSize: 30,
          fontWeight: 600,
          letterSpacing: "-0.025em",
          color: "var(--fg)",
        }}
      >
        This account can&apos;t be closed
      </h1>
      <p
        id={descriptionId}
        style={{
          margin: "15px auto 0",
          maxWidth: 430,
          fontSize: 15,
          lineHeight: 1.6,
          color: "var(--fg-2)",
        }}
      >
        This account was permanently set so it can never be closed — that&apos;s a one-way Stellar
        setting and no tool can change it. Your funds are safe and the account still works normally;
        you just can&apos;t close it here. You can keep using it, or move your funds out to another
        account yourself.
        <span
          style={{
            display: "block",
            marginTop: 12,
            font: "500 12px 'Geist Mono', monospace",
            color: "var(--fg-3)",
          }}
        >
          Technical detail: the account&apos;s auth_immutable flag is set.
        </span>
      </p>
      <button
        ref={buttonRef}
        type="button"
        onClick={onDismiss}
        data-testid="auth-immutable-block-dismiss"
        style={{
          marginTop: 28,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 20px",
          borderRadius: 11,
          border: "1px solid var(--border-2)",
          background: "var(--surface)",
          color: "var(--fg)",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        Disconnect and go back
      </button>
    </div>
  );
}
