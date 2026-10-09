// @vitest-environment happy-dom

import {
  Account,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  NotFoundError,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RelayPlan } from "@/lib/multisig/plan-client";

// the relay and horizon are network boundaries and are faked; envelope decoding,
// hashing, signing, the freshness comparison and signature accounting all run
// for real.
type Update = (plan: RelayPlan) => void;
const relay = {
  update: null as Update | null,
  plan: null as RelayPlan | null,
  submitSignature: vi.fn(),
};
vi.mock("@/lib/multisig/plan-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/multisig/plan-client")>()),
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
    offers: () => ({
      forAccount: () => ({ limit: () => ({ call: async () => ({ records: [] }) }) }),
    }),
  }),
}));

// the page chrome pulls in browser wallet modules that don't load under
// happy-dom. the wallet path is faked at the scoped-session boundary: the fake
// signs with a key and can report a failed teardown, the way the kit would.
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const wallet = {
  keypair: null as Keypair | null,
  teardownError: null as Error | null,
  sessions: 0,
  // the signal the page hands the session, aborted when the page goes away
  left: null as AbortSignal | null,
  // when set, the wallet picker waits for it
  picker: null as Promise<void> | null,
};
vi.mock("@/lib/wallet/connector", () => ({
  withScopedKitSession: async (
    _network: unknown,
    run: (connector: unknown) => Promise<unknown>,
    onTeardownError: (e: unknown) => void,
    left?: AbortSignal,
  ) => {
    wallet.sessions += 1;
    wallet.left = left ?? null;
    const connector = {
      connect: async () => {
        if (wallet.picker) await wallet.picker;
        return { publicKey: wallet.keypair!.publicKey() };
      },
      signTransaction: async (tx: Transaction) => {
        tx.sign(wallet.keypair!);
        return { signedXdr: tx.toXdr(), signerPublicKey: wallet.keypair!.publicKey() };
      },
    };
    const value = await run(connector);
    if (wallet.teardownError) onTeardownError(wallet.teardownError);
    return value;
  },
}));
const beacon = { visits: [] as unknown[][] };
vi.mock("@/lib/metrics/beacon", () => ({
  trackVisit: (...args: unknown[]) => beacon.visits.push(args),
}));

import SignPage from "@/app/sign/page";

const NET = Networks.TESTNET;
const owner = Keypair.random();
const a = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();
const destination = Keypair.random().publicKey();

type Build = (builder: TransactionBuilder) => TransactionBuilder;

function buildClose(dest = destination, extra: Build = (x) => x): Transaction {
  const builder = new TransactionBuilder(new Account(owner.publicKey(), "7"), {
    fee: BASE_FEE,
    networkPassphrase: NET,
    timebounds: { minTime: 0, maxTime: 0 },
  }).addOperation(Operation.accountMerge({ destination: dest }));
  return extra(builder).build();
}

let baseTx = buildClose();
let planId = Buffer.from(baseTx.hash()).toString("hex");

function useTx(tx: Transaction): void {
  baseTx = tx;
  planId = Buffer.from(tx.hash()).toString("hex");
  window.history.replaceState({}, "", `/sign?id=${planId}`);
}

function signedBy(...kps: Keypair[]): string {
  const tx = TransactionBuilder.fromXdr(baseTx.toXdr(), NET) as Transaction;
  for (const kp of kps) tx.sign(kp);
  return tx.toXdr();
}

type T = { low: number; med: number; high: number };

function relayPlan(t: T, keys: readonly Keypair[], xdr = signedBy(owner)): RelayPlan {
  return {
    network: "testnet",
    xdr,
    account: owner.publicKey(),
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1 })),
    thresholds: t,
    expiresAt: Date.now() + 2 * 3_600_000,
  };
}

function accountResponse(t: T, keys: readonly Keypair[]): Horizon.AccountResponse {
  return new Horizon.AccountResponse({
    id: owner.publicKey(),
    account_id: owner.publicKey(),
    sequence: "7",
    subentry_count: 0,
    thresholds: { low_threshold: t.low, med_threshold: t.med, high_threshold: t.high },
    signers: keys.map((k) => ({ key: k.publicKey(), weight: 1, type: "ed25519_public_key" })),
    balances: [],
    data: {},
    flags: {},
  } as unknown as ConstructorParameters<typeof Horizon.AccountResponse>[0]);
}

function frame(xdr: string): void {
  act(() => relay.update?.({ ...relay.plan!, xdr }));
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
  await settle();
}

const T3: T = { low: 1, med: 1, high: 3 };
const T2: T = { low: 1, med: 1, high: 2 };

beforeEach(() => {
  useTx(buildClose());
  relay.update = null;
  relay.plan = relayPlan(T3, [owner, a, b, c]);
  relay.submitSignature.mockReset();
  horizon.loadAccount.mockReset();
  horizon.transaction.mockReset();
  horizon.loadAccount.mockResolvedValue(accountResponse(T3, [owner, a, b, c]));
  wallet.keypair = null;
  wallet.left = null;
  wallet.picker = null;
  wallet.teardownError = null;
  wallet.sessions = 0;
  beacon.visits = [];
});

