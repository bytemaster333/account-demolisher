"use client";

export function CancelledPanel({ onResume }: { readonly onResume: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 24,
        boxShadow: "var(--shadow-sm)",
        textAlign: "center",
      }}
    >
      <h2
        style={{
          margin: "0 0 6px",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          color: "var(--fg)",
        }}
      >
        Nothing was changed
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: "var(--fg-2)", lineHeight: 1.5 }}>
        You cancelled before anything was signed, so your account is completely untouched. You can
        safely leave, or start over whenever you&apos;re ready.
      </p>
      <button
        type="button"
        onClick={onResume}
        data-testid="demolish-reset"
        style={{
          padding: "12px 18px",
          borderRadius: 11,
          border: "1px solid var(--accent-line)",
          background: "transparent",
          color: "var(--accent)",
          fontWeight: 600,
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Start over
      </button>
    </div>
  );
}
