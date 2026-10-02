import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Memo } from "@stellar/stellar-sdk";

import { reissueMediatorFlow, startMediatorFlow } from "@/lib/mediator/client";
import { encodeMemoCommitment } from "@/lib/mediator/forward-terms";

const DEST = Keypair.random().publicKey();
const MEDIATOR = Keypair.random().publicKey();

function tokenFor(network: string, destination: string, memoXdr: string): string {
  return [
    "v2",
    "a".repeat(32),
    "9999999999999",
    network,
    destination,
    memoXdr,
    "b".repeat(64),
  ].join(".");
}

function answer(body: unknown, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startMediatorFlow (client)", () => {
  it("refuses to start a flow without stated terms and sends nothing", async () => {
    const fetchMock = answer({});
    const result = await startMediatorFlow(DEST);
    expect(result).toMatchObject({ ok: false, code: "FLOW_TERMS_MISSING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a network other than mainnet or testnet", async () => {
    answer({});
    const result = await startMediatorFlow(DEST, { network: "futurenet", memo: null });
    expect(result).toMatchObject({ ok: false, code: "INVALID_NETWORK" });
  });

  it("sends the memo as xdr and accepts a token committed to the same terms", async () => {
    const memoXdr = encodeMemoCommitment(Memo.text("acct-1"));
    const fetchMock = answer({
      ok: true,
      flowToken: tokenFor("testnet", DEST, memoXdr),
      mediatorPublicKey: MEDIATOR,
      expiresAt: 123,
    });
    const result = await startMediatorFlow(DEST, {
      network: "testnet",
      memo: { type: "text", value: "acct-1" },
    });
    expect(result).toMatchObject({ ok: true, mediatorPublicKey: MEDIATOR, expiresAt: 123 });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]), "http://app.test");
    expect(url.searchParams.get("memo")).toBe(memoXdr);
    expect(url.searchParams.get("network")).toBe("testnet");
  });

  it("accepts a base64 hash memo and commits its 32 bytes", async () => {
    const bytes = new Uint8Array(32).fill(7);
    const b64 = Buffer.from(bytes).toString("base64");
    const memoXdr = encodeMemoCommitment(Memo.hash(Buffer.from(bytes).toString("hex")));
    answer({
      ok: true,
      flowToken: tokenFor("mainnet", DEST, memoXdr),
      mediatorPublicKey: MEDIATOR,
      expiresAt: 1,
    });
    const result = await startMediatorFlow(DEST, {
      network: "mainnet",
      memo: { type: "hash", value: b64 },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a token committed to a different memo than the one asked for", async () => {
    answer({
      ok: true,
      flowToken: tokenFor("testnet", DEST, encodeMemoCommitment(Memo.none())),
      mediatorPublicKey: MEDIATOR,
      expiresAt: 1,
    });
    const result = await startMediatorFlow(DEST, {
      network: "testnet",
      memo: { type: "id", value: "5" },
    });
    expect(result).toMatchObject({ ok: false, code: "FLOW_TERMS_MISMATCH" });
  });

  it("rejects a malformed mediator public key", async () => {
    answer({
      ok: true,
      flowToken: tokenFor("testnet", DEST, encodeMemoCommitment(Memo.none())),
      mediatorPublicKey: "GNOTAKEY",
      expiresAt: 1,
    });
    const result = await startMediatorFlow(DEST, { network: "testnet", memo: null });
    expect(result).toMatchObject({ ok: false, code: "INVALID_MEDIATOR" });
  });

  it("passes server error codes through", async () => {
    answer(
      { ok: false, code: "MEDIATOR_NOT_CONFIGURED", reason: "Mediator is not configured." },
      500,
    );
    const result = await startMediatorFlow(DEST, { network: "testnet", memo: null });
    expect(result).toMatchObject({ ok: false, code: "MEDIATOR_NOT_CONFIGURED" });
  });
});

describe("reissueMediatorFlow (client)", () => {
  it("posts the token to the reissue route", async () => {
    const fetchMock = answer({
      ok: true,
      flowToken: "new",
      mediatorPublicKey: MEDIATOR,
      expiresAt: 5,
    });
    const result = await reissueMediatorFlow("old-token");
    expect(result).toMatchObject({ ok: true, flowToken: "new" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mediator/reissue");
    expect(JSON.parse(String(init.body))).toEqual({ flowToken: "old-token" });
  });

  it("reports a network failure as NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    expect(await reissueMediatorFlow("t")).toMatchObject({ ok: false, code: "NETWORK_ERROR" });
  });
});
