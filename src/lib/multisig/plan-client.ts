// Browser client for the signing-request relay (/api/plan). Publishes a close
// transaction, fetches it, submits a signature, and subscribes to live updates
// over Server-Sent Events. Only transaction envelopes cross the wire, never a
// secret key.

import type { StellarNetwork } from "@/lib/config/networks";

export interface RelayPlan {
  readonly network: StellarNetwork;
  readonly xdr: string;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: string };
    if (typeof body.reason === "string" && body.reason.length > 0) return body.reason;
  } catch {
    // fall through to a generic message
  }
  return `Request failed (${res.status}).`;
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
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as Partial<RelayPlan>;
  if (typeof body.network !== "string" || typeof body.xdr !== "string") {
    throw new Error("The server returned an unexpected response.");
  }
  return { network: body.network, xdr: body.xdr };
}

// add a co-signer's signed envelope; returns the merged envelope
export async function submitSignature(id: string, xdr: string): Promise<RelayPlan> {
  const res = await fetch(`/api/plan/${encodeURIComponent(id)}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as Partial<RelayPlan>;
  if (typeof body.network !== "string" || typeof body.xdr !== "string") {
    throw new Error("The server returned an unexpected response.");
  }
  return { network: body.network, xdr: body.xdr };
}

// subscribe to live envelope updates; calls onUpdate with each new envelope and
// onError on connection failure. Returns an unsubscribe function.
//
// EventSource auto-reconnects on transient drops (readyState stays CONNECTING),
// so those are recoverable and self-heal. A CLOSED readyState is terminal: the
// stream will not come back on its own (e.g. the relay swept the plan and the
// events endpoint now 404s, or the server restarted). onError reports which case
// it is so a caller can show a 'reconnecting' hint versus a 'refresh to resync'
// affordance instead of a silently frozen progress view.
export function subscribePlan(
  id: string,
  onUpdate: (plan: RelayPlan) => void,
  onError?: (info: { readonly terminal: boolean }) => void,
): () => void {
  const source = new EventSource(`/api/plan/${encodeURIComponent(id)}/events`);
  source.onmessage = (ev: MessageEvent<string>) => {
    try {
      const plan = JSON.parse(ev.data) as Partial<RelayPlan>;
      if (typeof plan.network === "string" && typeof plan.xdr === "string") {
        onUpdate({ network: plan.network, xdr: plan.xdr });
      }
    } catch {
      // ignore malformed frames
    }
  };
  source.onerror = () => {
    if (onError) onError({ terminal: source.readyState === EventSource.CLOSED });
  };
  return () => source.close();
}
