import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";

import { lumeusContractEvents, lumeusContractTokens, type LumeusConfig } from "@/lib/lumeus/client";
import { fromScValAddress, fromScValSymbol } from "@/lib/soroban/scval";

const CFG: LumeusConfig = {
  activity: "https://api-testnet.lumeus.dev",
  assets: "https://assets-testnet.lumeus.dev",
  key: "lum_pub_test",
};
const OWNER = "GALHQGPVVKWHE5AUIUYXR7WCPIXJWMQ7CSCS6SWIHRUOLR7F35JHPJCG";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// a record as lumeus testnet returned it on 2026-10-19 for an xlm sac approve
// (tx e85eafc0670290ff8d6b7f0cf1087df8e504a07f1b8b6a1c6614c6a7a28583cb)
const APPROVE_RECORD = {
  id: "testnet:5277328:ce:10:0:0",
  kind: "contract_event",
  type: "approve",
  network: "testnet",
  ledger: 5277328,
  closed_at: "2026-10-19T11:43:47Z",
  tx_hash: "e85eafc0670290ff8d6b7f0cf1087df8e504a07f1b8b6a1c6614c6a7a28583cb",
  tx_index: 10,
  operation_index: 1,
  contract_address: XLM_SAC,
  topics: ["approve", OWNER, XLM_SAC, "native"],
  data: ["12345678", 5377326],
  topics_xdr: [
    "AAAADwAAAAdhcHByb3ZlAA==",
    "AAAAEgAAAAAAAAAAFngZ9aqscnQURTF4/sJ6LpsyHxSFL0rIPGjlx+XfUnc=",
    "AAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQ==",
    "AAAADgAAAAZuYXRpdmUAAA==",
  ],
  data_xdr: "AAAAEAAAAAEAAAACAAAACgAAAAAAAAAAAAAAAAC8YU4AAAADAFINLg==",
  paging_token: "0022665951170306049-0000000000",
  rpc_event_id: "0022665951170306048-0000000000",
};

function page(records: unknown[], complete: boolean, next?: string) {
  return {
    read_view: { network: "testnet", snapshot_ledger: 5277457, published_through: 5277457 },
    range_complete: complete,
    _links: next === undefined ? {} : { next: { href: next } },
    _embedded: { records },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lumeusContractEvents", () => {
  it("decodes the records into rpc events keyed by the rpc's own event id", async () => {
    const fetch = vi.fn(async () => json(page([APPROVE_RECORD], true)));
    const out = await lumeusContractEvents(CFG, OWNER, { name: "approve", position: 1 }, { fetch });

    expect(out.throughLedger).toBe(5277457);
    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.id).toBe("0022665951170306048-0000000000");
    expect(ev.ledger).toBe(5277328);
    expect(ev.operationIndex).toBe(0);
    expect(ev.contractId?.contractId()).toBe(XLM_SAC);
    expect(fromScValSymbol(ev.topic[0]!)).toBe("approve");
    expect(fromScValAddress(ev.topic[1]!)).toBe(OWNER);
    expect(scValToNative(ev.value)).toEqual([12345678n, 5377326]);
  });

  it("asks for the name, the topic position and the contract, and sends the key", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      json(page([], true)),
    );
    await lumeusContractEvents(
      CFG,
      OWNER,
      { name: "deposit", position: 2, contract: XLM_SAC },
      { fetch },
    );
    const url = fetch.mock.calls[0]![0] as URL;
    const init = fetch.mock.calls[0]![1];
    expect(url.origin).toBe(CFG.activity);
    expect(url.pathname).toBe(`/accounts/${OWNER}/contract-events`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: "deposit",
      position: "2",
      contract: XLM_SAC,
      order: "asc",
    });
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer lum_pub_test");
  });

  it("follows next links on the same host until the range is complete", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(page([APPROVE_RECORD], false, "/accounts/x/contract-events?cursor=1")),
      )
      .mockResolvedValueOnce(json(page([], true)));
    const out = await lumeusContractEvents(CFG, OWNER, { name: "approve", position: 1 }, { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1]![0] as URL).href).toBe(
      `${CFG.activity}/accounts/x/contract-events?cursor=1`,
    );
    expect(out.events).toHaveLength(1);
  });

  it("refuses a next link to another host, so the key goes nowhere else", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(page([], false, "https://evil.example/steal")));
    await expect(
      lumeusContractEvents(CFG, OWNER, { name: "approve", position: 1 }, { fetch }),
    ).rejects.toThrow(/another host/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails instead of returning a walk that stopped at the page cap", async () => {
    const fetch = vi.fn(async () => json(page([], false, "/accounts/x/contract-events?cursor=1")));
    await expect(
      lumeusContractEvents(CFG, OWNER, { name: "approve", position: 1 }, { fetch, maxPages: 3 }),
    ).rejects.toThrow(/3-page cap/);
  });

  it("names the status, the reason and the request id of a refused request", async () => {
    const fetch = vi.fn(async () =>
      json({ error: "activity history is busy", request_id: "req_abc" }, 503),
    );
    await expect(
      lumeusContractEvents(CFG, OWNER, { name: "approve", position: 1 }, { fetch }),
    ).rejects.toThrow(
      "partner index answered HTTP 503: activity history is busy (request req_abc)",
    );
  });

  it("rejects a page that is not the expected shape", async () => {
    const fetch = vi.fn(async () => json({ records: [] }));
    await expect(
      lumeusContractEvents(CFG, OWNER, { name: "approve", position: 1 }, { fetch }),
    ).rejects.toThrow(/unexpected page/);
  });
});

