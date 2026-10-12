// read a request body with a hard byte cap. route handlers have no default body
// size limit, so a plain request.json() buffers and parses whatever arrives. this
// rejects early on the declared Content-Length and enforces the cap while
// streaming, in case that header is absent or lying.
//
// the early reject only helps because /api is excluded from the proxy.ts
// matcher: a request that passes through the node proxy has its whole body
// buffered by next before the route runs. the outer bound is the shipped caddy
// proxy, which refuses a body over 64 KB on every path (Caddyfile request_body).

// ceiling for the small JSON routes (/api/mediator/sign and /api/mediator/reissue)
export const MAX_JSON_BODY_BYTES = 16_384;

// ceiling for the signing-request routes. the largest legitimate payload is a
// fully signed bundle: 100 operations plus 20 signatures is about 20,100 base64
// characters for the worst case (credit/credit offer cancels), plus small JSON
// fields. see MAX_XDR_CHARS in signing-relay.ts.
export const MAX_PLAN_BODY_BYTES = 32_768;

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readTextCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number.parseInt(declared, 10);
    if (Number.isFinite(n) && n > maxBytes) throw new BodyTooLargeError(maxBytes);
  }

  const body = request.body;
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
        text += decoder.decode(value, { stream: true });
      }
    }
  } finally {
    reader.releaseLock();
  }
  text += decoder.decode();
  return text;
}

// capped read + JSON.parse in one step, for routes that would otherwise call
// request.json() (which buffers + parses with no cap).
export async function readJsonCapped(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readTextCapped(request, maxBytes);
  return JSON.parse(text);
}
