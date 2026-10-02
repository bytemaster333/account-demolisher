// Fetch the current envelope for a signing request. Returns { network, xdr }.
// Public data only; a co-signer verifies the transaction hash matches this id.

import { createLimiter, rateLimitByIp } from "@/server/rate-limit";
import { getPlan } from "@/server/signing-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// generous cap (co-signers + the initiator poll/verify), but bounded so the read
// endpoint can't be hammered like its unlimited siblings could not.
const limiter = createLimiter(60, 60_000);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const limited = rateLimitByIp(limiter, request);
  if (limited !== null) return limited;
  const { id } = await params;
  const plan = getPlan(id);
  if (plan === null) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: "NOT_FOUND",
        reason: "This signing request no longer exists.",
      }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ ok: true, ...plan }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
