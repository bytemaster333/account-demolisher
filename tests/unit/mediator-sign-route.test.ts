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

// the route modules are server-only; stub the guard for vitest's node env
vi.mock("server-only", () => ({}));

const MASTER = Keypair.random().secret();
process.env.MEDIATOR_SECRET = MASTER;

import { encodeMemoCommitment } from "@/lib/mediator/forward-terms";
import { REFUSED_DESTINATIONS } from "@/lib/safety/cex-registry";
import { GET, OPTIONS, POST, PUT, __resetRateLimiterForTests } from "@/app/api/mediator/sign/route";
import { MEDIATOR_FLOW_TTL_MS } from "@/server/mediator-secret";

const CEX = Keypair.random().publicKey();
const DEPOSIT_MEMO = Memo.id("424242");
let ip = 0;

function nextIp(): string {
  ip += 1;
  return `10.1.${Math.floor(ip / 250)}.${ip % 250}`;
}

function mintUrl(params: Record<string, string>): string {
  return `http://app.test/api/mediator/sign?${new URLSearchParams(params).toString()}`;
}

// the app only runs behind a proxy, which always appends the client address
function getReq(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { "x-forwarded-for": nextIp(), ...headers } });
}

async function mint(
  memo: Memo = DEPOSIT_MEMO,
  network = "testnet",
): Promise<{ flowToken: string; mediatorPublicKey: string; expiresAt: number }> {
  const res = GET(
    new Request(mintUrl({ destination: CEX, network, memo: encodeMemoCommitment(memo) }), {
      headers: { "x-forwarded-for": nextIp() },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { flowToken: string; mediatorPublicKey: string; expiresAt: number };
}

function forwardXdr(
  mediatorPk: string,
  memo: Memo,
  opts: { destination?: string; passphrase?: string; feePerOp?: string } = {},
): string {
  const dest = opts.destination ?? CEX;
  return new TransactionBuilder(new Account(mediatorPk, "7"), {
    fee: opts.feePerOp ?? "100",
    networkPassphrase: opts.passphrase ?? Networks.TESTNET,
    memo,
  })
    .addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount: "100" }))
    .addOperation(Operation.accountMerge({ destination: dest }))
    .setTimeout(300)
    .build()
    .toXdr();
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://app.test/api/mediator/sign", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), ...headers },
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/mediator/sign (mint)", () => {
  it("returns a token bound to destination, network and memo, never cacheable", async () => {
    const res = GET(
      getReq(
        mintUrl({ destination: CEX, network: "testnet", memo: encodeMemoCommitment(DEPOSIT_MEMO) }),
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.flowToken).toBe("string");
    expect(typeof body.mediatorPublicKey).toBe("string");
    expect(typeof body.expiresAt).toBe("number");
  });

  it("refuses to mint without an explicit memo commitment", async () => {
    const res = GET(getReq(mintUrl({ destination: CEX, network: "testnet" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_MEMO" });
  });

  it("refuses to mint without a supported network", async () => {
    const memo = encodeMemoCommitment(Memo.none());
    for (const network of [undefined, "futurenet", "bogus"]) {
      const params: Record<string, string> = { destination: CEX, memo };
      if (network !== undefined) params.network = network;
      const res = GET(getReq(mintUrl(params)));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_NETWORK" });
    }
  });

  it("refuses to mint a flow to an exchange's internal wallet", async () => {
    const memo = encodeMemoCommitment(Memo.none());
    for (const refused of REFUSED_DESTINATIONS) {
      for (const network of ["mainnet", "testnet"]) {
        const res = GET(getReq(mintUrl({ destination: refused.address, network, memo })));
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toMatchObject({ ok: false, code: "REFUSED_DESTINATION" });
        expect(body.reason).toContain(refused.name);
        expect(body.reason).toContain("not a deposit address");
        expect(body).not.toHaveProperty("flowToken");
      }
    }
  });

  it("answers an allow-listed cross-origin GET with CORS headers", () => {
    const res = GET(
      getReq(
        mintUrl({ destination: CEX, network: "testnet", memo: encodeMemoCommitment(Memo.none()) }),
        { origin: "http://localhost:3002" },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3002");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("does not answer an unknown origin with CORS headers", () => {
    const res = GET(
      getReq(
        mintUrl({ destination: CEX, network: "testnet", memo: encodeMemoCommitment(Memo.none()) }),
        { origin: "https://evil.example" },
      ),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rate-limits minting per client", () => {
    const req = () =>
      GET(
        new Request(
          mintUrl({
            destination: CEX,
            network: "testnet",
            memo: encodeMemoCommitment(Memo.none()),
          }),
          { headers: { "x-forwarded-for": "10.9.9.9" } },
        ),
      );
    const statuses = Array.from({ length: 40 }, () => req().status);
    expect(statuses.filter((s) => s === 200).length).toBe(30);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("OPTIONS and unsupported methods", () => {
  it("preflight lists GET for an allow-listed origin", () => {
    const res = OPTIONS(
      new Request("http://app.test/api/mediator/sign", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3002" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  it("PUT is refused with an accurate allow header", async () => {
    const res = PUT();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST, OPTIONS");
  });
});

describe("POST /api/mediator/sign (co-sign)", () => {
  it("co-signs a forward that meets every committed term", async () => {
    const flow = await mint();
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO),
      flowToken: flow.flowToken,
      network: "testnet",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; signedXdr: string };
    expect(body.ok).toBe(true);
    const signed = TransactionBuilder.fromXdr(body.signedXdr, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
  });

  it("refuses a forward to the committed exchange with an attacker's memo", async () => {
    const flow = await mint();
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, Memo.text("attacker-acct")),
      flowToken: flow.flowToken,
      network: "testnet",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FORWARD_MEMO_NOT_COMMITTED" });
  });

  it("refuses a forward that drops the committed memo", async () => {
    const flow = await mint();
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, Memo.none()),
      flowToken: flow.flowToken,
      network: "testnet",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FORWARD_MEMO_NOT_COMMITTED" });
  });

  it("refuses a forward with a fee bid above the ceiling", async () => {
    const flow = await mint();
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO, { feePerOp: "2147483647" }),
      flowToken: flow.flowToken,
      network: "testnet",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FORWARD_FEE_TOO_HIGH" });
  });

  it("refuses to sign a testnet-bound token for mainnet", async () => {
    const flow = await mint();
    const mainnetXdr = forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO, {
      passphrase: Networks.PUBLIC,
    });
    const claimed = await post({
      envelopeXdr: mainnetXdr,
      flowToken: flow.flowToken,
      network: "mainnet",
    });
    expect(claimed.status).toBe(400);
    expect(await claimed.json()).toMatchObject({ code: "NETWORK_MISMATCH" });
    // without the network field the token's own network is used: the signature
    // is made over the testnet hash, so it is worthless on mainnet
    const unclaimed = await post({ envelopeXdr: mainnetXdr, flowToken: flow.flowToken });
    const body = (await unclaimed.json()) as { ok: boolean; signedXdr: string };
    expect(body.ok).toBe(true);
    const kp = Keypair.fromPublicKey(flow.mediatorPublicKey);
    const asMainnet = TransactionBuilder.fromXdr(body.signedXdr, Networks.PUBLIC);
    const asTestnet = TransactionBuilder.fromXdr(body.signedXdr, Networks.TESTNET);
    const sig = asMainnet.signatures[0]!.signature;
    expect(kp.verify(asMainnet.hash(), sig)).toBe(false);
    expect(kp.verify(asTestnet.hash(), sig)).toBe(true);
  });

  it("refuses a forward to another destination", async () => {
    const flow = await mint();
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO, {
        destination: Keypair.random().publicKey(),
      }),
      flowToken: flow.flowToken,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FORWARD_DESTINATION_NOT_COMMITTED" });
  });

  it("tells the client an authentic token expired, so it can renew it", async () => {
    const flow = await mint();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MEDIATOR_FLOW_TTL_MS + 1000);
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO),
      flowToken: flow.flowToken,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "FLOW_TOKEN_EXPIRED" });
  });

  it("rejects a forged token as invalid", async () => {
    const flow = await mint();
    const forged = flow.flowToken.replace(/\.[0-9a-f]{64}$/u, `.${"0".repeat(64)}`);
    const res = await post({
      envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO),
      flowToken: forged,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_FLOW_TOKEN" });
  });

  it("answers an oversized body with 413", async () => {
    const res = await post({ envelopeXdr: "A".repeat(40_000), flowToken: "x" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
  });

  it("answers an allow-listed cross-origin POST with CORS headers", async () => {
    const flow = await mint();
    const res = await post(
      { envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO), flowToken: flow.flowToken },
      { origin: "http://localhost:3002" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3002");
  });
});

describe("network ids", () => {
  it("answers 400 for a network id it does not know instead of guessing one", async () => {
    const flow = await mint();
    for (const network of ["futurenet", "bogus"]) {
      const res = await post({
        envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO),
        flowToken: flow.flowToken,
        network,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_NETWORK" });
    }
  });
});

describe("client identification and rate limits", () => {
  const ORIGIN = "http://localhost:3002";

  function junkPost(from: string): Promise<Response> {
    return post({ envelopeXdr: "AAAA", flowToken: "v2.junk" }, { "x-forwarded-for": from });
  }

  it("answers a request it can't attribute to a client with a json 500 that keeps cors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const minted = GET(
      new Request(
        mintUrl({ destination: CEX, network: "testnet", memo: encodeMemoCommitment(Memo.none()) }),
        { headers: { origin: ORIGIN } },
      ),
    );
    expect(minted.status).toBe(500);
    expect(await minted.json()).toMatchObject({ code: "PROXY_MISCONFIGURED" });
    expect(minted.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const signed = await POST(
      new Request("http://app.test/api/mediator/sign", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ envelopeXdr: "AAAA", flowToken: "junk" }),
      }),
    );
    expect(signed.status).toBe(500);
    expect(await signed.json()).toMatchObject({ code: "PROXY_MISCONFIGURED" });
    expect(signed.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("limits junk posts per address with retry-after and cors", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await junkPost("10.66.0.1")).status);
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    const limited = await post(
      { envelopeXdr: "AAAA", flowToken: "v2.junk" },
      { "x-forwarded-for": "10.66.0.1", origin: ORIGIN },
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });

  it("does not let junk from an address use up a real flow's budget", async () => {
    const flow = await mint();
    for (let i = 0; i < 8; i++) await junkPost("10.66.0.2");
    expect((await junkPost("10.66.0.2")).status).toBe(429);
    const res = await post(
      { envelopeXdr: forwardXdr(flow.mediatorPublicKey, DEPOSIT_MEMO), flowToken: flow.flowToken },
      { "x-forwarded-for": "10.66.0.2" },
    );
    expect(res.status).toBe(200);
  });

  it("limits each authentic flow on its own budget, whatever address it comes from", async () => {
    const flow = await mint();
    const other = await mint();
    const signFlow = (f: { flowToken: string; mediatorPublicKey: string }) =>
      post({ envelopeXdr: forwardXdr(f.mediatorPublicKey, DEPOSIT_MEMO), flowToken: f.flowToken });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await signFlow(flow)).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
    expect((await signFlow(other)).status).toBe(200);
  });
});

describe("operator log lines", () => {
  it("never print a secret seed that ends up in an error message", async () => {
    const { logMediatorError } = await import("@/app/api/mediator/_shared/http");
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    logMediatorError("ctx", new Error(`bad seed ${MASTER} in config`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(MASTER);
    expect(lines[0]).toContain("[redacted seed]");
  });
});

describe("misconfigured MEDIATOR_SECRET", () => {
  it("logs the cause for the operator without the secret, and returns a generic code", async () => {
    vi.resetModules();
    const bad = `S${"A".repeat(54)}Q`; // seed-shaped but with a bad checksum
    process.env.MEDIATOR_SECRET = bad;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const route = await import("@/app/api/mediator/sign/route");
      const res = route.GET(
        getReq(
          mintUrl({
            destination: CEX,
            network: "testnet",
            memo: encodeMemoCommitment(Memo.none()),
          }),
        ),
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: "MEDIATOR_NOT_CONFIGURED" });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("MEDIATOR_SECRET is malformed");
      expect(errors.join("\n")).not.toContain(bad);
    } finally {
      process.env.MEDIATOR_SECRET = MASTER;
      vi.resetModules();
    }
  });

  it("charges POSTs to the client address before logging, so junk can't flood the log", async () => {
    vi.resetModules();
    process.env.MEDIATOR_SECRET = `S${"A".repeat(54)}Q`;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    // well formed, so the route has to reach the hmac (and the secret) to judge it
    const token = [
      "v2",
      "a".repeat(32),
      "1",
      "testnet",
      CEX,
      encodeMemoCommitment(Memo.none()),
      "b".repeat(64),
    ].join(".");
    const sendFrom = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
      handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "10.55.0.1" },
          body: JSON.stringify(body),
        }),
      );
    try {
      const sign = await import("@/app/api/mediator/sign/route");
      const reissue = await import("@/app/api/mediator/reissue/route");
      for (const [handler, path, body] of [
        [sign.POST, "/api/mediator/sign", { envelopeXdr: "AAAA", flowToken: token }],
        [reissue.POST, "/api/mediator/reissue", { flowToken: token }],
      ] as const) {
        errors.length = 0;
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) statuses.push((await sendFrom(handler, path, body)).status);
        expect(statuses).toEqual([500, 500, 500, 500, 500, 429, 429, 429]);
        expect(errors).toHaveLength(5);
      }
    } finally {
      process.env.MEDIATOR_SECRET = MASTER;
      vi.resetModules();
    }
  });
});
