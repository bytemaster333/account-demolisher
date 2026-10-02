"use client";

// small uppercase label that groups the multisig configure sections
// thin neutral orientation bar for a shared account (not an alarm)
export function MultisigContextBar({
  threshold,
  have,
}: {
  readonly threshold: number;
  readonly have: number;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        padding: "12px 16px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-2)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Shared account
      </span>
      <span style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
        Signatures needed:{" "}
        <strong style={{ color: "var(--fg-2)", fontWeight: 600 }}>{threshold}</strong> · you have{" "}
        <strong style={{ color: "var(--fg-2)", fontWeight: 600 }}>{have}</strong>
      </span>
    </div>
  );
}
