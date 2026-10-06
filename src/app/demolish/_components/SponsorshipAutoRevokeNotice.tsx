"use client";

// inline notice surfaced ABOVE the configure form when the account has
export function SponsorshipAutoRevokeNotice({
  count,
}: {
  readonly count: number;
}): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="sponsorship-auto-revoke-notice"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 11,
        background: "var(--surface-2)",
        border: "1px solid color-mix(in srgb, var(--warning) 14%, transparent)",
        color: "var(--fg)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: "var(--surface-2)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--warning)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--fg)",
            letterSpacing: "-0.005em",
          }}
        >
          {count === 1 ? "1 self-sponsored entry" : `${count} self-sponsored entries`} on this
          account
        </div>
        <div
          style={{
            marginTop: 3,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--fg-2)",
          }}
        >
          We&apos;ll release {count === 1 ? "it" : "them"} automatically while closing the account.
          Nothing for you to do.
        </div>
      </div>
    </div>
  );
}
