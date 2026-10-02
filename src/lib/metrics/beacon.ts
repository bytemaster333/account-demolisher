// browser-side metric beacon. analytics must never throw into, block, or
// otherwise affect the close flow, so nothing here throws or is awaited by the
// caller. visits and funnel steps use navigator.sendBeacon (survives page
// unload) with a keepalive fetch fallback. a close is sent with fetch and
// retried while the server answers 503, because the server can only count it
// after Horizon confirms it, and a transient Horizon outage would otherwise drop
// a real close for good.

import type { FunnelStep, MetricNetwork, MetricPage } from "@/lib/metrics/events";

const ENDPOINT = "/api/metrics";
// a close is retried this many times after the first try, waiting 2s, 4s, 8s...
const CLOSE_RETRIES = 4;
const CLOSE_RETRY_BASE_MS = 2_000;

function warn(what: string, e: unknown): void {
  console.warn(`metrics: could not send ${what}`, e);
}

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
    }).catch((e: unknown) => warn(String(body.type), e));
  } catch (e) {
    warn(String(body.type), e);
  }
}

async function sendClose(payload: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let failure: unknown;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        body: payload,
        headers: { "content-type": "application/json" },
        keepalive: true,
      });
      // 503 means Horizon couldn't be reached to verify; every other answer
      // (recorded, duplicate, refused) is final
      if (res.status !== 503) return;
      failure = "status 503";
    } catch (e) {
      failure = e;
    }
    if (attempt >= CLOSE_RETRIES) {
      warn("close", failure);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, CLOSE_RETRY_BASE_MS * 2 ** attempt));
  }
}

export function trackVisit(page: MetricPage, network?: MetricNetwork): void {
  send(network ? { type: "visit", page, network } : { type: "visit", page });
}

export function trackFunnel(network: MetricNetwork, step: FunnelStep): void {
  send({ type: "funnel", network, step });
}

export function trackClose(network: MetricNetwork, txHash: string): void {
  if (typeof window === "undefined") return;
  void sendClose(JSON.stringify({ type: "close", network, txHash }));
}
