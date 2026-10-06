// browser client for the signing-request relay (/api/plan). publishes a close
// transaction, fetches it, submits a signature, and follows live updates over
// Server-Sent Events, falling back to polling when the stream is refused or
// drops. only transaction envelopes cross the wire, never a secret key.

import type { StellarNetwork } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";

export interface RelaySigner {
  readonly key: string;
  readonly weight: number;
}

export interface RelayThresholds {
  readonly low: number;
  readonly med: number;
  readonly high: number;
}

export interface RelayPlan {
  readonly network: StellarNetwork;
  readonly xdr: string;
  // the closing account and the signer set the relay checks signatures against
  // (read from Horizon at publish); render this set instead of loading another
  readonly account: string;
  readonly signers: readonly RelaySigner[];
  readonly thresholds: RelayThresholds;
  // when the relay stops serving the request, epoch ms
  readonly expiresAt: number;
}

// the request no longer exists on the relay (expired, or the server restarted)
export class PlanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanNotFoundError";
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: string };
    if (typeof body.reason === "string" && body.reason.length > 0) return body.reason;
  } catch {
    // not a JSON error body; the status line below is all there is
  }
  return `Request failed (${res.status}).`;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// the networks the relay serves (its NETWORK_BUDGET in src/server/signing-relay.ts)
function isRelayNetwork(v: unknown): v is StellarNetwork {
  return v === "mainnet" || v === "testnet";
}

// validate a relay plan payload; null when it isn't one
export function parseRelayPlan(raw: unknown): RelayPlan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isRelayNetwork(r.network) || typeof r.xdr !== "string" || typeof r.account !== "string")
    return null;
  if (!Array.isArray(r.signers) || !isNumber(r.expiresAt)) return null;
  const signers: RelaySigner[] = [];
  for (const s of r.signers as unknown[]) {
    if (typeof s !== "object" || s === null) return null;
    const { key, weight } = s as Record<string, unknown>;
    if (typeof key !== "string" || !isNumber(weight)) return null;
    signers.push({ key, weight });
  }
  const t = r.thresholds as Record<string, unknown> | null | undefined;
  if (typeof t !== "object" || t === null) return null;
  if (!isNumber(t.low) || !isNumber(t.med) || !isNumber(t.high)) return null;
  return {
    network: r.network,
    xdr: r.xdr,
    account: r.account,
    signers,
    thresholds: { low: t.low, med: t.med, high: t.high },
    expiresAt: r.expiresAt,
  };
}

async function readPlan(res: Response): Promise<RelayPlan> {
  const plan = parseRelayPlan(await res.json());
  if (plan === null) throw new Error("The server returned an unexpected response.");
  return plan;
}

// publish a signed close transaction; returns its relay id (the transaction hash)
export async function publishPlan(network: StellarNetwork, xdr: string): Promise<string> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network, xdr }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { id?: string };
  if (typeof body.id !== "string") throw new Error("The server didn't return a request id.");
  return body.id;
}

export async function fetchPlan(id: string): Promise<RelayPlan> {
  const res = await fetch(`/api/plan/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) throw new PlanNotFoundError(await readError(res));
  if (!res.ok) throw new Error(await readError(res));
  return readPlan(res);
}

// add a co-signer's signed envelope; returns the merged envelope
export async function submitSignature(id: string, xdr: string): Promise<RelayPlan> {
  const res = await fetch(`/api/plan/${encodeURIComponent(id)}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr }),
  });
  if (res.status === 404) throw new PlanNotFoundError(await readError(res));
  if (!res.ok) throw new Error(await readError(res));
  return readPlan(res);
}

export interface LiveStatus {
  // "live": the event stream is open. "polling": the stream was refused or
  // dropped, so the plan is fetched on a timer while the stream is retried.
  // "gone": the relay no longer has the request; nothing more will arrive.
  readonly mode: "live" | "polling" | "gone";
  // true only for "gone": updates have stopped for good
  readonly terminal: boolean;
  // the last polling error, or why the request is gone
  readonly error?: string;
}

const POLL_START_MS = 5_000;
const POLL_MAX_MS = 60_000;
// consecutive stream errors with no frame before the stream counts as down.
// EventSource keeps retrying an unreachable server in CONNECTING forever.
const MAX_STREAM_ERRORS = 3;
// how often, while polling, to try the event stream again
const STREAM_RETRY_MS = 60_000;

// follow a plan's envelope. onUpdate gets every new envelope; onStatus reports
// whether updates arrive live, by polling, or not at all. Returns a stop
// function.
export function subscribePlan(
  id: string,
  onUpdate: (plan: RelayPlan) => void,
  onStatus?: (status: LiveStatus) => void,
): () => void {
  const url = `/api/plan/${encodeURIComponent(id)}/events`;
  let stopped = false;
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollDelay = POLL_START_MS;
  let lastStreamAttempt = 0;

  const report = (status: LiveStatus): void => {
    if (!stopped) onStatus?.(status);
  };

  const closeStream = (): void => {
    if (source !== null) {
      source.onopen = null;
      source.onmessage = null;
      source.onerror = null;
      source.close();
      source = null;
    }
  };

  const stopPolling = (): void => {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  };

  const schedulePoll = (): void => {
    if (stopped || pollTimer !== null) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll();
    }, pollDelay);
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const plan = await fetchPlan(id);
      if (stopped) return;
      onUpdate(plan);
      report({ mode: "polling", terminal: false });
      pollDelay = POLL_START_MS;
    } catch (e) {
      if (stopped) return;
      if (e instanceof PlanNotFoundError) {
        report({ mode: "gone", terminal: true, error: e.message });
        stop();
        return;
      }
      report({
        mode: "polling",
        terminal: false,
        error: errorMessage(e),
      });
      pollDelay = Math.min(pollDelay * 2, POLL_MAX_MS);
    }
    if (Date.now() - lastStreamAttempt >= STREAM_RETRY_MS) {
      openStream();
      return;
    }
    schedulePoll();
  };

  const fallBackToPolling = (): void => {
    closeStream();
    report({ mode: "polling", terminal: false });
    schedulePoll();
  };

  function openStream(): void {
    if (stopped) return;
    closeStream();
    lastStreamAttempt = Date.now();
    let errors = 0;
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      errors = 0;
      stopPolling();
      pollDelay = POLL_START_MS;
      report({ mode: "live", terminal: false });
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      errors = 0;
      let plan: RelayPlan | null = null;
      try {
        plan = parseRelayPlan(JSON.parse(ev.data));
      } catch {
        // a frame that isn't JSON carries no plan
        plan = null;
      }
      if (plan !== null) onUpdate(plan);
    };
    es.onerror = () => {
      errors += 1;
      // a refused stream (404, 503) is CLOSED at once; an unreachable server
      // stays CONNECTING, so count failures instead of waiting forever
      if (es.readyState === EventSource.CLOSED || errors >= MAX_STREAM_ERRORS) {
        fallBackToPolling();
      }
    };
  }

  function stop(): void {
    stopped = true;
    stopPolling();
    closeStream();
  }

  openStream();
  return stop;
}
