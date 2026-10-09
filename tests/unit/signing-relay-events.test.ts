// the SSE events route: no stream (and no heartbeat timer) for an expired plan,
// and an open stream is released when its plan expires with no other traffic.

import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/plan/[id]/events/route";
import { __resetRelayForTests, __seedPlanForTests } from "@/server/signing-relay";

const NET = Networks.TESTNET;

function signedClose(maxTime: number): string {
  const kp = Keypair.random();
  const tx = new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(Operation.accountMerge({ destination: Keypair.random().publicKey() }))
    .build();
  tx.sign(kp);
  return tx.toXdr();
}

let ip = 0;
function open(id: string): Promise<Response> {
  ip += 1;
  return GET(
    new Request(`http://localhost/api/plan/${id}/events`, {
      headers: { "x-forwarded-for": `198.51.100.${ip}` },
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-02T12:00:00Z") });
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
});

afterEach(() => {
  __resetRelayForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("plan events route", () => {
  it("answers 404 for a plan seeded 73h ago and leaves no timer behind", async () => {
    const xdr = signedClose(0);
    const id = __seedPlanForTests("testnet", xdr, [], Date.now() - 73 * 3600 * 1000);
    const before = vi.getTimerCount();
    const res = await open(id);
    expect(res.status).toBe(404);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(vi.getTimerCount()).toBe(before);
  });

  it("closes a live stream and clears its heartbeat once the plan expires", async () => {
    const maxTime = Math.floor(Date.now() / 1000) + 30 * 60;
    const id = __seedPlanForTests("testnet", signedClose(maxTime), []);
    const base = vi.getTimerCount();
    const res = await open(id);
    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(base + 1);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"xdr"');

    // past maxTime - grace, with no other request arriving
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    const end = await reader.read();
    // heartbeats may still be queued; drain until the stream reports done
    let done = end.done;
    while (!done) done = (await reader.read()).done;
    expect(vi.getTimerCount()).toBe(base);
  });

  it("removes its abort listener when the client cancels the stream (NP5-57)", async () => {
    const maxTime = Math.floor(Date.now() / 1000) + 3600;
    const id = __seedPlanForTests("testnet", signedClose(maxTime), []);
    const request = new Request(`http://localhost/api/plan/${id}/events`, {
      headers: { "x-forwarded-for": "203.0.113.150" },
    });
    const before = getEventListeners(request.signal, "abort").length;
    const res = await GET(request, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(before + 1);

    await res.body!.cancel();
    expect(getEventListeners(request.signal, "abort")).toHaveLength(before);
  });

  it("removes its abort listener when the relay closes the stream (NP5-57)", async () => {
    const maxTime = Math.floor(Date.now() / 1000) + 30 * 60;
    const id = __seedPlanForTests("testnet", signedClose(maxTime), []);
    const request = new Request(`http://localhost/api/plan/${id}/events`, {
      headers: { "x-forwarded-for": "203.0.113.151" },
    });
    const before = getEventListeners(request.signal, "abort").length;
    const res = await GET(request, { params: Promise.resolve({ id }) });
    expect(getEventListeners(request.signal, "abort")).toHaveLength(before + 1);

    const reader = res.body!.getReader();
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    while (!(await reader.read()).done);
    expect(getEventListeners(request.signal, "abort")).toHaveLength(before);
  });

  it("answers 503 once one client holds three streams for the plan", async () => {
    const maxTime = Math.floor(Date.now() / 1000) + 3600;
    const id = __seedPlanForTests("testnet", signedClose(maxTime), []);
    const req = (): Promise<Response> =>
      GET(
        new Request(`http://localhost/api/plan/${id}/events`, {
          headers: { "x-forwarded-for": "203.0.113.200" },
        }),
        { params: Promise.resolve({ id }) },
      );
    for (let i = 0; i < 3; i++) expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(503);
    expect((await open(id)).status).toBe(200);
  });
});
