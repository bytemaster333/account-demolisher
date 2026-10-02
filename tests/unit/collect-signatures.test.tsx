// @vitest-environment happy-dom

import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the relay is a network boundary, so its browser client is replaced by a
// controllable fake. everything that reads or builds the envelope is real.
type Update = (plan: { network: string; xdr: string }) => void;
type OnError = (info: { terminal: boolean }) => void;
const relay = {
  update: null as Update | null,
  onError: null as OnError | null,
  submitSignature: vi.fn(),
  fetchPlan: vi.fn(),
  publishPlan: vi.fn(),
};
vi.mock("@/lib/multisig/plan-client", () => ({
  subscribePlan: (_id: string, onUpdate: Update, onError?: OnError) => {
    relay.update = onUpdate;
    relay.onError = onError ?? null;
    return () => {};
  },
  submitSignature: (...a: unknown[]) => relay.submitSignature(...a),
  fetchPlan: (...a: unknown[]) => relay.fetchPlan(...a),
  publishPlan: (...a: unknown[]) => relay.publishPlan(...a),
}));

// horizon is the other network boundary: the confirm step reloads the account's
// current signers and thresholds from it
const horizon = { account: null as Horizon.AccountResponse | null };
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({
    loadAccount: async () => {
      if (horizon.account === null) throw new Error("no account");
      return horizon.account;
    },
  }),
}));

import { CollectSignatures } from "@/components/multisig/CollectSignatures";
import { resolveNetwork } from "@/lib/config/networks";
import type { AccountAudit } from "@/lib/types/account";

const network = resolveNetwork("testnet");
const NET = Networks.TESTNET;

const initiator = Keypair.random();
const a = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();
const destination = Keypair.random().publicKey();

function buildClose(dest = destination): Transaction {
  return new TransactionBuilder(new Account(initiator.publicKey(), "100"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  })
    .addOperation(Operation.accountMerge({ destination: dest }))
    .build();
}

const baseTx = buildClose();
const planId = Buffer.from(baseTx.hash()).toString("hex");

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

function accountResponse(high: number, keys: readonly Keypair[]): Horizon.AccountResponse {
  return new Horizon.AccountResponse({
    id: initiator.publicKey(),
    account_id: initiator.publicKey(),
    sequence: "100",
    subentry_count: 0,
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: high },
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    balances: [],
    data: {},
    flags: {},
  } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
}

function audit(high: number, keys: readonly Keypair[]): AccountAudit {
  return {
    accountId: initiator.publicKey(),
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    thresholds: { low: 1, medium: 1, high, masterWeight: 1 },
  } as unknown as AccountAudit;
}

function renderCollect(high: number, keys: readonly Keypair[], onClose = vi.fn()) {
  render(
    <CollectSignatures
      planId={planId}
      audit={audit(high, keys)}
      network={network}
      initialXdr={signedBy(initiator)}
      destination={destination}
      connectedKey={initiator.publicKey()}
      onClose={onClose}
    />,
  );
  return onClose;
}

function signedBadges(): number {
  return Array.from(screen.getByTestId("collect-signers").querySelectorAll("span")).filter(
    (s) => s.textContent === "Signed",
  ).length;
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
  // let the horizon reload and trim settle
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  relay.update = null;
  relay.onError = null;
  relay.submitSignature.mockReset();
  relay.fetchPlan.mockReset();
  relay.publishPlan.mockReset();
  horizon.account = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CollectSignatures bundle hand-off", () => {
  it("hands up only the signatures core will use when more than the threshold signed", async () => {
    horizon.account = accountResponse(2, [initiator, a, b]);
    const onClose = renderCollect(2, [initiator, a, b]);
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(initiator, a, b) }));
    expect(signedBadges()).toBe(3);

    await confirmClose();

    expect(onClose).toHaveBeenCalledTimes(1);
    const handed = onClose.mock.calls[0]![0] as string;
    expect(signerKeysOf(handed)).toEqual([initiator.publicKey(), a.publicKey()]);
  });

  it("drops a signature from a key that is no longer a signer and refuses when the rest fall short", async () => {
    // b was removed from the account after the request was published
    horizon.account = accountResponse(2, [initiator, a]);
    const onClose = renderCollect(2, [initiator, a, b]);
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(initiator, b) }));

    await confirmClose();

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("collect-close-error").textContent).toMatch(/needs 2/);
  });

  it("stops offering local signing once the threshold is met", () => {
    renderCollect(2, [initiator, a, b]);
    expect(screen.queryByTestId("collect-secret")).not.toBeNull();
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(initiator, a) }));
    expect(screen.queryByTestId("collect-secret")).toBeNull();
    expect(screen.queryByText(/more signatures are optional/)).toBeNull();
    expect(screen.getByText(/Enough signatures collected/)).toBeTruthy();
  });
});

