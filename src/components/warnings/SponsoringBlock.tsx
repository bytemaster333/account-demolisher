"use client";

// shown when the account sponsors ledger entries for other accounts, which
// stellar won't let it merge away and the batcher can't revoke. the caller only
// renders it when numSponsoring exceeds what the close releases on its own, so
// there is no way to continue from here.

import { useEffect, useId, useRef } from "react";

export interface SponsoringBlockProps {
  // audit.sponsorship.numSponsoring: ledger entries this account pays the
  // reserve for, its own included
  readonly numSponsoring: number;
  // the account's own sponsored entries the close releases by itself
  readonly coverable: number;
  readonly onDismiss: () => void;
  // ignored: this screen never continues. kept until the demolish page stops
  // passing it.
  readonly onProceed?: () => void;
  readonly className?: string;
}

export function SponsoringBlock({
  numSponsoring,
  coverable,
  onDismiss,
  className,
}: SponsoringBlockProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // entries, not accounts: sponsoring one account's creation alone counts 2
  const foreign = Math.max(0, numSponsoring - coverable);

  return (
    <div
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="sponsoring-block"
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
          aria-hidden
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
        This account is paying deposits for other accounts
      </h1>
      <p
        id={descriptionId}
        style={{
          margin: "15px auto 0",
          maxWidth: 450,
          fontSize: 15,
          lineHeight: 1.6,
          color: "var(--fg-2)",
        }}
      >
        This account pays the reserve deposit (a{" "}
        <em style={{ fontStyle: "normal", color: "var(--fg)" }}>sponsorship</em>) for{" "}
        <strong
          data-testid="sponsoring-block-count"
          style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}
        >
          {foreign}
        </strong>{" "}
        {foreign === 1 ? "ledger entry" : "ledger entries"} that belong to other accounts (one
        sponsored account can account for several entries). Stellar won&apos;t let an account close
        while it does that, so those sponsorships must be removed first, with another tool (for
        example the Stellar Laboratory), not here. Once they&apos;re removed, come back and try
        again.
      </p>
      <div
        style={{
          marginTop: 28,
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <button
          ref={primaryRef}
          type="button"
          onClick={onDismiss}
          data-testid="sponsoring-block-dismiss"
          style={{
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
            aria-hidden
          >
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          Disconnect and go back
        </button>
      </div>
    </div>
  );
}
