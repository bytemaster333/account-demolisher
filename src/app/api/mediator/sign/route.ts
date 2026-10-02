// mediator flow minting (GET) and forward co-signing (POST)

import { StrKey } from "@stellar/stellar-sdk";

import { resolveNetwork } from "@/lib/config/networks";
import { decodeMemoCommitment, isMediatorNetworkId } from "@/lib/mediator/forward-terms";
import { validateMediatorForwardEnvelope } from "@/lib/mediator/validator";
import { resolveMediatorFlow, startMediatorFlow } from "@/server/mediator-secret";
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

// node runtime: the flow-key derivation (node:crypto) and the validator pull in
// stellar-sdk / node crypto, which aren't edge-compatible
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// co-signing: 5 requests per 60s per IP. minting is cheap (an hmac), so it gets
// a looser bucket of its own. The shared limiter is bounded (evicts idle keys)
// and keys on TRUSTED_PROXY_HOPS-aware getRemoteIp, so a forged-XFF flood can't
// exhaust memory or mint fresh buckets per request.
const signLimiter = createLimiter(5, 60_000);
const mintLimiter = createLimiter(30, 60_000);

// test-only: reset the per-IP buckets
export function __resetRateLimiterForTests(): void {
  signLimiter.reset();
  mintLimiter.reset();
}

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

// rate-limit, parse body, validate the envelope against the token's terms, then
// co-sign and return base64 xdr
export async function POST(request: Request): Promise<Response> {
  const cors = buildCorsHeaders(request.headers.get("origin"));
  if (!signLimiter.take(getRemoteIp(request))) return rateLimited(cors);

  let envelopeXdr: string;
  let flowToken: string;
  let requestedNetwork: string | undefined;
  try {
    const raw = (await readJsonCapped(request, MAX_JSON_BODY_BYTES)) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return badRequest("Request body must be a JSON object.", cors);
    }
    const rec = raw as Record<string, unknown>;
    if (typeof rec.envelopeXdr !== "string" || rec.envelopeXdr.length === 0) {
      return badRequest("`envelopeXdr` must be a non-empty base64 string.", cors);
    }
    if (typeof rec.flowToken !== "string" || rec.flowToken.length === 0) {
      return badRequest(
        "`flowToken` must be a non-empty string; call GET to start a flow first.",
        cors,
      );
    }
    if (rec.network !== undefined && typeof rec.network !== "string") {
      return badRequest("`network` must be a string when present.", cors);
    }
    envelopeXdr = rec.envelopeXdr;
    flowToken = rec.flowToken;
    requestedNetwork = rec.network;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return bodyTooLarge(cors);
    return badRequest("Request body is not valid JSON.", cors);
  }

  // resolve THIS flow's ephemeral keypair and terms from the token. A thrown
  // error means the master seed is unset or malformed: logged for the operator,
  // scrubbed for the client.
  let resolution: ReturnType<typeof resolveMediatorFlow>;
  try {
    resolution = resolveMediatorFlow(flowToken);
  } catch (err) {
    logMediatorError("POST /api/mediator/sign could not resolve a flow token", err);
    return failure("MEDIATOR_NOT_CONFIGURED", "Mediator is not configured.", 500, cors);
  }
  if (!resolution.ok) {
    if (resolution.reason === "expired") {
      return failure(
        "FLOW_TOKEN_EXPIRED",
        "Flow token has expired; renew it at /api/mediator/reissue and retry.",
        400,
        cors,
      );
    }
    return failure("INVALID_FLOW_TOKEN", "Flow token is invalid.", 400, cors);
  }
  const flow = resolution.flow;

  // the network is part of the token. A client that says otherwise built its
  // envelope for a different network, so refuse instead of signing for one it
  // did not mean.
  if (requestedNetwork !== undefined && requestedNetwork !== flow.networkId) {
    return failure(
      "NETWORK_MISMATCH",
      `This flow is bound to ${flow.networkId}, not ${requestedNetwork}.`,
      400,
      cors,
    );
  }

  const result = validateMediatorForwardEnvelope(
    envelopeXdr,
    resolveNetwork(flow.networkId).passphrase,
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
  if (!mintLimiter.take(getRemoteIp(request))) return rateLimited(cors);

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
