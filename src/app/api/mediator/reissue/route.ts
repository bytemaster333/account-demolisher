// renews a mediator flow token for a mediator that already exists on chain, so
// an interrupted forward can be finished after the token's 15 minutes are up

import { NotFoundError } from "@stellar/stellar-sdk";

import { requireNetwork } from "@/lib/config/networks";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { reissueMediatorFlow } from "@/server/mediator-secret";
import { createLimiter, rateLimitByIp, rateLimitByKey } from "@/server/rate-limit";
import { readJsonCapped, MAX_JSON_BODY_BYTES, BodyTooLargeError } from "@/server/read-body";

import {
  badRequest,
  bodyTooLarge,
  buildCorsHeaders,
  failure,
  jsonResponse,
  logMediatorError,
  methodNotAllowed,
  preflight,
  withMediatorHeaders,
} from "../_shared/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// each call costs a horizon lookup. authentic tokens are limited per flow and
// everything else per address, as on the sign route, so junk can't stop a
// stranded forward from being renewed.
const ipLimiter = createLimiter(5, 60_000);
const flowLimiter = createLimiter(5, 60_000);

// test-only: reset every bucket
export function __resetRateLimiterForTests(): void {
  ipLimiter.reset();
  flowLimiter.reset();
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

async function readFlowToken(
  request: Request,
  cors: Record<string, string>,
): Promise<{ ok: true; flowToken: string } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await readJsonCapped(request, MAX_JSON_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return { ok: false, response: bodyTooLarge(cors) };
    return { ok: false, response: badRequest("Request body is not valid JSON.", cors) };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, response: badRequest("Request body must be a JSON object.", cors) };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.flowToken !== "string" || rec.flowToken.length === 0) {
    return { ok: false, response: badRequest("`flowToken` must be a non-empty string.", cors) };
  }
  return { ok: true, flowToken: rec.flowToken };
}

// body: { flowToken }. an authentic token (expired or not) is renewed for the
// same nonce, so the same mediator, with the same destination, network and
// memo. renewal never widens what the token allows; the mediator must exist so
// tokens for flows that never got funded are not kept alive for nothing.
export async function POST(request: Request): Promise<Response> {
  const cors = buildCorsHeaders(request.headers.get("origin"));
  const limitByIp = (): Response | null => {
    const limited = rateLimitByIp(ipLimiter, request);
    return limited === null ? null : withMediatorHeaders(limited, cors);
  };

  const body = await readFlowToken(request, cors);
  if (!body.ok) return limitByIp() ?? body.response;

  let reissue: ReturnType<typeof reissueMediatorFlow>;
  try {
    reissue = reissueMediatorFlow(body.flowToken);
  } catch (err) {
    // no token can be authenticated without the secret; charge the address
    // before logging so junk can't flood the log
    const limited = limitByIp();
    if (limited !== null) return limited;
    logMediatorError("POST /api/mediator/reissue could not verify a flow token", err);
    return failure("MEDIATOR_NOT_CONFIGURED", "Mediator is not configured.", 500, cors);
  }
  if (!reissue.ok) {
    return limitByIp() ?? failure("INVALID_FLOW_TOKEN", "Flow token is invalid.", 400, cors);
  }
  const limited = rateLimitByKey(flowLimiter, `flow:${reissue.flowId}`);
  if (limited !== null) return withMediatorHeaders(limited, cors);

  const horizon = getHorizon(requireNetwork(reissue.terms.networkId));
  try {
    await horizon.loadAccount(reissue.flow.mediatorPublicKey);
  } catch (err) {
    if (err instanceof NotFoundError) {
      return failure(
        "MEDIATOR_NOT_FOUND",
        "The mediator account for this flow does not exist on chain, so there is nothing to forward.",
        404,
        cors,
      );
    }
    logMediatorError("POST /api/mediator/reissue could not load the mediator account", err);
    return failure(
      "HORIZON_UNAVAILABLE",
      "Could not check the mediator account on Horizon; try again shortly.",
      502,
      cors,
    );
  }

  return jsonResponse(
    {
      ok: true,
      flowToken: reissue.flow.flowToken,
      mediatorPublicKey: reissue.flow.mediatorPublicKey,
      expiresAt: reissue.flow.expiresAt,
    },
    200,
    cors,
  );
}

const notAllowed = methodNotAllowed("POST, OPTIONS");

export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const HEAD = notAllowed;
