import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { xdr, type rpc } from "@stellar/stellar-sdk";
import { buildFailoverServer, createRpcServer, isFailoverError } from "@/lib/soroban/rpc-client";

// A fake rpc.Server exposing just the methods under test. Cast through unknown
// so the failover proxy (which only forwards method calls) can drive it.
function fakeServer(methods: Record<string, unknown>): rpc.Server {
  return methods as unknown as rpc.Server;
}

function httpError(status: number, message = "http error"): Error {
  return Object.assign(new Error(message), { status });
}

describe("isFailoverError", () => {
  it("treats 429 and 5xx as failover-worthy, 4xx as not", () => {
    expect(isFailoverError(httpError(429))).toBe(true);
    expect(isFailoverError(httpError(503))).toBe(true);
    expect(isFailoverError(httpError(500))).toBe(true);
    expect(isFailoverError(httpError(400))).toBe(false);
    expect(isFailoverError(httpError(404))).toBe(false);
  });

  it("treats transport/network errors (no status) as failover-worthy", () => {
    expect(isFailoverError(new Error("Failed to fetch"))).toBe(true);
    expect(isFailoverError(new Error("request timed out"))).toBe(true);
    expect(isFailoverError(new Error("socket hang up"))).toBe(true);
    expect(isFailoverError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("does not misclassify an ordinary error as failover-worthy", () => {
    expect(isFailoverError(new Error("simulation failed: contract trapped"))).toBe(false);
  });
});

describe("buildFailoverServer", () => {
  it("returns the sole server unchanged when only one is given", () => {
    const only = fakeServer({ getLatestLedger: vi.fn() });
    expect(buildFailoverServer([only])).toBe(only);
  });

  it("throws when given no servers", () => {
    expect(() => buildFailoverServer([])).toThrow(/at least one/i);
  });

  it("fails over to the next host on a 429 and returns its result", async () => {
    const a = fakeServer({ getEvents: vi.fn().mockRejectedValue(httpError(429)) });
    const b = fakeServer({ getEvents: vi.fn().mockResolvedValue({ events: ["ok"] }) });

    const server = buildFailoverServer([a, b]);
    const result = await (server as unknown as { getEvents: () => Promise<unknown> }).getEvents();

    expect(result).toEqual({ events: ["ok"] });
    expect(
      (a as unknown as { getEvents: ReturnType<typeof vi.fn> }).getEvents,
    ).toHaveBeenCalledTimes(1);
    expect(
      (b as unknown as { getEvents: ReturnType<typeof vi.fn> }).getEvents,
    ).toHaveBeenCalledTimes(1);
  });

  it("does NOT fail over on a deterministic 4xx and propagates it", async () => {
    const aFn = vi.fn().mockRejectedValue(httpError(400, "bad request"));
    const bFn = vi.fn().mockResolvedValue({ events: [] });
    const server = buildFailoverServer([
      fakeServer({ getEvents: aFn }),
      fakeServer({ getEvents: bFn }),
    ]);

    await expect(
      (server as unknown as { getEvents: () => Promise<unknown> }).getEvents(),
    ).rejects.toThrow(/bad request/);
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).not.toHaveBeenCalled(); // never tried the second host
  });

  it("sticks to the recovered host for subsequent calls", async () => {
    const aFn = vi.fn().mockRejectedValue(httpError(429));
    const bFn = vi.fn().mockResolvedValue("from-b");
    const server = buildFailoverServer([
      fakeServer({ getEvents: aFn }),
      fakeServer({ getEvents: bFn }),
    ]);
    const call = () => (server as unknown as { getEvents: () => Promise<unknown> }).getEvents();

    await call(); // a throws 429 -> fail over to b, stick to b
    await call(); // should start at b, not touch a again

    expect(aFn).toHaveBeenCalledTimes(1); // only the initial attempt
    expect(bFn).toHaveBeenCalledTimes(2);
  });

  it("propagates the last error when every host faults", async () => {
    const aFn = vi.fn().mockRejectedValue(httpError(429, "a down"));
    const bFn = vi.fn().mockRejectedValue(httpError(503, "b down"));
    const server = buildFailoverServer([
      fakeServer({ getEvents: aFn }),
      fakeServer({ getEvents: bFn }),
    ]);

    await expect(
      (server as unknown as { getEvents: () => Promise<unknown> }).getEvents(),
    ).rejects.toThrow(/b down/);
    expect(aFn).toHaveBeenCalledTimes(1);
    expect(bFn).toHaveBeenCalledTimes(1);
  });
});

describe("isFailoverError reads json-rpc error objects and real http statuses only", () => {
  it("fails over on the rpc's processing-limit throttle, thrown as a plain object", () => {
    expect(
      isFailoverError({ code: -32001, message: "request exceeded processing limit threshold" }),
    ).toBe(true);
  });

  it("does not fail over on a deterministic json-rpc error object", () => {
    expect(isFailoverError({ code: -32602, message: "invalid parameters" })).toBe(false);
  });

  it("does not treat status-code digits inside a message as an http status", () => {
    expect(isFailoverError(new Error("HostError: Error(Contract, #1504)"))).toBe(false);
    expect(isFailoverError(new Error("ledger 5034291 is outside the retention window"))).toBe(
      false,
    );
  });

  it("reads the status from the http client's exact message when the response was dropped", () => {
    expect(isFailoverError(new Error("Request failed with status code 429"))).toBe(true);
    expect(isFailoverError(new Error("Request failed with status code 400"))).toBe(false);
    expect(
      isFailoverError(new Error("simulate: Request failed with status code 503 at #1504")),
    ).toBe(false);
  });

  it("reads the status of an axios-shaped error", () => {
    expect(isFailoverError({ message: "x", response: { status: 503 } })).toBe(true);
  });
});

describe("sendTransaction across a failover", () => {
  const SIGNED = { hash: () => Buffer.alloc(32, 0xab) };
  const HASH = Buffer.alloc(32, 0xab).toString("hex");
  const badSeq = () => ({
    status: "ERROR",
    hash: HASH,
    errorResult: new xdr.TransactionResult({
      feeCharged: 100n,
      result: xdr.TransactionResultResult.txBadSeq(),
      ext: xdr.TransactionResultExt.v0(),
    }),
  });

  it("reports a tx the first host accepted before failing as already submitted", async () => {
    // host A's core took the tx, then its gateway answered 503; host B then sees
    // the sequence consumed. the landed tx must not come back as a bad-seq error
    const a = fakeServer({
      sendTransaction: vi.fn().mockRejectedValue(httpError(503)),
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
    });
    const b = fakeServer({
      sendTransaction: vi.fn().mockResolvedValue(badSeq()),
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
    });
    const server = buildFailoverServer([a, b]);
    const res = await server.sendTransaction(SIGNED as never);
    expect(res.status).toBe("DUPLICATE");
    expect(res.hash).toBe(HASH);
  });

  it("keeps the bad-seq error when no host knows the tx", async () => {
    const a = fakeServer({
      sendTransaction: vi.fn().mockRejectedValue(httpError(503)),
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    });
    const b = fakeServer({
      sendTransaction: vi.fn().mockResolvedValue(badSeq()),
      getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }),
    });
    const res = await buildFailoverServer([a, b]).sendTransaction(SIGNED as never);
    expect(res.status).toBe("ERROR");
  });

  it("does not look the tx up when the first host answered", async () => {
    const getTransaction = vi.fn();
    const a = fakeServer({ sendTransaction: vi.fn().mockResolvedValue(badSeq()), getTransaction });
    const b = fakeServer({ sendTransaction: vi.fn(), getTransaction });
    const res = await buildFailoverServer([a, b]).sendTransaction(SIGNED as never);
    expect(res.status).toBe("ERROR");
    expect(getTransaction).not.toHaveBeenCalled();
  });
});

describe("request deadline", () => {
  // two local json-rpc endpoints: one accepts the connection and never answers,
  // the other answers getHealth
  let stall: Server;
  let ok: Server;
  beforeAll(async () => {
    stall = createServer(() => {});
    ok = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              status: "healthy",
              latestLedger: 4242,
              oldestLedger: 1,
              ledgerRetentionWindow: 1,
            },
          }),
        );
      });
    });
    // port 0: other worktrees run this suite at the same time
    await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => ok.listen(0, "127.0.0.1", r));
  });
  const urlOf = (s: Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  afterAll(async () => {
    stall.closeAllConnections();
    await new Promise((r) => stall.close(r));
    await new Promise((r) => ok.close(r));
  });

  it("abandons a stalled host after the deadline and fails over", async () => {
    const server = buildFailoverServer([
      createRpcServer(urlOf(stall), { timeoutMs: 200, allowHttp: true }),
      // roomy, so a loaded machine cannot time out the host that does answer
      createRpcServer(urlOf(ok), { timeoutMs: 3_000, allowHttp: true }),
    ]);
    const started = Date.now();
    const health = await server.getHealth();
    expect(health.latestLedger).toBe(4242);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
