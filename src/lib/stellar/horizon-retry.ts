import { BadRequestError, NetworkError, NotFoundError } from "@stellar/stellar-sdk";

// public horizon rate-limits bursts, and the audit and path search fan out one
// request per issuer or per balance, so a single refusal must not fail the lot
export const HORIZON_REQUEST_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;

// 429, 5xx and connection failures are transient; anything else (a 400 on a
// malformed asset, a 404) is a real answer and is thrown at once. the last
// error is surfaced as is once the attempts run out.
export async function withHorizonRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= HORIZON_REQUEST_ATTEMPTS || !isTransientHorizonError(err)) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }
}

function isTransientHorizonError(err: unknown): boolean {
  if (err instanceof NotFoundError || err instanceof BadRequestError) return false;
  if (err instanceof NetworkError) {
    // the sdk stores the response body here; horizon problem documents carry the
    // status, a proxy error page does not
    const body = err.getResponse() as unknown;
    const status =
      typeof body === "object" && body !== null ? (body as { status?: unknown }).status : undefined;
    if (typeof status !== "number") return true;
    return status === 429 || status >= 500;
  }
  // no response at all: the request never reached horizon
  return err instanceof Error;
}