describe("lumeusContractTokens", () => {
  const holding = (contract: string | null, kind = "contract") => ({ kind, contract_id: contract });
  const TOKEN_A = "CAMQIHSDAYJ4CKESANCBHNYE3ODYQQ732GRXGBKAOZBM6TRUVR4HRMGR";
  const TOKEN_B = "CCH56IBUWKBIIMT6QDLXLKGRQQQIFHGBGUPJ74UPFGMSMTCAZCXZUWJV";

  it("collects the contract tokens, the unverified ones included, across pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          read_view: { as_of_ledger: 900 },
          _links: { next: { href: "/accounts/x/holdings?cursor=1" } },
          _embedded: { records: [holding(TOKEN_A), holding(null, "native")] },
        }),
      )
      .mockResolvedValueOnce(
        json({
          read_view: { as_of_ledger: 901 },
          _links: {},
          completeness: { unverified_contracts: [TOKEN_B] },
          _embedded: { records: [] },
        }),
      );
    const out = await lumeusContractTokens(CFG, OWNER, { fetch });
    expect(out.contractIds).toEqual([TOKEN_A, TOKEN_B]);
    // the oldest page's ledger: that is the state the whole answer covers
    expect(out.asOfLedger).toBe(900);
    const first = fetch.mock.calls[0]![0] as URL;
    expect(first.origin).toBe(CFG.assets);
    expect(Object.fromEntries(first.searchParams)).toMatchObject({
      kind: "contract",
      include: "unverified",
    });
  });
});

describe("lumeusFor", () => {
  const KEYS = ["NEXT_PUBLIC_LUMEUS_TESTNET_KEY", "NEXT_PUBLIC_LUMEUS_MAINNET_KEY"] as const;
  const orig = KEYS.map((k) => process.env[k]);

  beforeEach(() => {
    vi.resetModules(); // getPublicEnv memoizes; a fresh module clears the cache
  });
  afterEach(() => {
    KEYS.forEach((k, i) => {
      if (orig[i] === undefined) delete process.env[k];
      else process.env[k] = orig[i];
    });
  });

  async function load() {
    const { lumeusFor } = await import("@/lib/lumeus/client");
    const { MAINNET, TESTNET } = await import("@/lib/config/networks");
    return { lumeusFor, MAINNET, TESTNET };
  }

  it("is off for a network without a key", async () => {
    delete process.env.NEXT_PUBLIC_LUMEUS_TESTNET_KEY;
    process.env.NEXT_PUBLIC_LUMEUS_MAINNET_KEY = "";
    const { lumeusFor, MAINNET, TESTNET } = await load();
    expect(lumeusFor(TESTNET)).toBeNull();
    expect(lumeusFor(MAINNET)).toBeNull();
  });

  it("pairs each network's key with that network's hosts", async () => {
    process.env.NEXT_PUBLIC_LUMEUS_TESTNET_KEY = "lum_pub_aaa";
    process.env.NEXT_PUBLIC_LUMEUS_MAINNET_KEY = "lum_pub_bbb";
    const { lumeusFor, MAINNET, TESTNET } = await load();
    expect(lumeusFor(TESTNET)).toEqual({
      activity: "https://api-testnet.lumeus.dev",
      assets: "https://assets-testnet.lumeus.dev",
      key: "lum_pub_aaa",
    });
    expect(lumeusFor(MAINNET)?.key).toBe("lum_pub_bbb");
  });

  it.each(["lum_test_abc", "lum_live_abc"])(
    "refuses a full-access key (%s) in the client bundle",
    async (key) => {
      process.env.NEXT_PUBLIC_LUMEUS_TESTNET_KEY = key;
      const { lumeusFor, TESTNET } = await load();
      expect(() => lumeusFor(TESTNET)).toThrow(/publishable key/);
    },
  );
});
