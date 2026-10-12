import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

vi.mock("server-only", () => ({}));

process.env.MEDIATOR_SECRET = Keypair.random().secret();

import { encodeMemoCommitment } from "@/lib/mediator/forward-terms";
import * as reissueRoute from "@/app/api/mediator/reissue/route";
import * as signRoute from "@/app/api/mediator/sign/route";
import { MEDIATOR_FLOW_TTL_MS } from "@/server/mediator-secret";

const CEX = Keypair.random().publicKey();
const MEMO = Memo.text("user-7781");

// horizon is the only network dependency; answer account lookups from a table
let existing = new Set<string>();
let horizonDown = false;
const horizonCalls: string[] = [];

function horizonFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  horizonCalls.push(url.toString());
  if (horizonDown) return Promise.resolve(new Response("upstream down", { status: 503 }));
  const match = /^\/accounts\/(G[A-Z2-7]{55})$/u.exec(url.pathname);
  if (url.host !== "horizon-testnet.stellar.org" || match === null) {
    return Promise.reject(new Error(`unexpected request ${url.toString()}`));
  }
  const id = match[1]!;
  if (!existing.has(id)) {
    return Promise.resolve(
      Response.json({ type: "not_found", title: "Resource Missing", status: 404 }, { status: 404 }),
    );
  }
  return Promise.resolve(
    Response.json({
      id,
      account_id: id,
      sequence: "100",
      subentry_count: 0,
      last_modified_ledger: 10,
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: {},
      balances: [{ asset_type: "native", balance: "500.0000000" }],
      signers: [{ key: id, weight: 1, type: "ed25519_public_key" }],
      data: {},
    }),
  );
}

let ip = 0;
function headers(): Record<string, string> {
  ip += 1;
  return { "content-type": "application/json", "x-forwarded-for": `10.2.0.${ip}` };
}

async function mint(): Promise<{ flowToken: string; mediatorPublicKey: string }> {
  const params = new URLSearchParams({
    destination: CEX,
    network: "testnet",
    memo: encodeMemoCommitment(MEMO),
  });
  const res = signRoute.GET(
    new Request(`http://app.test/api/mediator/sign?${params.toString()}`, { headers: headers() }),
  );
  return (await res.json()) as { flowToken: string; mediatorPublicKey: string };
}

function reissue(flowToken: unknown): Promise<Response> {
  return reissueRoute.POST(
    new Request("http://app.test/api/mediator/reissue", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ flowToken }),
    }),
  );
}

function forward(mediatorPk: string, destination: string): string {
  return new TransactionBuilder(new Account(mediatorPk, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    memo: MEMO,
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: "10" }))
    .addOperation(Operation.accountMerge({ destination }))
    .setTimeout(300)
    .build()
    .toXdr();
}

function sign(envelopeXdr: string, flowToken: string): Promise<Response> {
  return signRoute.POST(
    new Request("http://app.test/api/mediator/sign", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ envelopeXdr, flowToken, network: "testnet" }),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  existing = new Set();
  horizonDown = false;
  horizonCalls.length = 0;
  reissueRoute.__resetRateLimiterForTests();
  signRoute.__resetRateLimiterForTests();
  vi.stubGlobal("fetch", vi.fn(horizonFetch));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/mediator/reissue", () => {
  it("renews an expired token for an existing mediator, and the renewed token co-signs the original forward", async () => {
    const flow = await mint();
    existing.add(flow.mediatorPublicKey);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MEDIATOR_FLOW_TTL_MS * 10);

    // the stale token is refused at sign time...
    const stale = await sign(forward(flow.mediatorPublicKey, CEX), flow.flowToken);
    expect(await stale.json()).toMatchObject({ code: "FLOW_TOKEN_EXPIRED" });

    // ...renewed for the same mediator...
    const res = await reissue(flow.flowToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const renewed = (await res.json()) as {
      ok: boolean;
      flowToken: string;
      mediatorPublicKey: string;
    };
    expect(renewed.ok).toBe(true);
    expect(renewed.mediatorPublicKey).toBe(flow.mediatorPublicKey);
    expect(horizonCalls.some((u) => u.endsWith(`/accounts/${flow.mediatorPublicKey}`))).toBe(true);

    // ...and signs the forward to the committed destination and memo
    const ok = await sign(forward(flow.mediatorPublicKey, CEX), renewed.flowToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
  });

  it("keeps the renewed token bound to the original destination", async () => {
    const flow = await mint();
    existing.add(flow.mediatorPublicKey);
    const renewed = (await (await reissue(flow.flowToken)).json()) as { flowToken: string };
    const res = await sign(
      forward(flow.mediatorPublicKey, Keypair.random().publicKey()),
      renewed.flowToken,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FORWARD_DESTINATION_NOT_COMMITTED" });
  });

  it("refuses when the mediator account does not exist", async () => {
    const flow = await mint();
    const res = await reissue(flow.flowToken);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "MEDIATOR_NOT_FOUND" });
  });

  it("refuses a forged token without asking horizon", async () => {
    const flow = await mint();
    existing.add(flow.mediatorPublicKey);
    const forged = flow.flowToken.replace(/\.[0-9a-f]{64}$/u, `.${"1".repeat(64)}`);
    const res = await reissue(forged);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_FLOW_TOKEN" });
    expect(horizonCalls).toHaveLength(0);
  });

  it("reports a horizon outage as 502 and logs it", async () => {
    const flow = await mint();
    horizonDown = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await reissue(flow.flowToken);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "HORIZON_UNAVAILABLE" });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("answers a request it can't attribute to a client with a json 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await reissueRoute.POST(
      new Request("http://app.test/api/mediator/reissue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowToken: "junk" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "PROXY_MISCONFIGURED" });
  });

  it("does not let junk from an address block renewing a real flow from that address", async () => {
    const flow = await mint();
    existing.add(flow.mediatorPublicKey);
    const from = (flowToken: unknown) =>
      reissueRoute.POST(
        new Request("http://app.test/api/mediator/reissue", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "10.77.0.1" },
          body: JSON.stringify({ flowToken }),
        }),
      );
    for (let i = 0; i < 6; i++) await from("junk");
    const limited = await from("junk");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await from(flow.flowToken)).status).toBe(200);
  });

  it("rejects a missing token and refuses GET", async () => {
    const res = await reissue(undefined);
    expect(res.status).toBe(400);
    expect(reissueRoute.GET().status).toBe(405);
  });
});

// the route serves only POST, so its cors answers must not advertise the GET it
// refuses with a 405 (NPF-9)
describe("reissue CORS lists only the methods the route serves", () => {
  const origin = "http://localhost:3002";

  it("answers a preflight with POST and OPTIONS, the same list as its 405 allow header", () => {
    const res = reissueRoute.OPTIONS(
      new Request("http://app.test/api/mediator/reissue", {
        method: "OPTIONS",
        headers: { origin },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-methods")).toBe(
      reissueRoute.GET().headers.get("allow"),
    );
  });

  it("puts the same list on a cross-origin POST answer", async () => {
    const res = await reissueRoute.POST(
      new Request("http://app.test/api/mediator/reissue", {
        method: "POST",
        headers: { ...headers(), origin },
        body: JSON.stringify({ flowToken: "junk" }),
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});
