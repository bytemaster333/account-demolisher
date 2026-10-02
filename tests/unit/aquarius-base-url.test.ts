import { describe, it, expect, vi } from "vitest";

import {
  AquariusAPIPoolProvider,
  AQUARIUS_API_MAINNET_BASE_URL,
  AQUARIUS_API_TESTNET_BASE_URL,
  aquariusApiBaseUrlForNetwork,
} from "@/lib/adapters/aquarius/pools";
import { MAINNET, TESTNET, FUTURENET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// an empty paginated envelope: getUserPools then returns [] without touching the
// RPC server (no entries -> getPoolShareBalance is never called), so a dummy
// server is fine and we can assert purely on which host was fetched.
function emptyPage() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ count: 0, next: null, previous: null, results: [] }),
  } as unknown as Response;
}

function makeFetchMock() {
  return vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(emptyPage()));
}

function fetchUrlFor(network: typeof TESTNET) {
  const fetchImpl = makeFetchMock();
  const provider = new AquariusAPIPoolProvider({
    server: {} as never,
    network,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { fetchImpl, provider };
}

describe("Aquarius REST base URL is network-correct (regression: testnet must not query the mainnet API)", () => {
  it("maps each network to its own backend", () => {
    expect(aquariusApiBaseUrlForNetwork(TESTNET)).toBe(AQUARIUS_API_TESTNET_BASE_URL);
    expect(aquariusApiBaseUrlForNetwork(MAINNET)).toBe(AQUARIUS_API_MAINNET_BASE_URL);
    // no aquarius backend on futurenet: refuse instead of querying mainnet's
    expect(() => aquariusApiBaseUrlForNetwork(FUTURENET)).toThrow(/futurenet/);
  });

  it("queries the testnet backend when built for testnet with no baseUrl override", async () => {
    const { fetchImpl, provider } = fetchUrlFor(TESTNET);
    await provider.getUserPools(USER);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url.startsWith(AQUARIUS_API_TESTNET_BASE_URL)).toBe(true);
  });

  it("queries the mainnet backend when built for mainnet", async () => {
    const { fetchImpl, provider } = fetchUrlFor(MAINNET);
    await provider.getUserPools(USER);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url.startsWith(AQUARIUS_API_MAINNET_BASE_URL)).toBe(true);
  });

  it("honours an explicit baseUrl override (test seam) over the network default", async () => {
    const fetchImpl = makeFetchMock();
    const provider = new AquariusAPIPoolProvider({
      server: {} as never,
      network: TESTNET,
      baseUrl: "https://example.test/api/v1/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.getUserPools(USER);
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url.startsWith("https://example.test/api/v1/")).toBe(true);
  });
});
