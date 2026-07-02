// refractor REST client

const DEFAULT_API_URL = "https://api.refractor.space";

// state returned by GET /tx/{hash}. fields we don't consume stay optional
export interface RefractorTxStatus {
  readonly hash: string;
  readonly network: string;
  // current envelope with every collected signature attached
  readonly xdr: string;
  // remaining cumulative signatures before refractor auto-submits. 0 means
  // submission is in flight or finished
  readonly signaturesNeeded: number;
  readonly signers: readonly string[];
  // subset of `signers` whose signature refractor has already collected. derived
  // from the `signatures` array, matched to the desired set by key, the same
  // matching `signaturesNeeded` relies on. empty when refractor reports no
  // resolvable signer keys yet (e.g. before it inspects the envelope)
  readonly signedBy: readonly string[];
  // unix-seconds expiry after which refractor purges the envelope
  readonly expiresAt?: number;
  readonly callbackUrl?: string;
  // true once refractor submitted to horizon successfully
  readonly submitted?: boolean;
  // horizon tx hash; present once submitted
  readonly submitResult?: { readonly hash: string };
}

export interface RefractorClientOptions {
  readonly apiUrl?: string;
  // fetch override for tests
  readonly fetchImpl?: typeof fetch;
}

export class RefractorError extends Error {
  readonly status: number | null;
  readonly code: string;
  constructor(message: string, code: string, status: number | null = null) {
    super(message);
    this.name = "RefractorError";
    this.code = code;
    this.status = status;
  }
}

// strongly-typed REST client. stateless; construct one per flow
export class RefractorClient {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: RefractorClientOptions = {}) {
    this.#apiUrl = stripTrailingSlash(options.apiUrl ?? DEFAULT_API_URL);
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis);
  }

  // read current state by canonical hash. throws on non-2xx and shape violations
  async getStatus(hash: string): Promise<RefractorTxStatus> {
    if (typeof hash !== "string" || hash.length === 0) {
      throw new RefractorError("Refractor getStatus: hash must be non-empty.", "EARG");
    }

    const response = await this.#fetch(`${this.#apiUrl}/tx/${encodeURIComponent(hash)}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    const payload = await readJson(response);
    if (!response.ok) {
      throw new RefractorError(
        `Refractor getStatus failed: ${response.status} ${response.statusText}: ${describeError(payload)}`,
        readErrorCode(payload, "ESTATUS"),
        response.status,
      );
    }

    return parseStatus(payload);
  }
}

// hand-rolled shape validation, the response is tiny, the rules are obvious

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === "object" && key in (payload as Record<string, unknown>)) {
    const val = (payload as Record<string, unknown>)[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

function readNumber(payload: unknown, key: string): number | null {
  if (payload && typeof payload === "object" && key in (payload as Record<string, unknown>)) {
    const val = (payload as Record<string, unknown>)[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return null;
}

// refractor's desiredSigners / signatures are arrays of either bare G-address
// strings or { key, ... } objects. this normalizes both shapes into a flat
// list of keys
function collectSignerKeys(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const keys: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) {
      keys.push(entry);
    } else if (entry && typeof entry === "object") {
      const k = (entry as Record<string, unknown>).key;
      if (typeof k === "string" && k.length > 0) keys.push(k);
    }
  }
  return keys;
}

function readErrorCode(payload: unknown, fallback: string): string {
  return readString(payload, "code") ?? readString(payload, "error") ?? fallback;
}

function describeError(payload: unknown): string {
  return (
    readString(payload, "error") ??
    readString(payload, "message") ??
    JSON.stringify(payload ?? null)
  );
}

function parseStatus(payload: unknown): RefractorTxStatus {
  if (!payload || typeof payload !== "object") {
    throw new RefractorError("Refractor getStatus: response body is not an object.", "EBADRESP");
  }
  const obj = payload as Record<string, unknown>;

  const hash = readString(obj, "hash");
  const network = readString(obj, "network");
  const xdr = readString(obj, "xdr");

  if (!hash || !network || !xdr) {
    throw new RefractorError(
      "Refractor getStatus: response is missing required fields (hash, network, xdr).",
      "EBADRESP",
    );
  }

  // refractor returns `desiredSigners` (the required-signers array Refractor
  // computed, or null if it hasn't run the inspector yet) and `signatures`
  // (collected so far). neither `signaturesNeeded` nor `signers` exist as
  // top-level fields on the wire; we derive both
  const desiredSignersRaw = obj.desiredSigners;
  const signaturesRaw = Array.isArray(obj.signatures) ? obj.signatures : [];

  const desiredKeys = collectSignerKeys(desiredSignersRaw);
  const collectedKeys = collectSignerKeys(signaturesRaw);

  // when refractor knows the desired set, signaturesNeeded is the count still
  // outstanding. when it doesn't, default to 1 so the poller keeps watching
  // until the user sees signatures land or aborts
  let signaturesNeeded: number;
  if (Array.isArray(desiredSignersRaw) && desiredSignersRaw.length > 0) {
    const outstanding = desiredKeys.filter((k) => !collectedKeys.includes(k)).length;
    signaturesNeeded = outstanding;
  } else {
    signaturesNeeded = obj.submitted === true ? 0 : 1;
  }

  // surfaced signer list: prefer the desired set so the UI can list who still
  // needs to sign; fall back to whoever has already signed
  const signers: readonly string[] = desiredKeys.length > 0 ? desiredKeys : collectedKeys;

  // which of the surfaced signers have already signed. intersect against the
  // surfaced set so a collected key outside it can't mark a non-listed signer
  const signerSet = new Set(signers);
  const signedBy: readonly string[] = collectedKeys.filter((k) => signerSet.has(k));

  const status: {
    -readonly [K in keyof RefractorTxStatus]: RefractorTxStatus[K];
  } = {
    hash,
    network,
    xdr,
    signaturesNeeded,
    signers,
    signedBy,
  };

  const expiresAt = readNumber(obj, "expiresAt");
  if (expiresAt !== null) status.expiresAt = expiresAt;

  const callbackUrl = readString(obj, "callbackUrl");
  if (callbackUrl !== null) status.callbackUrl = callbackUrl;

  if (typeof obj.submitted === "boolean") status.submitted = obj.submitted;

  const submitResult = obj.submitResult;
  if (submitResult && typeof submitResult === "object") {
    const submitHash = readString(submitResult, "hash");
    if (submitHash) status.submitResult = { hash: submitHash };
  }

  return status;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// one-shot wrapper; hot loops should hold a RefractorClient directly

export async function getStatus(hash: string): Promise<RefractorTxStatus> {
  return new RefractorClient().getStatus(hash);
}
