// refractor REST client. refractor (https://api.refractor.space) collects
// signatures on multisig transactions asynchronously and auto-submits once
// the threshold is met.
//
// surface used:
//   POST /tx       - upload a new (or update an existing) envelope.
//   GET  /tx/{h}   - read current state.
//   polling        - getStatus until signaturesNeeded == 0.

const DEFAULT_API_URL = "https://api.refractor.space";
const PUBLIC_FRONTEND_URL = "https://refractor.space";

// state returned by GET /tx/{hash}. fields we don't consume stay optional.
export interface RefractorTxStatus {
  readonly hash: string;
  readonly network: string;
  // current envelope with every collected signature attached.
  readonly xdr: string;
  // remaining cumulative signatures before refractor auto-submits. 0 means
  // submission is in flight or finished.
  readonly signaturesNeeded: number;
  readonly signers: readonly string[];
  // unix-seconds expiry after which refractor purges the envelope.
  readonly expiresAt?: number;
  readonly callbackUrl?: string;
  // true once refractor submitted to horizon successfully.
  readonly submitted?: boolean;
  // horizon tx hash; present once submitted.
  readonly submitResult?: { readonly hash: string };
}

export interface UploadOptions {
  readonly callbackUrl?: string;
  readonly expiresAt?: number;
}

export interface RefractorClientOptions {
  readonly apiUrl?: string;
  readonly frontendUrl?: string;
  // fetch override for tests.
  readonly fetchImpl?: typeof fetch;
  // polling delay override; defaults to setTimeout.
  readonly delayMs?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SubscribeOptions {
  // polling interval; defaults to 2000ms.
  readonly pollIntervalMs?: number;
  // abort signal cancels the poll without rejecting.
  readonly signal?: AbortSignal;
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

function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// maps a network passphrase to the short token refractor expects in POST /tx.
function networkTokenFor(passphrase: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015") return "public";
  if (passphrase === "Test SDF Network ; September 2015") return "testnet";
  if (passphrase === "Test SDF Future Network ; October 2022") return "futurenet";
  return passphrase;
}

// strongly-typed REST client. stateless; construct one per flow.
export class RefractorClient {
  readonly #apiUrl: string;
  readonly #frontendUrl: string;
  readonly #fetch: typeof fetch;
  readonly #delay: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: RefractorClientOptions = {}) {
    this.#apiUrl = stripTrailingSlash(options.apiUrl ?? DEFAULT_API_URL);
    this.#frontendUrl = stripTrailingSlash(options.frontendUrl ?? PUBLIC_FRONTEND_URL);
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis);
    this.#delay = options.delayMs ?? defaultDelay;
  }

  // upload an envelope; returns its canonical hash plus a shareable URL.
  // refractor merges new signatures into the server-side canonical so the
  // same hash is returned on subsequent uploads of the same payload.
  async upload(
    xdr: string,
    networkPassphrase: string,
    options: UploadOptions = {},
  ): Promise<{ hash: string; url: string }> {
    if (typeof xdr !== "string" || xdr.length === 0) {
      throw new RefractorError("Refractor upload: xdr must be a non-empty base64 string.", "EARG");
    }
    if (typeof networkPassphrase !== "string" || networkPassphrase.length === 0) {
      throw new RefractorError("Refractor upload: networkPassphrase must be non-empty.", "EARG");
    }

    const body: Record<string, unknown> = {
      xdr,
      network: networkTokenFor(networkPassphrase),
    };
    if (options.callbackUrl) body.callbackUrl = options.callbackUrl;
    if (options.expiresAt) body.expiresAt = options.expiresAt;

    const response = await this.#fetch(`${this.#apiUrl}/tx`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await readJson(response);
    if (!response.ok) {
      throw new RefractorError(
        `Refractor upload failed: ${response.status} ${response.statusText} — ${describeError(payload)}`,
        readErrorCode(payload, "EUPLOAD"),
        response.status,
      );
    }

    const hash = readString(payload, "hash");
    if (!hash) {
      throw new RefractorError(
        "Refractor upload succeeded but response is missing `hash` field.",
        "EBADRESP",
      );
    }

    return { hash, url: `${this.#frontendUrl}/tx/${hash}` };
  }

  // read current state by canonical hash. throws on non-2xx and shape violations.
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
        `Refractor getStatus failed: ${response.status} ${response.statusText} — ${describeError(payload)}`,
        readErrorCode(payload, "ESTATUS"),
        response.status,
      );
    }

    return parseStatus(payload);
  }

  // poll getStatus until signaturesNeeded == 0 or signal aborts. invokes
  // callback synchronously on each read so the UI can stream progress.
  async subscribeToCompletion(
    hash: string,
    callback: (status: RefractorTxStatus) => void,
    opts: SubscribeOptions = {},
  ): Promise<void> {
    const interval = opts.pollIntervalMs ?? 2000;
    const signal = opts.signal;

    while (true) {
      if (signal?.aborted) return;

      const status = await this.getStatus(hash);
      callback(status);

      if (status.signaturesNeeded <= 0) return;

      try {
        await this.#delay(interval, signal);
      } catch {
        // delay rejected because the signal aborted mid-sleep.
        return;
      }
    }
  }
}

// hand-rolled shape validation — the response is tiny, the rules are obvious.

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
  const signaturesNeeded = readNumber(obj, "signaturesNeeded");
  const signersRaw = obj.signers;

  if (!hash || !network || !xdr || signaturesNeeded === null) {
    throw new RefractorError(
      "Refractor getStatus: response is missing required fields " +
        "(hash, network, xdr, signaturesNeeded).",
      "EBADRESP",
    );
  }
  if (!Array.isArray(signersRaw) || !signersRaw.every((s): s is string => typeof s === "string")) {
    throw new RefractorError(
      "Refractor getStatus: `signers` must be an array of strings.",
      "EBADRESP",
    );
  }

  const status: {
    -readonly [K in keyof RefractorTxStatus]: RefractorTxStatus[K];
  } = {
    hash,
    network,
    xdr,
    signaturesNeeded,
    signers: signersRaw,
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

// one-shot wrappers; hot loops should hold a RefractorClient directly.

export async function upload(
  xdr: string,
  networkPassphrase: string,
  options: UploadOptions = {},
): Promise<{ hash: string; url: string }> {
  return new RefractorClient().upload(xdr, networkPassphrase, options);
}

export async function getStatus(hash: string): Promise<RefractorTxStatus> {
  return new RefractorClient().getStatus(hash);
}

export async function subscribeToCompletion(
  hash: string,
  callback: (status: RefractorTxStatus) => void,
  opts: SubscribeOptions = {},
): Promise<void> {
  return new RefractorClient().subscribeToCompletion(hash, callback, opts);
}
