"use client";

// inline informational notice surfaced above the configure form when the
// account has claimable balances the demolition will settle automatically.

import { Notice } from "@/components/ui";

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
    <Notice
      tone="warning"
      role="status"
      data-testid="pending-claimable-balances"
      icon={
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--warning)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M12 12v4M9 14h6" />
        </svg>
      }
      title={
        pending.length === 1
          ? "1 claimable balance attached to this account"
          : `${pending.length} claimable balances attached to this account`
      }
    >
      The demolisher will claim {pending.length === 1 ? "it" : "them"} into your account and release
      the sponsorship reserve as part of the close-out — no action needed.
      <ul
        data-testid="pending-claimable-balances-list"
        style={{
          listStyle: "none",
          margin: "12px 0 0",
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
              <span style={{ fontSize: 11, color: "var(--warning)", whiteSpace: "nowrap" }}>
                {cb.reason}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
