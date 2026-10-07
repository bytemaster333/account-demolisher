// browser-side helper for the mediator endpoints. safe to import from a client
// component; no server-only deps

import { StrKey } from "@stellar/stellar-sdk";

import { errorMessage } from "@/lib/errors";
import {
  encodeMemoCommitment,
  forwardMemoToSdk,
  isMediatorNetworkId,
} from "@/lib/mediator/forward-terms";
import type { ClassicMemo } from "@/lib/types/plan";

export interface MediatorFailure {
  ok: false;
  code: string;
  reason: string;
  // set on a 429 when the server said how long to wait
  retryAfterSeconds?: number;
}

export type MediatorSignatureResult = { ok: true; signedXdr: string } | MediatorFailure;

export type MediatorFlowResult =
  { ok: true; flowToken: string; mediatorPublicKey: string; expiresAt: number } | MediatorFailure;

export interface MediatorEndpointOptions {
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
}

// what the forward out of the new mediator will have to look like. both are
// committed into the flow token, so they must be the exact values the forward
// is later built with.
export interface MediatorFlowTerms {
  // "mainnet" | "testnet"
  readonly network: string;
  // the exchange deposit memo; null when the destination takes none
  readonly memo: ClassicMemo | null;
}

const SIGN_ENDPOINT = "/api/mediator/sign";
const REISSUE_ENDPOINT = "/api/mediator/reissue";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

async function send(url: string, init: RequestInit, signal?: AbortSignal) {
  try {
    const response = await fetch(url, signal === undefined ? init : { ...init, signal });
    return { response, body: await readJson(response) } as const;
  } catch (err) {
    return {
      error: errorMessage(err, "Failed to reach mediator endpoint."),
    } as const;
  }
}

function toFlowResult(
  response: Response,
  body: Record<string, unknown> | null,
): MediatorFlowResult {
  if (body === null) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: "Mediator returned an unexpected response.",
    };
  }
  if (
    body.ok === true &&
    typeof body.flowToken === "string" &&
    typeof body.mediatorPublicKey === "string" &&
    typeof body.expiresAt === "number"
  ) {
    if (!StrKey.isValidEd25519PublicKey(body.mediatorPublicKey)) {
      return {
        ok: false,
        code: "INVALID_MEDIATOR",
        reason: "Mediator returned a malformed mediator public key.",
      };
    }
    return {
      ok: true,
      flowToken: body.flowToken,
      mediatorPublicKey: body.mediatorPublicKey,
      expiresAt: body.expiresAt,
    };
  }
  if (typeof body.code === "string" && typeof body.reason === "string") {
    return serverFailure(response, body.code, body.reason);
  }
  return {
    ok: false,
    code: "NETWORK_ERROR",
    reason: `Mediator returned an unexpected status ${String(response.status)}.`,
  };
}

// the routes send retry-after as whole seconds
function retryAfterSeconds(response: Response): number | null {
  if (response.status !== 429) return null;
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d{1,6}$/u.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

function serverFailure(response: Response, code: string, reason: string): MediatorFailure {
  const wait = retryAfterSeconds(response);
  return wait === null
    ? { ok: false, code, reason }
    : { ok: false, code, reason, retryAfterSeconds: wait };
}

// token layout: v2.nonce.expiry.network.destination.memo.mac. the client can't
// check the mac, but it can catch a server or cache answering for other terms.
function tokenCommitsTo(
  flowToken: string,
  network: string,
  destination: string,
  memoXdr: string,
): boolean {
  const parts = flowToken.split(".");
  return (
    parts.length === 7 && parts[3] === network && parts[4] === destination && parts[5] === memoXdr
  );
}

// GET the endpoint to start a flow: returns a flow token plus the ephemeral
// mediator public key the plan should fund and merge into. each call mints a
// fresh, independent flow bound to `destination` and `terms`. an exchange
// credits by memo, so the terms are required: a caller has to state the memo
// (or null for none) and the network.
export async function startMediatorFlow(
  destination: string,
  terms: MediatorFlowTerms,
  options: MediatorEndpointOptions = {},
): Promise<MediatorFlowResult> {
  if (!isMediatorNetworkId(terms.network)) {
    return {
      ok: false,
      code: "INVALID_NETWORK",
      reason: `Exchange forwards run on mainnet or testnet, not "${terms.network}".`,
    };
  }
  let memoXdr: string;
  try {
    memoXdr = encodeMemoCommitment(forwardMemoToSdk(terms.memo ?? undefined));
  } catch (err) {
    return {
      ok: false,
      code: "INVALID_MEMO",
      reason: errorMessage(err, "The deposit memo is malformed."),
    };
  }

  const params = new URLSearchParams({ destination, network: terms.network, memo: memoXdr });
  const res = await send(
    `${options.endpoint ?? SIGN_ENDPOINT}?${params.toString()}`,
    { method: "GET", headers: { accept: "application/json" }, cache: "no-store" },
    options.signal,
  );
  if ("error" in res) return { ok: false, code: "NETWORK_ERROR", reason: res.error };
  const result = toFlowResult(res.response, res.body);
  if (result.ok && !tokenCommitsTo(result.flowToken, terms.network, destination, memoXdr)) {
    return {
      ok: false,
      code: "FLOW_TERMS_MISMATCH",
      reason: "Mediator returned a flow token for a different destination, network or memo.",
    };
  }
  return result;
}

// renew a flow token that expired (or is about to) for the same mediator,
// destination, network and memo. the server only renews tokens it issued, and
// only while the mediator account exists.
export async function reissueMediatorFlow(
  flowToken: string,
  options: MediatorEndpointOptions = {},
): Promise<MediatorFlowResult> {
  const res = await send(
    options.endpoint ?? REISSUE_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flowToken }),
      cache: "no-store",
    },
    options.signal,
  );
  if ("error" in res) return { ok: false, code: "NETWORK_ERROR", reason: res.error };
  return toFlowResult(res.response, res.body);
}

// posts the unsigned envelope + this flow's token to the route and returns the
// typed result. network errors surface as { ok: false, code: "NETWORK_ERROR" }.
export async function requestMediatorSignature(
  envelopeXdr: string,
  flowToken: string,
  // the network the envelope was built on. the token is bound to one network
  // and the route refuses to sign when this disagrees with it.
  network: string,
  options: MediatorEndpointOptions = {},
): Promise<MediatorSignatureResult> {
  const res = await send(
    options.endpoint ?? SIGN_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelopeXdr, flowToken, network }),
      cache: "no-store",
    },
    options.signal,
  );
  if ("error" in res) return { ok: false, code: "NETWORK_ERROR", reason: res.error };
  const { response, body } = res;
  if (body === null) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: "Mediator returned an unexpected response.",
    };
  }
  if (body.ok === true && typeof body.signedXdr === "string") {
    return { ok: true, signedXdr: body.signedXdr };
  }
  if (body.ok === false && typeof body.code === "string" && typeof body.reason === "string") {
    return serverFailure(response, body.code, body.reason);
  }
  return {
    ok: false,
    code: "NETWORK_ERROR",
    reason: `Mediator returned an unexpected status ${String(response.status)}.`,
  };
}
