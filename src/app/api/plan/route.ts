// Publish a multisig close transaction for co-signing. Body: { network, xdr }.
// Returns { id } (the transaction hash). No secret material is accepted or stored.

import { createLimiter, getRemoteIp } from "@/server/rate-limit";
import { createPlan } from "@/server/signing-relay";

// node runtime: stellar-sdk decoding + Horizon lookup aren't edge-compatible
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createLimiter(10, 60_000);

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!limiter.take(getRemoteIp(request))) {
    return json({ ok: false, code: "RATE_LIMITED", reason: "Too many requests." }, 429);
  }

  let network: string;
  let xdr: string;
  try {
    const raw = (await request.json()) as unknown;
    if (typeof raw !== "object" || raw === null) return json({ ok: false, reason: "Bad body." }, 400);
    const rec = raw as Record<string, unknown>;
    if (typeof rec.network !== "string" || typeof rec.xdr !== "string") {
      return json({ ok: false, reason: "`network` and `xdr` are required." }, 400);
    }
    network = rec.network;
    xdr = rec.xdr;
  } catch {
    return json({ ok: false, reason: "Body is not valid JSON." }, 400);
  }

  const result = await createPlan(network, xdr);
  if (!result.ok) return json({ ok: false, code: result.code, reason: result.reason }, 400);
  return json({ ok: true, id: result.id }, 200);
}
