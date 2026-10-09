// @vitest-environment happy-dom

import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RelayPlan } from "@/lib/multisig/plan-client";

// the relay is a network boundary, so its browser client is replaced by a
// controllable fake. everything that reads or builds the envelope is real.
type Update = (plan: RelayPlan) => void;
type OnStatus = (info: { mode: string; terminal: boolean }) => void;
const relay = {
  update: null as Update | null,
  onStatus: null as OnStatus | null,
  submitSignature: vi.fn(),
  fetchPlan: vi.fn(),
  publishPlan: vi.fn(),
};
vi.mock("@/lib/multisig/plan-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/multisig/plan-client")>()),
  subscribePlan: (_id: string, onUpdate: Update, onStatus?: OnStatus) => {
    relay.update = onUpdate;
    relay.onStatus = onStatus ?? null;
    return () => {};
  },
  submitSignature: (...a: unknown[]) => relay.submitSignature(...a),
  fetchPlan: (...a: unknown[]) => relay.fetchPlan(...a),
  publishPlan: (...a: unknown[]) => relay.publishPlan(...a),
}));

// horizon is the other network boundary: the freshness check reads the live
// account, its offers, the claimable balances the bundle claims and the merge
// destination
const horizon = { account: null as Horizon.AccountResponse | null, loads: [] as string[] };
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({
    loadAccount: async (id: string) => {
      horizon.loads.push(id);
      if (horizon.account === null) throw new Error("no account");
      return horizon.account;
    },
    offers: () => ({
      forAccount: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
    }),
    claimableBalances: () => ({
      claimableBalance: () => ({ call: async () => Promise.reject(new Error("none")) }),
    }),
  }),
}));

import {
  CollectSignatures,
  type CollectSignaturesProps,
} from "@/components/multisig/CollectSignatures";
import { NETWORKS } from "@/lib/config/networks";
import { PlanNotFoundError } from "@/lib/multisig/plan-client";
import type { AccountAudit } from "@/lib/types/account";

const network = NETWORKS.testnet;
const NET = Networks.TESTNET;

const initiator = Keypair.random();
const a = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();
const destination = Keypair.random().publicKey();

// the real batcher removes each extra signer before the merge, so the fixture
// bundle does the same
function buildClose(dest = destination, memo?: Memo): Transaction {
  const builder = new TransactionBuilder(new Account(initiator.publicKey(), "100"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  });
  for (const k of [a, b, c]) {
    builder.addOperation(
      Operation.setOptions({ signer: { ed25519PublicKey: k.publicKey(), weight: 0 } }),
    );
  }
  builder.addOperation(Operation.accountMerge({ destination: dest }));
  if (memo) builder.addMemo(memo);
  return builder.build();
}

let baseTx = buildClose();
let planId = Buffer.from(baseTx.hash()).toString("hex");

function signedBy(...kps: Keypair[]): string {
  const tx = TransactionBuilder.fromXdr(baseTx.toXdr(), NET) as Transaction;
  for (const kp of kps) tx.sign(kp);
  return tx.toXdr();
}

function signerKeysOf(envelope: string): string[] {
  const tx = TransactionBuilder.fromXdr(envelope, NET) as Transaction;
  const hash = tx.hash();
  return tx.signatures.map((s) => {
    const hit = [initiator, a, b, c].find((kp) => kp.verify(hash, s.signature.toBytes()));
    return hit ? hit.publicKey() : "unknown";
  });
}

type T = { low: number; med: number; high: number };

function accountResponse(t: T, keys: readonly Keypair[], sequence = "100") {
  return new Horizon.AccountResponse({
    id: initiator.publicKey(),
    account_id: initiator.publicKey(),
    sequence,
    subentry_count: 0,
    thresholds: { low_threshold: t.low, med_threshold: t.med, high_threshold: t.high },
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    balances: [],
    data: {},
    flags: {},
  } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
}

function plan(t: T, keys: readonly Keypair[], xdr = signedBy(initiator)): RelayPlan {
  return {
    network: "testnet",
    xdr,
    account: initiator.publicKey(),
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1 })),
    thresholds: t,
    expiresAt: Date.now() + 3_600_000,
  };
}

