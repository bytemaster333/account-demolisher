"use client";

// why the run ended: the user backed out, or the wallet or network changed under
// it (the plan was built for that account and network, so it was discarded)
export type CancelReason = "user" | "wallet-changed";

export function CancelledPanel({
  reason,
  publishedRequest,
  onStartOver,
}: {
  readonly reason: CancelReason;
  // a signing request already published to the relay before the run ended
  readonly publishedRequest: { readonly planId: string; readonly validUntil: Date | null } | null;
  readonly onStartOver: () => void;
}): React.JSX.Element {
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
        {reason === "wallet-changed" ? "This plan was discarded" : "Nothing was changed"}
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: "var(--fg-2)", lineHeight: 1.5 }}>
        {reason === "wallet-changed"
          ? "Your wallet or network changed while the plan was open, so it no longer matches the account it was built for. Nothing from it ran."
          : "You cancelled before anything ran, so your account is untouched."}{" "}
        Start over whenever you&apos;re ready.
      </p>
      {publishedRequest !== null ? (
        <div
          role="note"
          data-testid="cancelled-request-note"
          style={{
            margin: "0 0 16px",
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--fg-2)",
            textAlign: "left",
          }}
        >
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            The signing request you published stays valid until{" "}
            {publishedRequest.validUntil
              ? publishedRequest.validUntil.toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : "its time limit"}
            .
          </strong>{" "}
          Leaving this page doesn&apos;t withdraw it: once enough co-signers sign, anyone holding
          the signed transaction can still submit it and close the account. To make sure it never
          runs, submit any transaction from this account first (for example a bump sequence
          operation) signed with enough weight. That uses up its sequence number and the request can
          no longer be submitted. Otherwise, let it expire.
        </div>
      ) : null}
      <button
        type="button"
        onClick={onStartOver}
        data-testid="demolish-cancelled-reset"
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
