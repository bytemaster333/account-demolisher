// publish a multisig close transaction for co-signing. body: { network, xdr }.
// returns { id } (the transaction hash). no secret material is accepted or stored.

import { createLimiter, rateLimitByIp } from "@/server/rate-limit";
import { readJsonCapped, MAX_PLAN_BODY_BYTES, BodyTooLargeError } from "@/server/read-body";
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
  const limited = rateLimitByIp(limiter, request);
  if (limited !== null) return limited;

  let network: string;
  let xdr: string;
  try {
    const raw = (await readJsonCapped(request, MAX_PLAN_BODY_BYTES)) as unknown;
    if (typeof raw !== "object" || raw === null)
      return json({ ok: false, reason: "Bad body." }, 400);
    const rec = raw as Record<string, unknown>;
    if (typeof rec.network !== "string" || typeof rec.xdr !== "string") {
      return json({ ok: false, reason: "`network` and `xdr` are required." }, 400);
    }
    network = rec.network;
    xdr = rec.xdr;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return json({ ok: false, reason: "Body too large." }, 413);
    return json({ ok: false, reason: "Body is not valid JSON." }, 400);
  }

  const result = await createPlan(network, xdr);
  if (!result.ok) {
    const status = result.code === "CAPACITY" ? 503 : 400;
    return json({ ok: false, code: result.code, reason: result.reason }, status);
  }
  return json({ ok: true, id: result.id }, 200);
}
