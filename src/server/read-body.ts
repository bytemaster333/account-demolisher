// Read a request body with a hard byte cap. App-Router route handlers impose no
// default body-size limit, so without this an oversized payload is fully buffered
// (and, for JSON routes, parsed) before any per-route length check runs, a cheap
// memory-exhaustion DoS. This rejects early on the declared Content-Length and
// also enforces the cap while streaming, in case that header is absent or lying.

// generous ceiling for the JSON API routes. The largest legitimate payload is a
// signed transaction envelope (bounded elsewhere to ~12000 XDR chars) plus small
// JSON fields, so 16 KiB leaves headroom without allowing a memory-exhaustion body.
export const MAX_JSON_BODY_BYTES = 16_384;

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