// the account the preview saw; the relay's own snapshot is what the step uses
function audit(keys: readonly Keypair[]): AccountAudit {
  return {
    accountId: initiator.publicKey(),
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    thresholds: { low: 1, medium: 1, high: 1, masterWeight: 1 },
  } as unknown as AccountAudit;
}

const T2: T = { low: 1, med: 1, high: 2 };
const T3: T = { low: 1, med: 1, high: 3 };

async function flush(): Promise<void> {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

async function renderCollect(relayPlan: RelayPlan, opts: { onRebuildRequest?: () => void } = {}) {
  relay.fetchPlan.mockResolvedValue(relayPlan);
  const onClose = vi.fn<CollectSignaturesProps["onClose"]>();
  render(
    <CollectSignatures
      planId={planId}
      audit={audit([initiator, a])}
      network={network}
      initialXdr={signedBy(initiator)}
      destination={destination}
      connectedKey={initiator.publicKey()}
      onClose={onClose}
      {...(opts.onRebuildRequest ? { onRebuildRequest: opts.onRebuildRequest } : {})}
    />,
  );
  await flush();
  return onClose;
}

function signedBadges(): number {
  return Array.from(screen.getByTestId("collect-signers").querySelectorAll("span")).filter(
    (s) => s.textContent === "Signed",
  ).length;
}

function frame(p: RelayPlan, xdr: string): void {
  act(() => relay.update?.({ ...p, xdr }));
}

async function confirmClose(): Promise<void> {
  fireEvent.click(screen.getByTestId("collect-close"));
  const last4 = destination.slice(-4);
  fireEvent.change(screen.getByTestId("typed-confirmation-input"), { target: { value: last4 } });
  await act(async () => {
    vi.advanceTimersByTime(4100);
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("typed-confirmation-confirm"));
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  baseTx = buildClose();
  planId = Buffer.from(baseTx.hash()).toString("hex");
  relay.update = null;
  relay.onStatus = null;
  relay.submitSignature.mockReset();
  relay.fetchPlan.mockReset();
  relay.publishPlan.mockReset();
  horizon.account = null;
  horizon.loads = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CollectSignatures signer set", () => {
  it("lists the signers the relay checks against, not the preview's", async () => {
    await renderCollect(plan(T2, [initiator, a, b]));
    expect(screen.getByTestId("collect-signers").textContent).toContain(b.publicKey());
  });

  it("needs the largest of the relay's three thresholds", async () => {
    await renderCollect(plan({ low: 1, med: 3, high: 2 }, [initiator, a, b, c]));
    expect(screen.getByTestId("collect-progress").textContent).toBe("1 of 3");
  });

  it("refuses a relay plan for another account", async () => {
    const p = { ...plan(T2, [initiator, a]), account: Keypair.random().publicKey() };
    await renderCollect(p);
    expect(screen.getByTestId("collect-plan-error").textContent).toMatch(/different account/);
    expect(screen.queryByTestId("collect-secret")).toBeNull();
  });
});

describe("CollectSignatures bundle hand-off", () => {
  it("hands up only the signatures core will use, with the typed last-4 and the relay snapshot", async () => {
    horizon.account = accountResponse(T2, [initiator, a, b]);
    const p = plan(T2, [initiator, a, b]);
    const onClose = await renderCollect(p);
    frame(p, signedBy(initiator, a, b));
    expect(signedBadges()).toBe(3);
    await flush();

    await confirmClose();

    expect(onClose).toHaveBeenCalledTimes(1);
    const [handed, typed, snapshot] = onClose.mock.calls[0]!;
    expect(signerKeysOf(handed as string)).toEqual([initiator.publicKey(), a.publicKey()]);
    expect(typed).toBe(destination.slice(-4));
    expect(snapshot).toEqual({ signers: p.signers, thresholds: p.thresholds });
  });

  it("refuses when the account's signers changed since the request was published", async () => {
    // b was removed from the account after the request was published
    horizon.account = accountResponse(T2, [initiator, a]);
    const p = plan(T2, [initiator, a, b]);
    const onClose = await renderCollect(p);
    frame(p, signedBy(initiator, b));
    await flush();

    expect(screen.getByTestId("collect-stale").textContent).toMatch(/signers or their weights/);
    expect(screen.queryByText("Continue to final confirmation")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops offering local signing once the threshold is met", async () => {
    horizon.account = accountResponse(T2, [initiator, a, b]);
    const p = plan(T2, [initiator, a, b]);
    await renderCollect(p);
    expect(screen.queryByTestId("collect-secret")).not.toBeNull();
    frame(p, signedBy(initiator, a));
    expect(screen.queryByTestId("collect-secret")).toBeNull();
    expect(screen.getByText(/Enough signatures collected/)).toBeTruthy();
  });
});

describe("CollectSignatures freshness", () => {
  it("names the drift and offers a rebuild instead of the confirm when the account moved on", async () => {
    // another transaction from the account bumped its sequence
    horizon.account = accountResponse(T2, [initiator, a, b], "101");
    const p = plan(T2, [initiator, a, b]);
    const onRebuildRequest = vi.fn();
    await renderCollect(p, { onRebuildRequest });
    frame(p, signedBy(initiator, a));
    await flush();

    expect(screen.getByTestId("collect-stale").textContent).toMatch(/sequence number moved/);
    expect(screen.queryByText("Continue to final confirmation")).toBeNull();
    fireEvent.click(screen.getByTestId("collect-rebuild"));
    expect(onRebuildRequest).toHaveBeenCalledTimes(1);
  });

  it("enables the confirm once the live account matches the bundle", async () => {
    horizon.account = accountResponse(T2, [initiator, a, b]);
    const p = plan(T2, [initiator, a, b]);
    await renderCollect(p);
    frame(p, signedBy(initiator, a));
    await flush();
    const button = screen.getByTestId("collect-close") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Continue to final confirmation");
  });

  it("checks the live account once, not on every relay frame", async () => {
    horizon.account = accountResponse(T3, [initiator, a, b, c]);
    const p = plan(T2, [initiator, a, b, c]);
    await renderCollect(p);
    frame(p, signedBy(initiator, a));
    await flush();
    frame(p, signedBy(initiator, a, b));
    await flush();
    frame(p, signedBy(initiator, a, b, c));
    await flush();
    // one check reads the closing account and then the merge destination
    expect(horizon.loads).toEqual([initiator.publicKey(), destination]);
  });
});

describe("CollectSignatures memo", () => {
  it("shows the bundle's memo next to the destination", async () => {
    baseTx = buildClose(destination, Memo.id("777"));
    planId = Buffer.from(baseTx.hash()).toString("hex");
    await renderCollect(plan(T2, [initiator, a]));
    expect(screen.getByTestId("collect-memo").textContent).toBe("Memo (ID): 777");
  });

  it("says when the bundle carries no memo", async () => {
    await renderCollect(plan(T2, [initiator, a]));
    expect(screen.getByTestId("collect-memo").textContent).toBe("No memo");
  });
});

describe("CollectSignatures relay envelopes", () => {
  it("ignores a live frame that carries a different transaction", async () => {
    horizon.account = accountResponse(T2, [initiator, a, b]);
    const p = plan(T2, [initiator, a, b]);
    const onClose = await renderCollect(p);
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(initiator, a);
    frame(p, swapped.toXdr());

    expect(signedBadges()).toBe(1);
    expect(screen.getByTestId("collect-envelope-error").textContent).toMatch(
      /different transaction/,
    );
    expect(screen.queryByText("Continue to final confirmation")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a signature that arrived live when a stale sign response comes back later", async () => {
    const p = plan(T3, [initiator, a, b, c]);
    await renderCollect(p);
    frame(p, signedBy(initiator, b));
    expect(signedBadges()).toBe(2);

    // the post response was computed before b's signature merged on the relay
    relay.submitSignature.mockResolvedValue({ ...p, xdr: signedBy(initiator, a) });
    fireEvent.change(screen.getByTestId("collect-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-sign-local"));
    });
    await flush();

    expect(relay.submitSignature).toHaveBeenCalledTimes(1);
    expect(signedBadges()).toBe(3);
  });

  it("says in words who just signed (I-18)", async () => {
    const p = plan(T3, [initiator, a, b, c]);
    await renderCollect(p);
    relay.submitSignature.mockResolvedValue({ ...p, xdr: signedBy(initiator, a) });
    fireEvent.change(screen.getByTestId("collect-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-sign-local"));
    });
    await flush();
    const status = screen.getByText(/^Signed as /);
    expect(status.textContent).not.toMatch(/\u2713/);
  });

  it("ignores a sign response for a different transaction", async () => {
    const p = plan(T3, [initiator, a, b, c]);
    await renderCollect(p);
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(initiator, a, b);
    relay.submitSignature.mockResolvedValue({ ...p, xdr: swapped.toXdr() });
    fireEvent.change(screen.getByTestId("collect-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-sign-local"));
    });
    await flush();
    expect(signedBadges()).toBe(1);
    expect(screen.getByRole("alert").textContent).toMatch(/different transaction/);
  });

  it("refuses to start when the request id is not the hash of the reviewed transaction", () => {
    render(
      <CollectSignatures
        planId={"00".repeat(32)}
        audit={audit([initiator, a])}
        network={network}
        initialXdr={signedBy(initiator)}
        destination={destination}
        connectedKey={initiator.publicKey()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("collect-envelope-error")).toBeTruthy();
    expect(screen.queryByTestId("collect-link")).toBeNull();
    expect(relay.fetchPlan).not.toHaveBeenCalled();
  });
});

