import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { isCloseInFlight, tryRunWithCloseLock } from "@/lib/mediator/pending-flow";

// node 24 ships the web locks api on navigator, so these run against a real
// lock manager rather than a stand-in
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

  it("returns at once without running when another close took the lock after the check", async () => {
    const account = Keypair.random().publicKey();
    // the caller checked and saw no close running
    expect(await isCloseInFlight(account)).toBe(false);
    // then another tab takes the lock before this one asks for it
    let releaseOther!: () => void;
    const other = navigator.locks.request(
      `account-demolisher:close:${account}`,
      { mode: "exclusive" },
      () => new Promise<void>((resolve) => (releaseOther = resolve)),
    );
    await expect.poll(() => isCloseInFlight(account)).toBe(true);

    let ran = false;
    const attempt = tryRunWithCloseLock(account, async () => {
      ran = true;
      return "closed";
    });
    // a waiting request would still be pending here
    const settled = await Promise.race([
      attempt.then((r) => r),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 200)),
    ]);
    releaseOther();
    await other;
    await attempt;
    expect(settled).toEqual({ ran: false });
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
