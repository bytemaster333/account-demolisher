// browser-side typed client for the soroswap aggregator
import type {
  BuildQuoteResponse,
  QuoteResponse,
  SendTransactionResponse,
  SupportedNetworks,
} from "@soroswap/sdk";

const DEFAULT_PROXY_URL = "/api/soroswap";

// re-exports of SDK types the callers depend on
export type SoroswapQuote = QuoteResponse;

export type SoroswapNetwork = SupportedNetworks | "mainnet" | "testnet";

// typed error surface for upstream failures
export class SoroswapProxyError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly op: string | null;
  constructor(message: string, code: string, status: number | null, op: string | null = null) {
    super(message);
    this.name = "SoroswapProxyError";
    this.code = code;
    this.status = status;
    this.op = op;
  }
}

// mirrors the op set the proxy route accepts. keep in sync with src/app/api/soroswap/route.ts
type Op = "getProtocols" | "quote" | "build" | "send";

interface OpEnvelope {
  op: Op;
  payload: unknown;
}

// quote request shape exposed to callers
export interface ClientQuoteRequest {
  assetIn: string;
  assetOut: string;
  amount: bigint;
  tradeType: "EXACT_IN" | "EXACT_OUT";
  protocols: string[];
  slippageBps?: number;
  maxHops?: number;
  parts?: number;
  feeBps?: number;
  network?: SoroswapNetwork;
}

export interface ClientBuildRequest {
  quote: QuoteResponse;
  from?: string;
  to?: string;
  referralId?: string;
  sponsor?: string;
  network?: SoroswapNetwork;
}

export interface SoroswapClientOptions {
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
}

// public surface of the proxy-facing client
export interface SoroswapClient {
  getProtocols(network: SoroswapNetwork): Promise<string[]>;
  quote(req: ClientQuoteRequest): Promise<QuoteResponse>;
  build(req: ClientBuildRequest): Promise<BuildQuoteResponse>;
  send(signedXdr: string, network?: SoroswapNetwork): Promise<SendTransactionResponse>;
}

// serialize values containing bigint to a JSON-safe form
function jsonSerializeWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

// the SDK types amountOut/otherAmountThreshold as `bigint`, but the proxy JSON path never
// materializes them as such — JSON.parse yields a string or (lossily) a Number. downstream the
// slippage guard depends on exact integer stroops, so reject any value that isn't a faithful
// non-negative integer instead of silently trusting rounded/exponential digits.
function assertStroopField(v: unknown, field: string): void {
  if (typeof v === "bigint") {
    if (v < 0n)
      throw new SoroswapProxyError(
        `quote.${field} is negative: ${v}`,
        "PROXY_BAD_RESPONSE",
        null,
        "quote",
      );
    return;
  }
  if (typeof v === "string") {
    if (!/^\d+$/.test(v)) {
      throw new SoroswapProxyError(
        `quote.${field} is not a non-negative integer string: "${v}"`,
        "PROXY_BAD_RESPONSE",
        null,
        "quote",
      );
    }
    return;
  }
  if (typeof v === "number") {
    // a JSON number that already lost precision (>2^53) or is fractional cannot be trusted
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new SoroswapProxyError(
        `quote.${field} exceeds safe-integer precision or is non-integer: ${v}`,
        "PROXY_BAD_RESPONSE",
        null,
        "quote",
      );
    }
    return;
  }
  throw new SoroswapProxyError(
    `quote.${field} has unexpected type: ${typeof v}`,
    "PROXY_BAD_RESPONSE",
    null,
    "quote",
  );
}

export class SoroswapHttpClient implements SoroswapClient {
  private readonly proxyUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SoroswapClientOptions = {}) {
    this.proxyUrl = options.proxyUrl ?? DEFAULT_PROXY_URL;
    if (options.fetchImpl !== undefined) {
      this.fetchImpl = options.fetchImpl;
    } else if (typeof globalThis.fetch === "function") {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error("No `fetch` implementation available in this environment.");
    }
  }

  // POST { op, payload } to the proxy. throws SoroswapProxyError on non-2xx or parse failure
  private async dispatch<TResult>(envelope: OpEnvelope): Promise<TResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.proxyUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: jsonSerializeWithBigInt(envelope),
      });
    } catch (err) {
      throw new SoroswapProxyError(
        err instanceof Error ? err.message : "Proxy request failed.",
        "PROXY_UNREACHABLE",
        null,
        envelope.op,
      );
    }

    const rawText = await response.text();
    let body: unknown;
    try {
      body = rawText.length === 0 ? null : JSON.parse(rawText);
    } catch {
      throw new SoroswapProxyError(
        "Proxy returned a non-JSON response.",
        "PROXY_BAD_RESPONSE",
        response.status,
        envelope.op,
      );
    }

    if (!response.ok) {
      const detail =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      const code = typeof detail["code"] === "string" ? (detail["code"] as string) : "UNKNOWN";
      const reason =
        typeof detail["reason"] === "string"
          ? (detail["reason"] as string)
          : `Soroswap proxy returned ${response.status}.`;
      throw new SoroswapProxyError(reason, code, response.status, envelope.op);
    }

    return body as TResult;
  }

  // GET /protocols
  async getProtocols(network: SoroswapNetwork): Promise<string[]> {
    return this.dispatch<string[]>({ op: "getProtocols", payload: { network } });
  }

  // POST /quote. caller specifies protocols explicitly — proxy doesn't default it
  async quote(request: ClientQuoteRequest): Promise<QuoteResponse> {
    const payload = {
      assetIn: request.assetIn,
      assetOut: request.assetOut,
      amount: request.amount,
      tradeType: request.tradeType,
      protocols: request.protocols,
      ...(request.slippageBps !== undefined ? { slippageBps: request.slippageBps } : {}),
      ...(request.maxHops !== undefined ? { maxHops: request.maxHops } : {}),
      ...(request.parts !== undefined ? { parts: request.parts } : {}),
      ...(request.feeBps !== undefined ? { feeBps: request.feeBps } : {}),
      ...(request.network !== undefined ? { network: request.network } : {}),
    };
    const quote = await this.dispatch<QuoteResponse>({ op: "quote", payload });
    // the response is cast from unchecked JSON; validate the two fields the slippage guard trusts
    const raw = quote as unknown as Record<string, unknown>;
    assertStroopField(raw["amountOut"], "amountOut");
    assertStroopField(raw["otherAmountThreshold"], "otherAmountThreshold");
    return quote;
  }

  // POST /quote/build
  async build(request: ClientBuildRequest): Promise<BuildQuoteResponse> {
    const payload = {
      quote: request.quote,
      ...(request.from !== undefined ? { from: request.from } : {}),
      ...(request.to !== undefined ? { to: request.to } : {}),
      ...(request.referralId !== undefined ? { referralId: request.referralId } : {}),
      ...(request.sponsor !== undefined ? { sponsor: request.sponsor } : {}),
      ...(request.network !== undefined ? { network: request.network } : {}),
    };
    return this.dispatch<BuildQuoteResponse>({ op: "build", payload });
  }

  // POST /send. caller signs the XDR elsewhere (wallet kit) and hands the base64 in here
  async send(signedXdr: string, network?: SoroswapNetwork): Promise<SendTransactionResponse> {
    const payload = {
      xdr: signedXdr,
      ...(network !== undefined ? { network } : {}),
    };
    return this.dispatch<SendTransactionResponse>({ op: "send", payload });
  }
}

// default singleton; construct SoroswapHttpClient directly when you need to inject fetch
export const soroswapClient: SoroswapClient = new SoroswapHttpClient();
