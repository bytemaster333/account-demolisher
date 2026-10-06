// add a co-signer's signature to a signing request. body: { xdr } (the co-signer's
// signed envelope). the relay keeps only signatures that are over THIS exact
// transaction and come from an authorized signer; everything else is rejected.

import { createLimiter, rateLimitByIp } from "@/server/rate-limit";
import { readJsonCapped, MAX_PLAN_BODY_BYTES, BodyTooLargeError } from "@/server/read-body";
import { addSignature } from "@/server/signing-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createLimiter(30, 60_000);

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const limited = rateLimitByIp(limiter, request);
  if (limited !== null) return limited;

  const { id } = await params;

  let xdr: string;
  try {
    const raw = (await readJsonCapped(request, MAX_PLAN_BODY_BYTES)) as unknown;
    if (typeof raw !== "object" || raw === null)
      return json({ ok: false, reason: "Bad body." }, 400);
    const rec = raw as Record<string, unknown>;
    if (typeof rec.xdr !== "string") return json({ ok: false, reason: "`xdr` is required." }, 400);
    xdr = rec.xdr;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return json({ ok: false, reason: "Body too large." }, 413);
    return json({ ok: false, reason: "Body is not valid JSON." }, 400);
  }

  const result = addSignature(id, xdr);
  if (!result.ok) {
    const status = result.code === "NOT_FOUND" ? 404 : 400;
    return json({ ok: false, code: result.code, reason: result.reason }, status);
  }
  return json({ ok: true, ...result.plan }, 200);
}