describe("CollectSignatures expired request", () => {
  it("offers to publish again only when the relay no longer has the request", async () => {
    const p = plan(T2, [initiator, a, b]);
    await renderCollect(p);
    act(() => relay.onStatus?.({ mode: "polling", terminal: false }));
    act(() => relay.onStatus?.({ mode: "gone", terminal: true }));

    relay.fetchPlan.mockRejectedValue(new Error("Request failed (502)."));
    await act(async () => {
      fireEvent.click(screen.getByText("Refresh"));
    });
    expect(screen.getByTestId("collect-refresh-error").textContent).toMatch(/502/);
    expect(screen.queryByTestId("collect-republish")).toBeNull();

    relay.fetchPlan.mockRejectedValue(
      new PlanNotFoundError("This signing request no longer exists."),
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Refresh"));
    });
    expect(screen.getByTestId("collect-refresh-error").textContent).toMatch(/no longer exists/);

    relay.publishPlan.mockResolvedValue(planId);
    relay.fetchPlan.mockResolvedValue(p);
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-republish"));
    });
    await flush();
    expect(relay.publishPlan).toHaveBeenCalledWith("testnet", signedBy(initiator));
    expect(screen.queryByTestId("collect-refresh-error")).toBeNull();
  });

  it("says so when the request is already gone at load", async () => {
    relay.fetchPlan.mockRejectedValue(new PlanNotFoundError("gone"));
    render(
      <CollectSignatures
        planId={planId}
        audit={audit([initiator, a])}
        network={network}
        initialXdr={signedBy(initiator)}
        destination={destination}
        connectedKey={initiator.publicKey()}
        onClose={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByTestId("collect-refresh-error").textContent).toMatch(/gone/);
    expect(screen.getByTestId("collect-republish")).toBeTruthy();
  });
});

describe("CollectSignatures copy link", () => {
  it("does not claim Copied when the clipboard is unavailable", async () => {
    await renderCollect(plan(T2, [initiator, a]));
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId("collect-copy"));
      });
      expect(screen.getByTestId("collect-copy").textContent).not.toBe("Copied");
      expect(screen.getByTestId("collect-copy-error")).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });

  it("does not claim Copied when the clipboard write is rejected", async () => {
    await renderCollect(plan(T2, [initiator, a]));
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId("collect-copy"));
      });
      expect(writeText).toHaveBeenCalled();
      expect(screen.getByTestId("collect-copy").textContent).not.toBe("Copied");
      expect(screen.getByTestId("collect-copy-error")).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("CollectSignatures seed input", () => {
  it("asks password managers to skip the signer key field", async () => {
    await renderCollect(plan(T2, [initiator, a]));
    const input = screen.getByTestId("collect-secret");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.getAttribute("data-bwignore")).not.toBeNull();
    expect(input.getAttribute("data-form-type")).toBe("other");
  });
});
