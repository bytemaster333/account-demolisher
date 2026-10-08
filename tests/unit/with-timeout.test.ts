import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@/lib/with-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes through a value that settles in time and leaves no timer behind", async () => {
    vi.useFakeTimers();
    await expect(withTimeout("read", Promise.resolve(7), 1_000)).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes through a rejection that comes in time", async () => {
    vi.useFakeTimers();
    const failed = withTimeout("read", Promise.reject(new Error("boom")), 1_000);
    await expect(failed).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the label once the time is up", async () => {
    vi.useFakeTimers();
    const pending = withTimeout("balance(CABC…)", new Promise<never>(() => {}), 1_000);
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toEqual(new Error("balance(CABC…) timed out after 1000ms"));
  });
});
