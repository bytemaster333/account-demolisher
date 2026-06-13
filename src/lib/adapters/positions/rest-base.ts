// shared HTTP plumbing for the REST position providers (orion, octopos)
import {
  type DeFiPositionProviderName,
  type IDeFiPositionProvider,
  type ProtocolPositions,
  ProviderSchemaMismatch,
  ProviderUnavailable,
} from "./interface";
import type { NetworkConfig } from "@/lib/config/networks";
import { parseProtocolPositions } from "./schema";

export const DEFAULT_POSITIONS_PROXY_URL = "/api/positions";

// op identifier accepted by the proxy. "direct" not accepted — direct provider runs client-side
export type PositionsProxyProvider = Exclude<DeFiPositionProviderName, "direct">;

export interface RestProviderOptions {
  readonly proxyUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ProxyAvailabilityResponse {
  readonly available: boolean;
  readonly reason?: string;
}

// shared base class for OrionProvider and OctoposProvider. both speak the same proxy envelope;
export abstract class RestPositionProvider implements IDeFiPositionProvider {
  abstract readonly name: PositionsProxyProvider;
  protected readonly proxyUrl: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(options: RestProviderOptions = {}) {
    this.proxyUrl = options.proxyUrl ?? DEFAULT_POSITIONS_PROXY_URL;
    if (options.fetchImpl !== undefined) {
      this.fetchImpl = options.fetchImpl;
    } else if (typeof globalThis.fetch === "function") {
      this.fetchImpl = globalThis.fetch.bind(globalThis);
    } else {
      throw new Error(
        `No \`fetch\` implementation available for ${this.constructor.name}; pass options.fetchImpl.`,
      );
    }
  }

  async isAvailable(): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.proxyUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ provider: this.name, op: "health" }),
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return false;
    }
    if (typeof body !== "object" || body === null) return false;
    const rec = body as Record<string, unknown>;
    return rec["available"] === true;
  }

  async getPositions(userAddress: string, network: NetworkConfig): Promise<ProtocolPositions> {
    if (typeof userAddress !== "string" || userAddress.length === 0) {
      throw new ProviderUnavailable(this.name, "`userAddress` must be a non-empty string.");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.proxyUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          provider: this.name,
          op: "getPositions",
          userAddress,
          network: network.id,
        }),
      });
    } catch (err) {
      throw new ProviderUnavailable(
        this.name,
        err instanceof Error ? err.message : "Proxy request failed.",
        err,
      );
    }

    const rawText = await response.text();
    let body: unknown;
    try {
      body = rawText.length === 0 ? null : JSON.parse(rawText);
    } catch {
      throw new ProviderUnavailable(
        this.name,
        `Proxy returned non-JSON response (status ${response.status}).`,
      );
    }

    if (!response.ok) {
      const detail =
        body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const code = typeof detail["code"] === "string" ? (detail["code"] as string) : "UNKNOWN";
      const reason =
        typeof detail["reason"] === "string"
          ? (detail["reason"] as string)
          : `Positions proxy returned ${response.status}.`;
      throw new ProviderUnavailable(this.name, `${code}: ${reason}`);
    }

    const parsed = parseProtocolPositions(body);
    if (!parsed.ok) {
      throw new ProviderSchemaMismatch(this.name, parsed.issues);
    }
    return parsed.value;
  }
}