afterEach(cleanup);

describe("/sign relay envelopes", () => {
  it("ignores a live frame for a different transaction and still signs the linked one", async () => {
    await openPage();
    const swapped = buildClose(Keypair.random().publicKey());
    swapped.sign(owner);
    frame(swapped.toXdr());

    expect(screen.getByTestId("sign-envelope-error").textContent).toMatch(/different transaction/);
    expect(screen.getAllByText(destination).length).toBeGreaterThan(0);

    relay.submitSignature.mockResolvedValue({ ...relay.plan!, xdr: signedBy(owner, a) });
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
    relay.submitSignature.mockResolvedValue({ ...relay.plan!, xdr: swapped.toXdr() });
    fireEvent.change(screen.getByTestId("sign-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-secret-submit"));
    });
    await settle();
    expect(signedBadges()).toBe(1);
    expect(screen.getByRole("alert").textContent).toMatch(/different transaction/);
  });

  it("keeps a signature that arrived live when a stale sign response comes back later", async () => {
    await openPage();
    frame(signedBy(owner, b));
    expect(signedBadges()).toBe(2);
    relay.submitSignature.mockResolvedValue({ ...relay.plan!, xdr: signedBy(owner, a) });
    fireEvent.change(screen.getByTestId("sign-secret"), { target: { value: a.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-secret-submit"));
    });
    await settle();
    expect(signedBadges()).toBe(3);
  });

  it("checks the live account once, not on every live frame", async () => {
    await openPage();
    frame(signedBy(owner, a));
    await settle();
    frame(signedBy(owner, a, b));
    await settle();
    // one check reads the closing account and then the merge destination
    expect(horizon.loadAccount.mock.calls.map((c) => c[0])).toEqual([
      owner.publicKey(),
      destination,
    ]);
  });
});

describe("/sign signer set", () => {
  it("shows the relay's signer set, and warns when the live account's differs", async () => {
    // c was removed from the account after the request was published
    horizon.loadAccount.mockResolvedValue(accountResponse(T3, [owner, a, b]));
    await openPage();
    expect(screen.getAllByText(c.publicKey()).length).toBeGreaterThan(0);
    expect(screen.getByTestId("sign-stale").textContent).toMatch(/signers or their weights/);
  });

  it("refuses a signature from a key the relay doesn't count", async () => {
    await openPage();
    const stranger = Keypair.random();
    fireEvent.change(screen.getByTestId("sign-secret"), { target: { value: stranger.secret() } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-secret-submit"));
    });
    await settle();
    expect(relay.submitSignature).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/not a signer/);
  });

  // a request evicted from the relay and published again carries a fresh
  // snapshot under the same id; the open tab must count against that one
  it("counts against the signer set of the latest relay frame", async () => {
    await openPage();
    expect(screen.getByTestId("sign-progress").textContent).toBe("1 of 3");
    act(() => relay.update?.(relayPlan(T2, [owner, a, b])));
    await settle();
    expect(screen.getByTestId("sign-progress").textContent).toBe("1 of 2");
    expect(screen.queryAllByText(c.publicKey()).length).toBe(0);
  });

  it("refuses a request whose relay snapshot is for another account", async () => {
    relay.plan = { ...relayPlan(T3, [owner, a]), account: Keypair.random().publicKey() };
    await openPage();
    expect(screen.getByText(/different account/)).toBeTruthy();
    expect(screen.queryByTestId("sign-secret")).toBeNull();
  });
});

describe("/sign threshold", () => {
  it("hides the sign form once enough signatures are in", async () => {
    relay.plan = relayPlan(T2, [owner, a, b]);
    horizon.loadAccount.mockResolvedValue(accountResponse(T2, [owner, a, b]));
    await openPage();
    expect(screen.queryByTestId("sign-secret")).not.toBeNull();
    frame(signedBy(owner, a));
    expect(screen.queryByTestId("sign-secret")).toBeNull();
    expect(screen.getByText(/Enough signatures collected/)).toBeTruthy();
  });

  it("uses the largest of the relay's three thresholds", async () => {
    relay.plan = relayPlan({ low: 1, med: 3, high: 2 }, [owner, a, b, c]);
    await openPage();
    expect(screen.getByTestId("sign-progress").textContent).toBe("1 of 3");
  });
});

