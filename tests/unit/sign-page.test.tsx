// @vitest-environment happy-dom

import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  NotFoundError,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the relay and horizon are network boundaries and are faked; envelope decoding,
// hashing, signing and signature accounting all run for real.
type Update = (plan: { network: string; xdr: string }) => void;
const relay = {
  update: null as Update | null,
  plan: null as { network: string; xdr: string } | null,
  submitSignature: vi.fn(),
};
vi.mock("@/lib/multisig/plan-client", () => ({
  fetchPlan: async () => {
    if (relay.plan === null) throw new Error("gone");
    return relay.plan;
  },
  subscribePlan: (_id: string, onUpdate: Update) => {
    relay.update = onUpdate;
    return () => {};
  },
  submitSignature: (...args: unknown[]) => relay.submitSignature(...args),
}));

const horizon = {
  loadAccount: vi.fn(),
  transaction: vi.fn(),
};
vi.mock("@/lib/stellar/horizon-client", () => ({
  getHorizon: () => ({
    loadAccount: (...args: unknown[]) => horizon.loadAccount(...args),
    transactions: () => ({
      transaction: (id: string) => ({ call: () => horizon.transaction(id) }),
    }),
  }),
}));

// the page chrome and the wallet-kit path pull in browser wallet modules that
// don't load under happy-dom; these tests sign with a pasted key instead
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/lib/wallet/connector", () => ({
  WalletKitConnector: class {
    connect(): Promise<never> {
      return Promise.reject(new Error("wallet kit is not available in this test"));
    }
  },
}));

import SignPage from "@/app/sign/page";

const NET = Networks.TESTNET;
const owner = Keypair.random();
const a = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();
const destination = Keypair.random().publicKey();

function buildClose(dest = destination): Transaction {
  return new TransactionBuilder(new Account(owner.publicKey(), "7"), {
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

function accountResponse(high: number, keys: readonly Keypair[]): Horizon.AccountResponse {
  return new Horizon.AccountResponse({
    id: owner.publicKey(),
    account_id: owner.publicKey(),
    sequence: "7",
    subentry_count: 0,
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: high },
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    balances: [],
    data: {},
    flags: {},
  } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
}

function signedBadges(): number {
  return screen.queryAllByText("Signed").length;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function openPage(): Promise<void> {
  render(<SignPage />);
  await settle();
  await settle();
}

beforeEach(() => {
  window.history.replaceState({}, "", `/sign?id=${planId}`);
  relay.update = null;
  relay.plan = { network: "testnet", xdr: signedBy(owner) };
  relay.submitSignature.mockReset();
  horizon.loadAccount.mockReset();
  horizon.transaction.mockReset();
  horizon.loadAccount.mockResolvedValue(accountResponse(3, [owner, a, b, c]));
});

afterEach(cleanup);

describe("/sign relay envelopes", () => {
  it("ignores a live frame for a different transaction and still signs the linked one", async () => {
    await openPage();
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(owner);
    act(() => relay.update?.({ network: "testnet", xdr: swapped.toXdr() }));

    expect(screen.getByTestId("sign-envelope-error").textContent).toMatch(/different transaction/);
    expect(screen.getByText(destination)).toBeTruthy();

    relay.submitSignature.mockResolvedValue({ network: "testnet", xdr: signedBy(owner, a) });
    fireEvent.change(screen.getByTestId("sign-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-secret-submit"));
    });
    await settle();
    const posted = relay.submitSignature.mock.calls[0]![1] as string;
    const postedTx = TransactionBuilder.fromXdr(posted, NET) as Transaction;
    expect(Buffer.from(postedTx.hash()).toString("hex")).toBe(planId);
  });

  it("ignores a sign response for a different transaction", async () => {
    await openPage();
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(owner, a, b, c);
    relay.submitSignature.mockResolvedValue({ network: "testnet", xdr: swapped.toXdr() });
    fireEvent.change(screen.getByTestId("sign-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-secret-submit"));
    });
    await settle();
    expect(signedBadges()).toBe(1);
    expect(screen.getByText(destination)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/different transaction/);
  });

  it("keeps a signature that arrived live when a stale sign response comes back later", async () => {
    await openPage();
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(owner, b) }));
    expect(signedBadges()).toBe(2);
    relay.submitSignature.mockResolvedValue({ network: "testnet", xdr: signedBy(owner, a) });
    fireEvent.change(screen.getByTestId("sign-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-secret-submit"));
    });
    await settle();
    expect(signedBadges()).toBe(3);
  });

  it("loads the signer list once, not on every live frame", async () => {
    await openPage();
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(owner, a) }));
    await settle();
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(owner, a, b) }));
    await settle();
    expect(horizon.loadAccount).toHaveBeenCalledTimes(1);
  });
});

describe("/sign threshold", () => {
  it("hides the sign form once enough signatures are in", async () => {
    horizon.loadAccount.mockResolvedValue(accountResponse(2, [owner, a, b]));
    await openPage();
    expect(screen.queryByTestId("sign-secret")).not.toBeNull();
    act(() => relay.update?.({ network: "testnet", xdr: signedBy(owner, a) }));
    expect(screen.queryByTestId("sign-secret")).toBeNull();
    expect(screen.getByText(/Enough signatures collected/)).toBeTruthy();
  });

  it("uses the largest of the account's thresholds", async () => {
    const raw = accountResponse(2, [owner, a, b, c]);
    (raw.thresholds as { med_threshold: number }).med_threshold = 3;
    horizon.loadAccount.mockResolvedValue(raw);
    await openPage();
    expect(screen.getByTestId("sign-progress").textContent).toBe("1 of 3");
  });
});

describe("/sign after the account is gone", () => {
  it("says the account was closed by this transaction and hides the form", async () => {
    horizon.loadAccount.mockRejectedValue(new NotFoundError("not found", {}));
    horizon.transaction.mockResolvedValue({ id: planId, hash: planId, successful: true });
    await openPage();
    await settle();
    expect(horizon.transaction).toHaveBeenCalledWith(planId);
    expect(screen.getByTestId("sign-closed").textContent).toMatch(/already closed/);
    expect(screen.queryByTestId("sign-secret")).toBeNull();
    expect(screen.queryByText(/will count once/)).toBeNull();
  });

  it("says the account no longer exists when this transaction isn't on chain", async () => {
    horizon.loadAccount.mockRejectedValue(new NotFoundError("not found", {}));
    horizon.transaction.mockRejectedValue(new NotFoundError("not found", {}));
    await openPage();
    await settle();
    expect(screen.getByTestId("sign-closed").textContent).toMatch(/no longer exists/);
    expect(screen.queryByTestId("sign-secret")).toBeNull();
  });
});

describe("/sign seed input", () => {
  it("asks password managers to skip the secret key field", async () => {
    await openPage();
    const input = screen.getByTestId("sign-secret");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("data-1p-ignore")).not.toBeNull();
    expect(input.getAttribute("data-lpignore")).toBe("true");
  });
});
