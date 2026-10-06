"use client";

import type { AuditSigner } from "@/lib/types/account";

// fewest signers whose weights reach the threshold: take the heaviest keys
// first. null when every key together still falls short.
export function minSignerCount(threshold: number, signers: readonly AuditSigner[]): number | null {
  const weights = signers
    .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
    .map((s) => s.weight)
    .sort((a, b) => b - a);
  const target = Math.max(1, threshold);
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i]!;
    if (sum >= target) return i + 1;
  }
  return null;
}

// thin neutral orientation bar for a shared account (not an alarm). Thresholds
// and signer weights are weights, not a count of signatures, so both are shown
// as weights plus the fewest signers that can reach the threshold.
export function MultisigContextBar({
  threshold,
  have,
  signers,
}: {
  readonly threshold: number;
  readonly have: number;
  readonly signers: readonly AuditSigner[];
}): React.JSX.Element {
  const needed = minSignerCount(threshold, signers);
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
        Signing weight needed:{" "}
        <strong style={{ color: "var(--fg-2)", fontWeight: 600 }}>{threshold}</strong> · your
        key&apos;s weight: <strong style={{ color: "var(--fg-2)", fontWeight: 600 }}>{have}</strong>{" "}
        ·{" "}
        {needed === null
          ? "the account's signers can't reach it together"
          : `at least ${needed} signer${needed === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
