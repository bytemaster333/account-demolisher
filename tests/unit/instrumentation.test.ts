// the server start hook refuses a proxy setting that can't identify clients
// (H-35, M-59), so a misconfigured deployment exits instead of serving.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { register } from "@/instrumentation";

class Exited extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`exit ${String(code)}`);
  }
}

let exit: MockInstance<typeof process.exit>;
let logged: MockInstance<typeof console.error>;

beforeEach(() => {
  exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exited(code);
  });
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exit.mockRestore();
  logged.mockRestore();
  vi.unstubAllEnvs();
});

describe("instrumentation register", () => {
  it("exits the node server with TRUSTED_PROXY_HOPS=0 and says why", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    await expect(register()).rejects.toEqual(new Exited(1));
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/TRUSTED_PROXY_HOPS is 0/));
  });

  it("exits on a value that isn't a whole number", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "one");
    await expect(register()).rejects.toEqual(new Exited(1));
  });

  it("starts with one or more trusted hops, or the default of one", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv("TRUSTED_PROXY_HOPS", undefined);
    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips the check outside the node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    await expect(register()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
