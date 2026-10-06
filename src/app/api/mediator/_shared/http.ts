// response helpers shared by the mediator routes. the folder is private (leading
// underscore), so next never routes it.

const ALLOWED_METHODS = "GET, POST, OPTIONS";

// local dev origins; the project itself runs on 3002
const DEV_ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
]);

export type HeaderMap = Record<string, string>;

// CORS headers for an allow-listed origin. in production only origins listed in
// MEDIATOR_ALLOWED_ORIGIN (csv) get them; unset means same-origin only.
export function buildCorsHeaders(origin: string | null): HeaderMap {
  if (origin === null) return {};

  let allowed: Set<string>;
  if (process.env.NODE_ENV === "production") {
    const raw = process.env.MEDIATOR_ALLOWED_ORIGIN;
    if (typeof raw !== "string" || raw.trim().length === 0) return {};
    allowed = new Set(
      raw
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    );
  } else {
    allowed = DEV_ALLOWED_ORIGINS;
  }

  if (!allowed.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

// every mediator response carries a bearer token or a signature for one flow, so
// nothing on the way may cache it. two users closing to the same exchange send
// the same GET url, and a cached mint would hand both of them one mediator.
export function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  extra: HeaderMap = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export function preflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", ...buildCorsHeaders(request.headers.get("origin")) },
  });
}

export function failure(
  code: string,
  reason: string,
  status: number,
  cors: HeaderMap,
  extra: HeaderMap = {},
): Response {
  return jsonResponse({ ok: false, code, reason }, status, { ...cors, ...extra });
}

export function badRequest(reason: string, cors: HeaderMap): Response {
  return failure("BAD_REQUEST", reason, 400, cors);
}

export function bodyTooLarge(cors: HeaderMap): Response {
  return failure("BODY_TOO_LARGE", "Request body is too large.", 413, cors);
}

export function rateLimited(cors: HeaderMap): Response {
  return failure("RATE_LIMITED", "Too many requests; try again shortly.", 429, cors, {
    "retry-after": "60",
  });
}

// handler for the methods a route does not serve
export function methodNotAllowed(allowed: string): () => Response {
  return () =>
    jsonResponse(
      { ok: false, code: "METHOD_NOT_ALLOWED", reason: `Only ${allowed} are supported.` },
      405,
      { allow: allowed },
    );
}

// a stellar secret seed is S + 55 base32 chars; never let one reach a log line
const SEED_PATTERN = /S[A-Z2-7]{55}/gu;

// operators get the reason on the server log, the client only a generic code
export function logMediatorError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[mediator] ${context}: ${message.replace(SEED_PATTERN, "[redacted seed]")}`);
}
