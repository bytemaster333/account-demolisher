// browser-side helper for the mediator co-signing endpoint. safe to import
// from a client component; no server-only deps

export type MediatorSignatureResult =
  | { ok: true; signedXdr: string }
  | { ok: false; code: string; reason: string };

export type MediatorFlowResult =
  | { ok: true; flowToken: string; mediatorPublicKey: string }
  | { ok: false; code: string; reason: string };

export interface MediatorEndpointOptions {
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
}

const DEFAULT_ENDPOINT = "/api/mediator/sign";

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

// GET the endpoint to start a flow: returns a one-time flow token plus the
// ephemeral mediator public key the plan should fund and merge into. Each call
// mints a fresh, independent flow.
export async function startMediatorFlow(
  // the destination is committed into the flow token so the sign route can bind
  // the co-signed forward to it (SEC-16)
  destination: string,
  options: MediatorEndpointOptions = {},
): Promise<MediatorFlowResult> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const url = `${endpoint}?destination=${encodeURIComponent(destination)}`;

  let response: Response;
  try {
    const init: RequestInit = { method: "GET", headers: { accept: "application/json" } };
    if (options.signal !== undefined) init.signal = options.signal;
    response = await fetch(url, init);
  } catch (err) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: err instanceof Error ? err.message : "Failed to reach mediator endpoint.",
    };
  }

  const body = await readJson(response);
  if (body === null) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: "Mediator returned an unexpected response.",
    };
  }
  if (typeof body.flowToken === "string" && typeof body.mediatorPublicKey === "string") {
    return { ok: true, flowToken: body.flowToken, mediatorPublicKey: body.mediatorPublicKey };
  }
  if (typeof body.code === "string" && typeof body.reason === "string") {
    return { ok: false, code: body.code, reason: body.reason };
  }
  return {
    ok: false,
    code: "NETWORK_ERROR",
    reason: `Mediator returned an unexpected status ${response.status}.`,
  };
}

// posts the unsigned envelope + this flow's token to the route and returns the
// typed result. network errors surface as { ok: false, code: "NETWORK_ERROR" }.
export async function requestMediatorSignature(
  envelopeXdr: string,
  flowToken: string,
  // the network the envelope was built on ("mainnet" | "testnet" | "futurenet").
  // A single deployment serves both networks, so the route must validate/co-sign
  // against the passphrase the client actually used, not a build-time default.
  network: string,
  options: MediatorEndpointOptions = {},
): Promise<MediatorSignatureResult> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelopeXdr, flowToken, network }),
    };
    if (options.signal !== undefined) init.signal = options.signal;
    response = await fetch(endpoint, init);
  } catch (err) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: err instanceof Error ? err.message : "Failed to reach mediator endpoint.",
    };
  }

  const body = await readJson(response);
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
    return { ok: false, code: body.code, reason: body.reason };
  }
  return {
    ok: false,
    code: "NETWORK_ERROR",
    reason: `Mediator returned an unexpected status ${response.status}.`,
  };
}