describe("/sign transaction details", () => {
  it("shows the memo next to the merge destination", async () => {
    useTx(buildClose(destination, (x) => x.addMemo(Memo.id("777"))));
    relay.plan = relayPlan(T3, [owner, a, b, c]);
    await openPage();
    expect(screen.getByTestId("sign-memo").textContent).toBe("Memo (ID): 777");
  });

  it("says when there is no memo", async () => {
    await openPage();
    expect(screen.getByTestId("sign-memo").textContent).toBe("No memo");
  });

  it("shows the fee and the time left before the transaction expires", async () => {
    const maxTime = Math.floor(Date.now() / 1000) + 2 * 3600 + 120;
    useTx(
      new TransactionBuilder(new Account(owner.publicKey(), "7"), {
        fee: "250",
        networkPassphrase: NET,
        timebounds: { minTime: 0, maxTime },
      })
        .addOperation(Operation.accountMerge({ destination }))
        .build(),
    );
    relay.plan = relayPlan(T3, [owner, a, b, c]);
    await openPage();
    expect(screen.getByTestId("sign-fee").textContent).toBe("0.0000250 XLM (250 stroops)");
    expect(screen.getByTestId("sign-validity").textContent).toMatch(/expires in 2h 1m/);
    expect(screen.queryByTestId("sign-preconditions")).toBeNull();
  });

  it("calls out preconditions a close never sets", async () => {
    useTx(
      new TransactionBuilder(new Account(owner.publicKey(), "7"), {
        fee: BASE_FEE,
        networkPassphrase: NET,
        timebounds: { minTime: 0, maxTime: 0 },
        ledgerbounds: { minLedger: 10, maxLedger: 20 },
      })
        .addOperation(Operation.accountMerge({ destination }))
        .build(),
    );
    relay.plan = relayPlan(T3, [owner, a, b, c]);
    await openPage();
    const pre = screen.getByTestId("sign-preconditions").textContent ?? "";
    expect(pre).toMatch(/A close never sets these/);
    expect(pre).toMatch(/Ledgers 10 to 20/);
  });

  it("marks an operation the close builder never emits", async () => {
    useTx(
      buildClose(destination, (x) => x.addOperation(Operation.bumpSequence({ bumpTo: "1000" }))),
    );
    relay.plan = relayPlan(T3, [owner, a, b, c]);
    await openPage();
    expect(screen.getAllByTestId("sign-op-unexpected").length).toBe(1);
  });
});

describe("/sign wallet signing", () => {
  it("signs in a scoped wallet session and says when the wallet stayed connected", async () => {
    wallet.keypair = a;
    wallet.teardownError = new Error("the extension refused to disconnect");
    relay.submitSignature.mockResolvedValue({ ...relay.plan!, xdr: signedBy(owner, a) });
    await openPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-wallet"));
    });
    await settle();
    expect(wallet.sessions).toBe(1);
    expect(relay.submitSignature).toHaveBeenCalledTimes(1);
    expect(signedBadges()).toBe(2);
    const notice = screen.getByTestId("sign-teardown-notice").textContent ?? "";
    expect(notice).toMatch(/Your signature was recorded/);
    expect(notice).toMatch(/refused to disconnect/);
  });

  // the kit throws an AggregateError when several closes fail; its summary
  // names no wallet and no reason
  it("lists each reason when more than one part of the teardown failed", async () => {
    wallet.keypair = a;
    wallet.teardownError = new AggregateError(
      [new Error("relay down"), new Error("Freighter refused")],
      "the wallet could not be disconnected",
    );
    relay.submitSignature.mockResolvedValue({ ...relay.plan!, xdr: signedBy(owner, a) });
    await openPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-wallet"));
    });
    await settle();
    const notice = screen.getByTestId("sign-teardown-notice").textContent ?? "";
    expect(notice).toContain("relay down. Freighter refused.");
  });
});

describe("/sign with a hostile relay (NP5-49)", () => {
  it("ignores signatures from keys that are not signers", async () => {
    await openPage();
    const junk = () => Array.from({ length: 11 }, () => Keypair.random());
    frame(signedBy(owner, a, ...junk()));
    frame(signedBy(owner, ...junk()));
    await settle();
    expect(signedBadges()).toBe(2);
    expect(screen.getByTestId("sign-progress").textContent).toBe("2 of 3");
  });
});

describe("/sign left mid-signing (L-106)", () => {
  it("ends the scoped wallet session when the page unmounts", async () => {
    wallet.keypair = a;
    wallet.picker = new Promise<void>(() => {});
    await openPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId("sign-wallet"));
    });
    expect(wallet.left).not.toBeNull();
    expect(wallet.left!.aborted).toBe(false);
    cleanup();
    expect(wallet.left!.aborted).toBe(true);
  });
});

describe("/sign after the account is gone", () => {
  it("says the account was closed by this transaction and hides the form", async () => {
    horizon.loadAccount.mockRejectedValue(new NotFoundError("not found", {}));
    horizon.transaction.mockResolvedValue({ id: planId, hash: planId, successful: true });
    await openPage();
    expect(horizon.transaction).toHaveBeenCalledWith(planId);
    expect(screen.getByTestId("sign-closed").textContent).toMatch(/already closed/);
    expect(screen.queryByTestId("sign-secret")).toBeNull();
  });

  it("says the account no longer exists when this transaction isn't on chain", async () => {
    horizon.loadAccount.mockRejectedValue(new NotFoundError("not found", {}));
    horizon.transaction.mockRejectedValue(new NotFoundError("not found", {}));
    await openPage();
    expect(screen.getByTestId("sign-closed").textContent).toMatch(/no longer exists/);
    expect(screen.queryByTestId("sign-secret")).toBeNull();
  });
});

describe("/sign visit metric", () => {
  it("sends one sign visit on mount", async () => {
    await openPage();
    expect(beacon.visits).toEqual([["sign"]]);
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