describe("CollectSignatures relay envelopes", () => {
  it("ignores a live frame that carries a different transaction", async () => {
    horizon.account = accountResponse(2, [initiator, a, b]);
    const onClose = renderCollect(2, [initiator, a, b]);
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(initiator, a);
    act(() => relay.update?.({ network: "testnet", xdr: swapped.toXdr() }));

    expect(signedBadges()).toBe(1);
    expect(screen.getByTestId("collect-envelope-error").textContent).toMatch(
      /different transaction/,
    );
    expect(screen.queryByText("Continue to final confirmation")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a signature that arrived live when a stale sign response comes back later", async () => {
    renderCollect(3, [initiator, a, b, c]);
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(initiator, b) }));
    expect(signedBadges()).toBe(2);

    // the post response was computed before b's signature merged on the relay
    relay.submitSignature.mockResolvedValue({ network: "testnet", xdr: signedBy(initiator, a) });
    fireEvent.change(screen.getByTestId("collect-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-sign-local"));
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(relay.submitSignature).toHaveBeenCalledTimes(1);
    expect(signedBadges()).toBe(3);
  });

  it("ignores a sign response for a different transaction", async () => {
    renderCollect(3, [initiator, a, b, c]);
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(initiator, a, b);
    relay.submitSignature.mockResolvedValue({ network: "testnet", xdr: swapped.toXdr() });
    fireEvent.change(screen.getByTestId("collect-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-sign-local"));
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(signedBadges()).toBe(1);
    expect(screen.getByRole("alert").textContent).toMatch(/different transaction/);
  });

  it("refuses to start when the request id is not the hash of the reviewed transaction", () => {
    render(
      <CollectSignatures
        planId={"00".repeat(32)}
        audit={audit(2, [initiator, a])}
        network={network}
        initialXdr={signedBy(initiator)}
        destination={destination}
        connectedKey={initiator.publicKey()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("collect-envelope-error")).toBeTruthy();
    expect(screen.queryByTestId("collect-link")).toBeNull();
  });
});

describe("CollectSignatures expired request", () => {
  it("shows why a refresh failed and re-publishes the held envelope", async () => {
    renderCollect(2, [initiator, a, b]);
    act(() => relay.onError?.({ terminal: true }));
    relay.fetchPlan.mockRejectedValue(new Error("This signing request no longer exists."));
    await act(async () => {
      fireEvent.click(screen.getByText("Refresh"));
    });
    expect(screen.getByTestId("collect-refresh-error").textContent).toMatch(/no longer exists/);

    relay.publishPlan.mockResolvedValue(planId);
    await act(async () => {
      fireEvent.click(screen.getByTestId("collect-republish"));
    });
    expect(relay.publishPlan).toHaveBeenCalledWith("testnet", signedBy(initiator));
    expect(screen.queryByTestId("collect-refresh-error")).toBeNull();
  });
});

describe("CollectSignatures copy link", () => {
  it("does not claim Copied when the clipboard is unavailable", async () => {
    renderCollect(2, [initiator, a]);
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
    renderCollect(2, [initiator, a]);
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
  it("asks password managers to skip the signer key field", () => {
    renderCollect(2, [initiator, a]);
    const input = screen.getByTestId("collect-secret");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(input.getAttribute("data-lpignore")).toBe("true");
    expect(input.getAttribute("data-bwignore")).not.toBeNull();
    expect(input.getAttribute("data-form-type")).toBe("other");
  });
});
