import { describe, expect, it } from "vitest";

import { readTextCapped, readJsonCapped, BodyTooLargeError } from "@/server/read-body";

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("https://x.test", { method: "POST", body, headers });
}

describe("readTextCapped", () => {
  it("reads a body within the cap", async () => {
    expect(await readTextCapped(post("hello"), 100)).toBe("hello");
  });

  it("rejects early on a declared Content-Length over the cap", async () => {
    // a string body sets Content-Length, so the header check fires before reading
    await expect(readTextCapped(post("x".repeat(500)), 100)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("enforces the cap while streaming when Content-Length is absent", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("y".repeat(500)));
        c.close();
      },
    });
    // a stream body has no Content-Length, so only the streaming cap can catch it
    const req = new Request("https://x.test", {
      method: "POST",
      body: stream,
      // required by undici for a stream request body
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readTextCapped(req, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("returns empty string for no body", async () => {
    expect(await readTextCapped(new Request("https://x.test", { method: "POST" }), 100)).toBe("");
  });
});

describe("readJsonCapped", () => {
  it("parses JSON within the cap", async () => {
    expect(await readJsonCapped(post(JSON.stringify({ a: 1, b: "two" })), 100)).toEqual({
      a: 1,
      b: "two",
    });
  });

  it("rejects an oversized JSON body before parsing", async () => {
    await expect(
      readJsonCapped(post(JSON.stringify({ x: "z".repeat(500) })), 100),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
