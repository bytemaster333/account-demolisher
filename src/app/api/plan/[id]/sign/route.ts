// Add a co-signer's signature to a signing request. Body: { xdr } (the co-signer's
// signed envelope). The relay keeps only signatures that are over THIS exact
// transaction and come from an authorized signer; everything else is rejected.

import { createLimiter, getRemoteIp } from "@/server/rate-limit";
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
  if (!limiter.take(getRemoteIp(request))) {
    return json({ ok: false, code: "RATE_LIMITED", reason: "Too many requests." }, 429);
  }

  const { id } = await params;

  let xdr: string;
  try {
    const raw = (await request.json()) as unknown;
    if (typeof raw !== "object" || raw === null)
      return json({ ok: false, reason: "Bad body." }, 400);
    const rec = raw as Record<string, unknown>;
    if (typeof rec.xdr !== "string") return json({ ok: false, reason: "`xdr` is required." }, 400);
    xdr = rec.xdr;
  } catch {
    return json({ ok: false, reason: "Body is not valid JSON." }, 400);
  }

  const result = addSignature(id, xdr);
  if (!result.ok) {
    const status = result.code === "NOT_FOUND" ? 404 : 400;
    return json({ ok: false, code: result.code, reason: result.reason }, status);
  }
  return json({ ok: true, ...result.plan }, 200);
}
