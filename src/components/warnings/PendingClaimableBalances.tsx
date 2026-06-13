"use client";

// inline informational notice surfaced above the configure form when the

export interface PendingClaimableBalanceEntry {
  readonly id: string;
  // decimal string
  readonly amount: string;
  // asset code or "XLM"
  readonly assetLabel: string;
  // optional reason why it isn't claimable yet
  readonly reason?: string;
}

export interface PendingClaimableBalancesProps {
  readonly pending: readonly PendingClaimableBalanceEntry[];
}

export function PendingClaimableBalances({
  pending,
}: PendingClaimableBalancesProps): React.JSX.Element | null {
  if (pending.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="pending-claimable-balances"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        borderRadius: 11,
        background: "color-mix(in srgb, var(--warning-soft) 55%, transparent)",
        border: "1px solid color-mix(in srgb, var(--warning) 14%, transparent)",
        color: "var(--fg)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "color-mix(in srgb, var(--warning) 18%, transparent)",
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
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M12 12v4M9 14h6" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: "var(--fg)",
              letterSpacing: "-0.005em",
            }}
          >
            {pending.length === 1
              ? "1 claimable balance attached to this account"
              : `${pending.length} claimable balances attached to this account`}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            The demolisher will claim {pending.length === 1 ? "it" : "them"} into your account and
            release the sponsorship reserve as part of the close-out — no action needed.
          </div>
        </div>
      </div>

      <ul
        data-testid="pending-claimable-balances-list"
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 220,
          overflowY: "auto",
        }}
      >
        {pending.map((cb) => (
          <li
            key={cb.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 11px",
              borderRadius: 8,
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--warning)",
                flexShrink: 0,
              }}
            />
            <span
              style={{
                font: "600 12.5px/1 'Geist Mono', monospace",
                color: "var(--fg)",
                whiteSpace: "nowrap",
              }}
            >
              {cb.amount} {cb.assetLabel}
            </span>
            <span
              style={{
                flex: 1,
                font: "500 11.5px/1 'Geist Mono', monospace",
                color: "var(--fg-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={cb.id}
            >
              {cb.id.slice(0, 12)}…{cb.id.slice(-6)}
            </span>
            {cb.reason !== undefined ? (
              <span
                style={{
                  fontSize: 11,
                  color: "var(--warning)",
                  whiteSpace: "nowrap",
                }}
              >
                {cb.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
