// mediator flow minting (GET) and forward co-signing (POST)

import { StrKey } from "@stellar/stellar-sdk";

import { requireNetwork } from "@/lib/config/networks";
import { decodeMemoCommitment, isMediatorNetworkId } from "@/lib/mediator/forward-terms";
import { validateMediatorForwardEnvelope } from "@/lib/mediator/validator";
import { lookupRefusedDestination } from "@/lib/safety/cex-registry";
import { resolveMediatorFlow, startMediatorFlow } from "@/server/mediator-secret";
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

// node runtime: the flow-key derivation (node:crypto) and the validator pull in
// stellar-sdk / node crypto, which aren't edge-compatible
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// a POST that carries an authentic flow token is limited per flow, everything
// else per client address. junk from an address (or from many) then can't use
// up the budget of a forward whose balance is already sitting in a mediator.
// a forward run makes at most 8 sign calls (4 attempts, each possibly after a
// token renewal), so 10 a minute per flow leaves room for one resume on top.
const signIpLimiter = createLimiter(5, 60_000);
const signFlowLimiter = createLimiter(10, 60_000);
// minting is cheap (an hmac), so it gets a looser bucket of its own
const mintLimiter = createLimiter(30, 60_000);

// test-only: reset every bucket
export function __resetRateLimiterForTests(): void {
  signIpLimiter.reset();
  signFlowLimiter.reset();
  mintLimiter.reset();
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

type ParsedSignBody =
  | {
      readonly ok: true;
      readonly envelopeXdr: string;
      readonly flowToken: string;
      readonly network: string | undefined;
    }
  | { readonly ok: false; readonly response: Response };

async function parseSignBody(
  request: Request,
  cors: Record<string, string>,
): Promise<ParsedSignBody> {
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
  if (typeof rec.envelopeXdr !== "string" || rec.envelopeXdr.length === 0) {
    return {
      ok: false,
      response: badRequest("`envelopeXdr` must be a non-empty base64 string.", cors),
    };
  }
  if (typeof rec.flowToken !== "string" || rec.flowToken.length === 0) {
    return {
      ok: false,
      response: badRequest(
        "`flowToken` must be a non-empty string; call GET to start a flow first.",
        cors,
      ),
    };
  }
  if (rec.network !== undefined && typeof rec.network !== "string") {
    return { ok: false, response: badRequest("`network` must be a string when present.", cors) };
  }
  return { ok: true, envelopeXdr: rec.envelopeXdr, flowToken: rec.flowToken, network: rec.network };
}

// parse the body and authenticate the token first, then rate-limit (per flow
// for an authentic token, per address otherwise), validate the envelope
// against the token's terms, co-sign and return base64 xdr
export async function POST(request: Request): Promise<Response> {
  const cors = buildCorsHeaders(request.headers.get("origin"));
  // anything that can't name an authentic flow is charged to the client address
  const limitByIp = (): Response | null => {
    const limited = rateLimitByIp(signIpLimiter, request);
    return limited === null ? null : withMediatorHeaders(limited, cors);
  };

  const body = await parseSignBody(request, cors);
  if (!body.ok) return limitByIp() ?? body.response;

  // resolve THIS flow's ephemeral keypair and terms from the token. A thrown
  // error means the master seed is unset or malformed: logged for the operator,
  // scrubbed for the client. No token can be authenticated then, so the request
  // is charged to its address first and junk can't flood the log.
  let resolution: ReturnType<typeof resolveMediatorFlow>;
  try {
    resolution = resolveMediatorFlow(body.flowToken);
  } catch (err) {
    const limited = limitByIp();
    if (limited !== null) return limited;
    logMediatorError("POST /api/mediator/sign could not resolve a flow token", err);
    return failure("MEDIATOR_NOT_CONFIGURED", "Mediator is not configured.", 500, cors);
  }
  if (!resolution.ok && resolution.reason !== "expired") {
    return limitByIp() ?? failure("INVALID_FLOW_TOKEN", "Flow token is invalid.", 400, cors);
  }

  const flowId = resolution.ok ? resolution.flow.flowId : resolution.flowId;
  const limited = rateLimitByKey(signFlowLimiter, `flow:${flowId}`);
  if (limited !== null) return withMediatorHeaders(limited, cors);

  if (!resolution.ok) {
    return failure(
      "FLOW_TOKEN_EXPIRED",
      "Flow token has expired; renew it at /api/mediator/reissue and retry.",
      400,
      cors,
    );
  }
  const flow = resolution.flow;

  // the network is part of the token. A client that names one this build does
  // not serve, or a different one, built its envelope for another network, so
  // refuse instead of signing for one it did not mean.
  if (body.network !== undefined && !isMediatorNetworkId(body.network)) {
    return failure(
      "INVALID_NETWORK",
      `Exchange forwards run on mainnet or testnet, not "${body.network}".`,
      400,
      cors,
    );
  }
  if (body.network !== undefined && body.network !== flow.networkId) {
    return failure(
      "NETWORK_MISMATCH",
      `This flow is bound to ${flow.networkId}, not ${body.network}.`,
      400,
      cors,
    );
  }

  const result = validateMediatorForwardEnvelope(
    body.envelopeXdr,
    requireNetwork(flow.networkId).passphrase,
    flow.keypair.publicKey(),
    { destination: flow.destination, memoXdr: flow.memoXdr },
  );
  if (!result.ok) return failure(result.code, result.reason, 400, cors);

  try {
    const tx = result.tx;
    tx.sign(flow.keypair);
    return jsonResponse({ ok: true, signedXdr: tx.toEnvelope().toXdr("base64") }, 200, cors);
  } catch (err) {
    logMediatorError("POST /api/mediator/sign failed to sign a validated forward", err);
    return failure("SIGNING_FAILED", "Failed to sign envelope.", 500, cors);
  }
}

// starts a fresh mediator flow: a flow token bound to the destination, network
// and deposit memo, and the ephemeral public key the close funds and merges
// into. The token is echoed back at POST time to unlock signing for this flow's
// key only, and only for a forward that meets those terms. It can be used more
// than once (a failed forward is retried with it) until it expires.
export function GET(request: Request): Response {
  const cors = buildCorsHeaders(request.headers.get("origin"));
  const limited = rateLimitByIp(mintLimiter, request);
  if (limited !== null) return withMediatorHeaders(limited, cors);

  const params = new URL(request.url).searchParams;
  const destination = params.get("destination");
  if (destination === null || !StrKey.isValidEd25519PublicKey(destination)) {
    return failure(
      "INVALID_DESTINATION",
      "A valid `destination` (G...) query parameter is required to start a flow.",
      400,
      cors,
    );
  }
  // a merge into an exchange's cold or withdrawal wallet is credited to no
  // customer, so no flow is ever started toward one
  const refused = lookupRefusedDestination(destination);
  if (refused !== null) {
    return failure(
      "REFUSED_DESTINATION",
      `${destination} is ${refused.name}, an exchange internal wallet and not a deposit address. ` +
        "Use the deposit address and memo your exchange account shows you.",
      400,
      cors,
    );
  }
  const networkId = params.get("network");
  if (!isMediatorNetworkId(networkId)) {
    return failure(
      "INVALID_NETWORK",
      "A `network` query parameter of mainnet or testnet is required to start a flow.",
      400,
      cors,
    );
  }
  // the deposit memo, as base64 xdr of one Stellar memo (MemoNone for none). It
  // is required so a client can never start a flow that silently commits to no
  // memo for a destination that needs one.
  const memoXdr = params.get("memo");
  if (memoXdr === null || decodeMemoCommitment(memoXdr) === null) {
    return failure(
      "INVALID_MEMO",
      "A `memo` query parameter with the base64 xdr of the deposit memo (or of MemoNone) is required.",
      400,
      cors,
    );
  }

  try {
    const flow = startMediatorFlow({ destination, networkId, memoXdr });
    return jsonResponse(
      {
        ok: true,
        flowToken: flow.flowToken,
        mediatorPublicKey: flow.mediatorPublicKey,
        expiresAt: flow.expiresAt,
      },
      200,
      cors,
    );
  } catch (err) {
    logMediatorError("GET /api/mediator/sign could not mint a flow", err);
    return failure("MEDIATOR_NOT_CONFIGURED", "Mediator is not configured.", 500, cors);
  }
}

const notAllowed = methodNotAllowed("GET, POST, OPTIONS");

export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const HEAD = notAllowed;
