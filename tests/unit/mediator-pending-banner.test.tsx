// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("server-only", () => ({}));
process.env.MEDIATOR_SECRET = Keypair.random().secret();

import * as reissueRoute from "@/app/api/mediator/reissue/route";
import * as signRoute from "@/app/api/mediator/sign/route";
import { PendingForwardBanner } from "@/components/wallet/PendingForwardBanner";
import { startMediatorFlow } from "@/lib/mediator/client";
import {
  isCloseInFlight,
  loadPendingForwards,
  runWithCloseLock,
  savePendingForward,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";

import { FakeHorizon, XLM } from "./mediator-horizon-fake";

// happy-dom has no Web Locks; this is just enough of one for the banner
class FakeLocks {
  private readonly held = new Set<string>();
  private waiters: Array<() => void> = [];

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private async waitFree(name: string, signal?: AbortSignal): Promise<void> {
    while (this.held.has(name)) {
      await new Promise<void>((resolve, reject) => {
        this.waiters.push(resolve);
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
  }

  async request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: () => T | Promise<T>,
  ): Promise<T> {
    await this.waitFree(name, options.signal);
    if (options.mode === "shared") return callback();
    this.held.add(name);
    try {
      return await callback();
    } finally {
      this.held.delete(name);
      this.wake();
    }
  }

  query(): Promise<{ held: { name: string }[]; pending: [] }> {
    return Promise.resolve({ held: [...this.held].map((name) => ({ name })), pending: [] });
  }
}

let fake: FakeHorizon;
let user: string;
let cex: string;

async function flowRecord(): Promise<PendingMediatorForward> {
  const flow = await startMediatorFlow(cex, {
    network: "testnet",
    memo: { type: "id", value: "31337" },
  });
  if (!flow.ok) throw new Error(flow.reason);
  return {
    publicKey: user,
    mediatorPublicKey: flow.mediatorPublicKey,
    flowToken: flow.flowToken,
    ultimateDestination: cex,
    memo: { type: "id", value: "31337" },
    networkId: "testnet",
    savedAt: Date.now(),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  fake = new FakeHorizon({
    sign: { GET: signRoute.GET, POST: signRoute.POST },
    reissue: reissueRoute.POST,
  });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  signRoute.__resetRateLimiterForTests();
  reissueRoute.__resetRateLimiterForTests();
  user = Keypair.random().publicKey();
  cex = Keypair.random().publicKey();
  fake.createAccount(user, 40n * XLM);
  fake.createAccount(cex, 1n * XLM);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "locks", { value: null, configurable: true });
});

describe("PendingForwardBanner", () => {
  it("shows a record written after mount, once the merge has landed", async () => {
    render(<PendingForwardBanner publicKey={user} />);
    expect(screen.queryByText("An exchange forward was interrupted")).toBeNull();

    // the close in this tab saves its record, the merge lands, the forward fails
    const record = await flowRecord();
    fake.createAccount(record.mediatorPublicKey, 2n * XLM);
    fake.mergeInto(user, record.mediatorPublicKey);
    act(() => savePendingForward(record));

    expect(await screen.findByText("An exchange forward was interrupted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume the forward" })).toBeTruthy();
  });

  it("resumes the forward and confirms delivery with the transaction", async () => {
    const record = await flowRecord();
    fake.createAccount(record.mediatorPublicKey, 2n * XLM);
    fake.mergeInto(user, record.mediatorPublicKey);
    savePendingForward(record);
    render(<PendingForwardBanner publicKey={user} />);

    fireEvent.click(await screen.findByRole("button", { name: "Resume the forward" }));
    expect(await screen.findByText("Exchange forward delivered")).toBeTruthy();
    const link = screen.getByRole("link", { name: "View the forward transaction" });
    expect(link.getAttribute("href")).toContain("/explorer/testnet/tx/");
    expect(loadPendingForwards(user)).toEqual([]);
    expect(screen.queryByText("An exchange forward was interrupted")).toBeNull();
  });

  it("clears a record whose forward already landed and says so", async () => {
    const record = await flowRecord();
    fake.createAccount(record.mediatorPublicKey, 2n * XLM);
    fake.mergeInto(user, record.mediatorPublicKey);
    savePendingForward(record);
    // delivered by another tab before this one looks
    const { resumePendingForward } = await import("@/lib/mediator/pending-flow");
    await resumePendingForward(record, { sleep: async () => undefined });
    savePendingForward(record);

    render(<PendingForwardBanner publicKey={user} />);
    expect(await screen.findByText("Exchange forward delivered")).toBeTruthy();
    await waitFor(() => expect(loadPendingForwards(user)).toEqual([]));
  });

  it("stays quiet about a recent close that has not merged yet", async () => {
    const record = await flowRecord();
    fake.createAccount(record.mediatorPublicKey, 2n * XLM);
    savePendingForward(record);
    render(<PendingForwardBanner publicKey={user} />);
    // the mediator's account is read only after its history said "no merge"
    await waitFor(() =>
      expect(fake.requests).toContain(`GET /accounts/${record.mediatorPublicKey}`),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not raise an alarm for a close that stopped before the merge", async () => {
    const record = { ...(await flowRecord()), savedAt: Date.now() - 60 * 60 * 1000 };
    fake.createAccount(record.mediatorPublicKey, 2n * XLM); // funded, never merged into
    savePendingForward(record);
    render(<PendingForwardBanner publicKey={user} />);

    expect(
      await screen.findByText("An earlier exchange close stopped before the merge"),
    ).toBeTruthy();
    expect(screen.queryByText("An exchange forward was interrupted")).toBeNull();
    expect(screen.getByText(/still holds 2\.0000000 XLM/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(loadPendingForwards(user)).toEqual([]));
  });

  it("stays hidden while a close for the account is running, then shows the failed forward", async () => {
    Object.defineProperty(navigator, "locks", { value: new FakeLocks(), configurable: true });
    const record = await flowRecord();
    let finishClose!: () => void;
    const closeRunning = runWithCloseLock(
      user,
      () => new Promise<void>((resolve) => (finishClose = resolve)),
    );
    // the close takes its lock before it writes any record
    await waitFor(async () => expect(await isCloseInFlight(user)).toBe(true));

    render(<PendingForwardBanner publicKey={user} />);
    fake.createAccount(record.mediatorPublicKey, 2n * XLM);
    fake.mergeInto(user, record.mediatorPublicKey);
    act(() => savePendingForward(record));
    // give the banner time to check; it must not offer a racing resume
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("An exchange forward was interrupted")).toBeNull();

    await act(async () => {
      finishClose();
      await closeRunning;
    });
    expect(await screen.findByText("An exchange forward was interrupted")).toBeTruthy();
  });
});
