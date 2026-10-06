// renews a mediator flow token for a mediator that already exists on chain, so
// an interrupted forward can be finished after the token's 15 minutes are up

import { Horizon, NotFoundError } from "@stellar/stellar-sdk";

import { resolveNetwork } from "@/lib/config/networks";
import { reissueMediatorFlow } from "@/server/mediator-secret";
import { createLimiter, getRemoteIp } from "@/server/rate-limit";
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
  rateLimited,
} from "../_shared/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// each call costs a horizon lookup, so keep it as tight as co-signing
const limiter = createLimiter(5, 60_000);

// test-only: reset the per-IP buckets
export function __resetRateLimiterForTests(): void {
  limiter.reset();
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

// body: { flowToken }. An authentic token (expired or not) is renewed for the
// same nonce, so the same mediator, with the same destination, network and
// memo. Renewal never widens what the token allows; the mediator must exist so
// tokens for flows that never got funded are not kept alive for nothing.
export async function POST(request: Request): Promise<Response> {
  const cors = buildCorsHeaders(request.headers.get("origin"));
  if (!limiter.take(getRemoteIp(request))) return rateLimited(cors);

  let flowToken: string;
  try {
    const raw = (await readJsonCapped(request, MAX_JSON_BODY_BYTES)) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return badRequest("Request body must be a JSON object.", cors);
    }
    const rec = raw as Record<string, unknown>;
    if (typeof rec.flowToken !== "string" || rec.flowToken.length === 0) {
      return badRequest("`flowToken` must be a non-empty string.", cors);
    }
    flowToken = rec.flowToken;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return bodyTooLarge(cors);
    return badRequest("Request body is not valid JSON.", cors);
  }

  let reissue: ReturnType<typeof reissueMediatorFlow>;
  try {
    reissue = reissueMediatorFlow(flowToken);
  } catch (err) {
    logMediatorError("POST /api/mediator/reissue could not verify a flow token", err);
    return failure("MEDIATOR_NOT_CONFIGURED", "Mediator is not configured.", 500, cors);
  }
  if (!reissue.ok) return failure("INVALID_FLOW_TOKEN", "Flow token is invalid.", 400, cors);

  const horizon = new Horizon.Server(resolveNetwork(reissue.terms.networkId).horizon);
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
