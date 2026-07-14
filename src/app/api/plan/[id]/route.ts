// Fetch the current envelope for a signing request. Returns { network, xdr }.
// Public data only; a co-signer verifies the transaction hash matches this id.

import { getPlan } from "@/server/signing-relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const plan = getPlan(id);
  if (plan === null) {
    return new Response(
      JSON.stringify({ ok: false, code: "NOT_FOUND", reason: "This signing request no longer exists." }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ ok: true, ...plan }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
