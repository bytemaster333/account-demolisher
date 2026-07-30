// Browser-side metric beacon. Fire-and-forget and totally swallowed: analytics
// must NEVER throw into, block, or otherwise affect the close flow. Uses
// navigator.sendBeacon (survives page unload) with a keepalive fetch fallback.

import type { FunnelStep, MetricNetwork, MetricPage } from "@/lib/metrics/events";

const ENDPOINT = "/api/metrics";

function send(body: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    const payload = JSON.stringify(body);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon(ENDPOINT, blob)) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
      keepalive: true,
    }).catch(() => {});
  } catch {
    // intentionally ignored — a metric must never surface to the user
  }
}

export function trackVisit(page: MetricPage, network?: MetricNetwork): void {
  send(network ? { type: "visit", page, network } : { type: "visit", page });
}

export function trackFunnel(network: MetricNetwork, step: FunnelStep): void {
  send({ type: "funnel", network, step });
}

export function trackClose(network: MetricNetwork, txHash: string): void {
  send({ type: "close", network, txHash });
}
