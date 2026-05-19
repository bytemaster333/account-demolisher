// browser-side helper for the mediator co-signing endpoint. safe to import
// from a client component; no server-only deps.

export type MediatorSignatureResult =
  | { ok: true; signedXdr: string }
  | { ok: false; code: string; reason: string };

// which validator the route runs against the envelope.
//   "merge"   - user-side accountMerge to mediator + payment.
//   "forward" - mediator-side payment to destination + accountMerge to fallback.
export type MediatorEnvelopeKind = "merge" | "forward";

export interface RequestMediatorSignatureOptions {
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
  readonly kind?: MediatorEnvelopeKind;
}

const DEFAULT_ENDPOINT = "/api/mediator/sign";

// posts the unsigned envelope to the route and returns the typed result.
// network errors surface as { ok: false, code: "NETWORK_ERROR", ... }.
export async function requestMediatorSignature(
  envelopeXdr: string,
  options: RequestMediatorSignatureOptions = {},
): Promise<MediatorSignatureResult> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  let response: Response;
  try {
    const body: Record<string, unknown> = { envelopeXdr };
    if (options.kind !== undefined) body.kind = options.kind;
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }
    response = await fetch(endpoint, init);
  } catch (err) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: err instanceof Error ? err.message : "Failed to reach mediator endpoint.",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason:
        err instanceof Error
          ? `Malformed mediator response: ${err.message}`
          : "Mediator returned a non-JSON response.",
    };
  }

  if (!isRecord(body)) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      reason: "Mediator returned an unexpected response shape.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
