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
  __resetRateLimiterForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/mediator/sign (mint)", () => {
  it("returns a token bound to destination, network and memo, never cacheable", async () => {
    const res = GET(
      new Request(
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
    const res = GET(new Request(mintUrl({ destination: CEX, network: "testnet" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_MEMO" });
  });

  it("refuses to mint without a supported network", async () => {
    const memo = encodeMemoCommitment(Memo.none());
    for (const network of [undefined, "futurenet", "bogus"]) {
      const params: Record<string, string> = { destination: CEX, memo };
      if (network !== undefined) params.network = network;
      const res = GET(new Request(mintUrl(params)));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_NETWORK" });
    }
  });

  it("answers an allow-listed cross-origin GET with CORS headers", () => {
    const res = GET(
      new Request(
        mintUrl({ destination: CEX, network: "testnet", memo: encodeMemoCommitment(Memo.none()) }),
        { headers: { origin: "http://localhost:3002" } },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3002");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("does not answer an unknown origin with CORS headers", () => {
    const res = GET(
      new Request(
        mintUrl({ destination: CEX, network: "testnet", memo: encodeMemoCommitment(Memo.none()) }),
        { headers: { origin: "https://evil.example" } },
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
        new Request(
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
});
