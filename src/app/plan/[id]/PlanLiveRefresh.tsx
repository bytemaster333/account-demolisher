"use client";

// Tiny live-refresh line for the Refractor plan view. The page is a
// force-dynamic server render, so re-fetching is just router.refresh(). Auto-
// polls on a light interval with a subtle manual refresh; the parent unmounts it
// once the plan reaches a terminal state.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

const POLL_MS = 8000;

export function PlanLiveRefresh(): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  // bumped once a second so the "checked Ns ago" label stays current
  const [, setTick] = useState(0);

  const doRefresh = useCallback(() => {
    setLastCheckedAt(Date.now());
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    const id = setInterval(() => doRefresh(), POLL_MS);
    return () => clearInterval(id);
  }, [doRefresh]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 3600), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      data-testid="plan-live-refresh"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        fontSize: 11.5,
        color: "var(--fg-3)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isPending ? "var(--accent)" : "var(--success)",
          flexShrink: 0,
        }}
      />
      <span>
        {isPending ? "Checking…" : `Auto-refreshing · checked ${relativeAgo(lastCheckedAt)}`}
      </span>
      <button
        type="button"
        onClick={doRefresh}
        disabled={isPending}
        data-testid="plan-refresh-button"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: isPending ? "default" : "pointer",
          font: "600 11.5px/1 Geist, sans-serif",
          color: "var(--accent)",
        }}
      >
        Refresh
      </button>
    </div>
  );
}

function relativeAgo(ts: number | null): string {
  if (ts === null) return "just now";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}
