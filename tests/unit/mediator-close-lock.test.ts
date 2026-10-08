import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  isCloseInFlight,
  tryRunWithCloseLock,
  waitForCloseIdle,
} from "@/lib/mediator/pending-flow";

// node 24 ships the web locks api on navigator, so these run against a real
// lock manager rather than a stand-in

const lockName = (account: string): string => `account-demolisher:close:${account}`;

// holds the lock until the returned release is called
function hold(
  account: string,
  mode: LockMode,
): { readonly release: () => void; readonly done: Promise<void> } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const done = navigator.locks.request(lockName(account), { mode }, () => held);
  return { release, done };
}

// settles to "waiting" when the promise is still pending after a moment, which
// is what a lock request queued behind a running close looks like
function settledSoon<T>(p: Promise<T>): Promise<T | "waiting"> {
  return Promise.race([
    p,
    new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 200)),
  ]);
}

// the real lock manager, except that another tab starts a close right after
// the first query resolves: the moment a check-then-lock caller has looked and
// seen no close but not yet asked for the lock
function racingLockManager(
  account: string,
  others: Array<{ readonly release: () => void; readonly done: Promise<void> }>,
): LockManager {
  const real = navigator.locks;
  let raced = false;
  return {
    request: real.request.bind(real) as LockManager["request"],
    query: async () => {
      const state = await real.query();
      if (!raced) {
        raced = true;
        others.push(hold(account, "exclusive"));
      }
      return state;
    },
  };
}

async function heldCount(): Promise<number> {
  return (await navigator.locks.query()).held?.length ?? 0;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
});

describe("tryRunWithCloseLock", () => {
  it("runs the close under the lock when no other close holds it", async () => {
    const account = Keypair.random().publicKey();
    let heldDuringRun = false;
    const result = await tryRunWithCloseLock(account, async () => {
      heldDuringRun = await isCloseInFlight(account);
      return 42;
    });
    expect(result).toEqual({ ran: true, value: 42 });
    expect(heldDuringRun).toBe(true);
    expect(await isCloseInFlight(account)).toBe(false);
  });

  it("returns at once without running when another close holds the lock", async () => {
    const account = Keypair.random().publicKey();
    const other = hold(account, "exclusive");
    await expect.poll(() => isCloseInFlight(account)).toBe(true);

    let ran = false;
    const attempt = tryRunWithCloseLock(account, async () => {
      ran = true;
      return "closed";
    });
    const settled = await settledSoon(attempt);
    other.release();
    await other.done;
    await attempt;
    expect(settled).toEqual({ ran: false });
    expect(ran).toBe(false);
  });

  it("is never left waiting by a close another tab starts right after a check", async () => {
    const account = Keypair.random().publicKey();
    const others: Array<{ readonly release: () => void; readonly done: Promise<void> }> = [];
    Object.defineProperty(navigator, "locks", {
      value: racingLockManager(account, others),
      configurable: true,
    });
    const attempt = tryRunWithCloseLock(account, async () => "closed");
    const settled = await settledSoon(attempt);
    for (const o of others) o.release();
    await attempt;
    await Promise.all(others.map((o) => o.done));
    expect(settled).toEqual({ ran: true, value: "closed" });
  });

  it("does not take a watcher's brief shared hold for another close", async () => {
    const account = Keypair.random().publicKey();
    const watcher = hold(account, "shared");
    await expect.poll(heldCount).toBeGreaterThan(0);
    setTimeout(() => watcher.release(), 50);

    const result = await tryRunWithCloseLock(account, async () => "closed");
    await watcher.done;
    expect(result).toEqual({ ran: true, value: "closed" });
  });

  it("stops at once when a close starts while a shared hold is in the way", async () => {
    const account = Keypair.random().publicKey();
    const watcher = hold(account, "shared");
    await expect.poll(heldCount).toBeGreaterThan(0);
    const others: Array<{ readonly release: () => void; readonly done: Promise<void> }> = [];
    Object.defineProperty(navigator, "locks", {
      value: racingLockManager(account, others),
      configurable: true,
    });
    setTimeout(() => watcher.release(), 20);

    let ran = false;
    const attempt = tryRunWithCloseLock(account, async () => {
      ran = true;
      return "closed";
    });
    const settled = await settledSoon(attempt);
    for (const o of others) o.release();
    await watcher.done;
    await attempt;
    await Promise.all(others.map((o) => o.done));
    expect(settled).toEqual({ ran: false });
    expect(ran).toBe(false);
  });

  it("says so rather than run unlocked when a shared hold never lets go", async () => {
    const account = Keypair.random().publicKey();
    const stuck = hold(account, "shared");
    await expect.poll(heldCount).toBeGreaterThan(0);
    let ran = false;
    const attempt = tryRunWithCloseLock(account, async () => {
      ran = true;
    });
    await expect(attempt).rejects.toThrow(/close lock/);
    stuck.release();
    await stuck.done;
    expect(ran).toBe(false);
  });

  it("passes the close's own error through and frees the lock", async () => {
    const account = Keypair.random().publicKey();
    await expect(
      tryRunWithCloseLock(account, () => Promise.reject(new Error("submit failed"))),
    ).rejects.toThrow("submit failed");
    expect(await isCloseInFlight(account)).toBe(false);
  });
});

describe("isCloseInFlight", () => {
  it("ignores a shared hold, which no close takes", async () => {
    const account = Keypair.random().publicKey();
    const watcher = hold(account, "shared");
    await expect.poll(heldCount).toBeGreaterThan(0);
    const busy = await isCloseInFlight(account);
    watcher.release();
    await watcher.done;
    expect(busy).toBe(false);
  });

  it("counts a close that is queued for the lock", async () => {
    const account = Keypair.random().publicKey();
    const watcher = hold(account, "shared");
    const queued = hold(account, "exclusive");
    await expect
      .poll(async () => (await navigator.locks.query()).pending?.length ?? 0)
      .toBeGreaterThan(0);
    const busy = await isCloseInFlight(account);
    watcher.release();
    queued.release();
    await Promise.all([watcher.done, queued.done]);
    expect(busy).toBe(true);
  });
});

describe("waitForCloseIdle", () => {
  it("waits without holding or queueing on the lock, and returns once the close ends", async () => {
    const account = Keypair.random().publicKey();
    const close = hold(account, "exclusive");
    await expect.poll(() => isCloseInFlight(account)).toBe(true);

    let idle = false;
    const waiting = waitForCloseIdle(account, new AbortController().signal).then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    const state = await navigator.locks.query();
    const onLock = [...(state.held ?? []), ...(state.pending ?? [])].filter(
      (l) => l.name === lockName(account),
    );
    expect(onLock.map((l) => l.mode)).toEqual(["exclusive"]);
    expect(idle).toBe(false);

    close.release();
    await close.done;
    await waiting;
    expect(idle).toBe(true);
  });

  it("stops waiting when aborted", async () => {
    const account = Keypair.random().publicKey();
    const close = hold(account, "exclusive");
    await expect.poll(() => isCloseInFlight(account)).toBe(true);
    const controller = new AbortController();
    const waiting = waitForCloseIdle(account, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    close.release();
    await close.done;
  });
});
