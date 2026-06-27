"use client";

// Live-refresh island for the Refractor plan view. The page itself is a
// force-dynamic server render, so re-fetching Refractor is just router.refresh()
// — that re-runs the server component and streams new signer/submission state in
// without a full navigation. Auto-polls on a light interval and offers a manual
// refresh; the parent unmounts this whole island once the plan is submitted, so
// there's no "stopped" branch to maintain here.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui";

const POLL_MS = 8000;

export function PlanLiveRefresh(): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [auto, setAuto] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  // bumped once a second so the "checked Ns ago" label stays current without
  // holding a rendered clock value in state
  const [, setTick] = useState(0);

  const doRefresh = useCallback(() => {
    setLastCheckedAt(Date.now());
    startTransition(() => {
      router.refresh();
    });
  }, [router]);

  // auto-poll while enabled. setState lives in the interval callback (async),
  // never synchronously in the effect body
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => doRefresh(), POLL_MS);
    return () => clearInterval(id);
  }, [auto, doRefresh]);

  // 1s ticker for the relative-time label
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 3600), 1000);
    return () => clearInterval(id);
  }, []);

  const ago = relativeAgo(lastCheckedAt);
  const statusText = isPending
    ? "Checking Refractor…"
    : auto
      ? `Auto-refreshing · checked ${ago}`
      : `Paused · checked ${ago}`;

  return (
    <div
      data-testid="plan-live-refresh"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 14px",
        borderRadius: 12,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        marginBottom: 20,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 9,
          fontSize: 12,
          color: "var(--fg-3)",
        }}
      >
        <LiveDot pending={isPending} active={auto} />
        {statusText}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={() => setAuto((a) => !a)}
          data-testid="plan-live-toggle"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: "600 12px/1 Geist, sans-serif",
            color: "var(--fg-3)",
          }}
        >
          {auto ? "Pause" : "Resume"}
        </button>
        <Button
          variant="secondary"
          size="sm"
          onClick={doRefresh}
          loading={isPending}
          disabled={isPending}
          iconLeft={isPending ? undefined : <RefreshGlyph />}
          data-testid="plan-refresh-button"
        >
          Refresh
        </Button>
      </div>
    </div>
  );
}

function LiveDot({
  pending,
  active,
}: {
  readonly pending: boolean;
  readonly active: boolean;
}): React.JSX.Element {
  const color = pending ? "var(--accent)" : active ? "var(--success)" : "var(--fg-3)";
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: pending
          ? "0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)"
          : "none",
      }}
    />
  );
}

function RefreshGlyph(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

function relativeAgo(ts: number | null): string {
  if (ts === null) return "just now";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}
