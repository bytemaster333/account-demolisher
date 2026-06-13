"use client";

// shown when audit.sponsorship.numSponsoring > 0

import { useEffect, useId, useRef } from "react";

export interface SponsoringBlockProps {
  // audit.sponsorship.numSponsoring
  readonly numSponsoring: number;
  // count the classic batcher can auto-revoke (self-sponsored entries on this account)
  readonly coverable: number;
  readonly onDismiss: () => void;
  // fires only when coverable === numSponsoring
  readonly onProceed: () => void;
  readonly className?: string;
}

export function SponsoringBlock({
  numSponsoring,
  coverable,
  onDismiss,
  onProceed,
  className,
}: SponsoringBlockProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  const isSoft = coverable === numSponsoring;
  const foreign = numSponsoring - coverable;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="sponsoring-block"
      data-mode={isSoft ? "soft" : "hard"}
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
          background: isSoft ? "var(--warning-soft)" : "var(--danger-soft)",
          border: `1px solid color-mix(in srgb, var(${isSoft ? "--warning" : "--danger"}) 30%, transparent)`,
          display: "grid",
          placeItems: "center",
        }}
      >
        {isSoft ? (
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--warning)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        ) : (
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
        )}
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
        {isSoft ? "This account sponsors entries" : "This account sponsors entries for others"}
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
        {isSoft ? (
          <>
            The demolisher will automatically revoke{" "}
            <strong
              data-testid="sponsoring-block-count"
              style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}
            >
              {numSponsoring}
            </strong>{" "}
            sponsorship{numSponsoring === 1 ? "" : "(s)"} as part of the close-out. You can proceed.
          </>
        ) : (
          <>
            It is currently sponsoring reserves for{" "}
            <strong
              data-testid="sponsoring-block-count"
              style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}
            >
              {numSponsoring}
            </strong>{" "}
            other accounts. An account with active sponsorships cannot be merged, the sponsorships
            must be revoked off-platform first.{" "}
            <span data-testid="sponsoring-block-foreign-note">
              <strong style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}>
                {foreign}
              </strong>{" "}
              of these sponsor entries on other accounts and must be revoked off-platform first.
            </span>
          </>
        )}
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
        {isSoft ? (
          <button
            ref={primaryRef}
            type="button"
            onClick={onProceed}
            data-testid="sponsoring-block-proceed"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 20px",
              borderRadius: 11,
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "var(--accent-fg, #fff)",
              fontWeight: 600,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            I understand — demolish anyway
          </button>
        ) : null}
        <button
          ref={isSoft ? undefined : primaryRef}
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
          >
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
          Go back
        </button>
      </div>
    </div>
  );
}
