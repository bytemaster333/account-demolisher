// @vitest-environment happy-dom

// the demolish page as a whole: the real DemolishFlow and page-flow machine,
// with only the machine's network-bound actors (discover, preview, execute) and
// the remote reads (horizon, account audit, metrics) replaced

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { Account, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { fromPromise } from "xstate";

import type { Connector } from "@/lib/wallet/connector";
import type { PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";
import type { ProtocolPositions } from "@/lib/adapters/positions/interface";
import type { HeldToken } from "@/lib/soroban/held-tokens";

import {
  ACC,
  DEST,
  TOKEN_C,
  blendPositions,
  emptyPositions,
  makeAudit,
  makeTree,
} from "./demolish-fixtures";

interface Discovered {
  readonly audit: AccountAudit;
  readonly positions: ProtocolPositions;
  readonly heldTokens: readonly HeldToken[];
}
interface Previewed {
  readonly tree: PlanTree;
  readonly unroutableCredits: readonly {
    readonly key: string;
    readonly code: string;
    readonly issuer: string;
    readonly amount: string;
  }[];
}

const ctl = vi.hoisted(() => ({
  // the network each delivered-amount read was made against
  effectNetworks: [] as string[],
  effects: [] as Record<string, unknown>[],
  published: [] as { network: string; xdr: string }[],
  relayXdr: null as string | null,
  preflightAudit: null as AccountAudit | null,
  discover: null as null | (() => Promise<Discovered>),
  preview: null as null | ((input: Record<string, unknown>) => Promise<Previewed>),
  execute: null as null | ((tree: PlanTree) => Promise<unknown>),
  previewInputs: [] as Record<string, unknown>[],
}));

vi.mock("@/components/wallet/ConnectButton", () => ({
  ConnectButton: () => <button type="button">connect-wallet</button>,
}));
vi.mock("@/components/wallet/SecretKeyFallback", () => ({ SecretKeyFallback: () => null }));
vi.mock("@/components/wallet/CreateTestAccountButton", () => ({
  CreateTestAccountButton: () => null,
}));
// the wallets kit doesn't load in this environment; nothing here signs through it
vi.mock("@/lib/wallet/kit", () => ({
  getKit: () => ({}),
  ensureWalletConnectReady: async () => {},
  disconnectKit: async () => {},
  restoreKitSession: async () => null,
}));
vi.mock("@/lib/metrics/beacon", () => ({
  trackVisit: () => {},
  trackFunnel: () => {},
  trackClose: () => {},
}));
vi.mock("@/lib/stellar/horizon-client", async () => {
  const { Account: SdkAccount } = await import("@stellar/stellar-sdk");
  return {
    getHorizon: (network: { id: string }) => {
      return {
        // the signing request is built on this account's next sequence
        loadAccount: async (id: string) => new SdkAccount(id, "4100"),
        ledgers: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({ records: [{ base_reserve_in_stroops: 5_000_000 }] }),
            }),
          }),
        }),
        effects: () => ({
          forTransaction: () => {
            ctl.effectNetworks.push(network.id);
            return { limit: () => ({ call: async () => ({ records: ctl.effects }) }) };
          },
        }),
      };
    },
  };
});
// the relay and the position re-probe are remote; the request built from the
// reviewed plan is what's checked
vi.mock("@/lib/multisig/plan-client", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  const { resolveNetwork } = await import("@/lib/config/networks");
  return {
    publishPlan: async (network: string, xdr: string) => {
      ctl.published.push({ network, xdr });
      const tx = sdk.TransactionBuilder.fromXdr(
        xdr,
        resolveNetwork(network as "testnet").passphrase,
      );
      return Buffer.from(tx.hash()).toString("hex");
    },
    fetchPlan: async () => {
      if (ctl.relayXdr === null) throw new Error("relay unreachable");
      return { network: "testnet", xdr: ctl.relayXdr };
    },
  };
});
vi.mock("@/lib/adapters/positions/direct", async () => {
  const fx = await import("./demolish-fixtures");
  return {
    DirectContractProvider: class {
      async getPositions() {
        return fx.emptyPositions();
      }
    },
  };
});
// the live signature collector talks to the relay; here it only has to show up
vi.mock("@/components/multisig/CollectSignatures", () => ({
  CollectSignatures: ({ planId }: { planId: string }) => (
    <div data-testid="collect-stub">{planId}</div>
  ),
}));
vi.mock("@/lib/stellar/account-audit", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/stellar/account-audit")>();
  return {
    ...orig,
    auditAccount: async () => {
      if (ctl.preflightAudit === null) throw new Error("no audit set");
      return ctl.preflightAudit;
    },
  };
});
vi.mock("@/lib/orchestrator/page-flow-machine", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/orchestrator/page-flow-machine")>();
  return {
    ...orig,
    pageFlowMachine: orig.pageFlowMachine.provide({
      actors: {
        discover: fromPromise(async () => {
          const d = await ctl.discover!();
          return {
            audit: d.audit,
            positions: d.positions,
            allowances: [],
            heldTokens: d.heldTokens,
            unreadableHeldTokens: [],
            heldTokenScanFailed: false,
            discoveryWarnings: [],
          };
        }) as never,
        preview: fromPromise(async ({ input }: { input: Record<string, unknown> }) => {
          ctl.previewInputs.push(input);
          const p = await ctl.preview!(input);
          return { ...p, heldTokenWarnings: [] };
        }) as never,
        execute: fromPromise(async ({ input }: { input: { tree: PlanTree } }) =>
          ctl.execute!(input.tree),
        ) as never,
      },
    }),
  };
});

import { DemolishFlow } from "@/app/demolish/_components/DemolishFlow";
import { TESTNET } from "@/lib/config/networks";
import { setActiveConnector } from "@/lib/wallet/active-connector";
import { useNetworkStore } from "@/stores/network";
import { useWalletStore } from "@/stores/wallet";

const connector: Connector = {
  kind: "secret",
  connect: async () => ({ publicKey: ACC }),
  disconnect: async () => {},
  getPublicKey: async () => ACC,
  // the relay is mocked, so an unsigned envelope stands in for the signed one
  signTransaction: async (tx) => ({ signedXdr: tx.toXdr(), signerPublicKey: ACC }),
  signAuthEntry: async () => {
    throw new Error("nothing is signed in these tests");
  },
};

function connect(): void {
  setActiveConnector(connector);
  useWalletStore.getState().setConnected(ACC, "secret");
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function configureAndStart(): Promise<void> {
  const input = await screen.findByTestId("destination-input");
  fireEvent.change(input, { target: { value: DEST } });
  // the destination existence check is debounced
  const start = (): HTMLButtonElement => screen.getByTestId("demolish-start") as HTMLButtonElement;
  await waitFor(() => expect(start().disabled).toBe(false), { timeout: 3000 });
  fireEvent.click(start());
}

beforeEach(() => {
  useNetworkStore.getState().setNetwork("testnet");
  window.localStorage.clear();
  ctl.effectNetworks = [];
  ctl.effects = [];
  ctl.published = [];
  ctl.relayXdr = null;
  ctl.preflightAudit = makeAudit();
  ctl.previewInputs = [];
  ctl.discover = async () => ({
    audit: makeAudit(),
    positions: emptyPositions(),
    heldTokens: [],
  });
  ctl.preview = async () => ({ tree: makeTree(), unroutableCredits: [] });
  ctl.execute = null;
});

afterEach(() => {
  cleanup();
  act(() => useWalletStore.getState().disconnect());
  setActiveConnector(null);
});

describe("retry after a non-retryable failure (M-36)", () => {
  it("shows the loading card while it rediscovers, not a blank page", async () => {
    ctl.execute = async (tree) => ({
      result: { ok: false, errors: ["WithdrawBlend failed on-chain: contract reverted"] },
      tree,
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();

    fireEvent.click(await screen.findByTestId("demolish-confirm"));
    fireEvent.change(screen.getByTestId("typed-confirmation-input"), {
      target: { value: DEST.slice(-4) },
    });
    // the confirm button only appears once the dialog's delay has run out
    const confirm = (await screen.findByTestId(
      "typed-confirmation-confirm",
      {},
      { timeout: 6000 },
    )) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await screen.findByTestId("demolish-retry");

    // the rediscovery stays pending so the screen can be checked mid-way
    const gate = deferred<Discovered>();
    ctl.discover = () => gate.promise;
    fireEvent.click(screen.getByTestId("demolish-retry"));

    expect((screen.getByTestId("machine-state") as HTMLInputElement).value).toBe("discovering");
    expect(screen.getByText("Auditing account…")).toBeTruthy();
    expect(screen.queryByTestId("demolish-status-widget")).toBeNull();
  }, 20_000);
});

describe("a refused rebuild says why (M-37)", () => {
  it("shows the refusal from Resolve when the shared close can't be bundled", async () => {
    const shared = makeAudit({
      requiresMultisig: true,
      thresholds: { low: 2, medium: 2, high: 2, masterWeight: 1 },
      signers: [
        { key: ACC, type: "ed25519_public_key", weight: 1 },
        { key: DEST, type: "ed25519_public_key", weight: 1 },
      ],
    });
    ctl.preflightAudit = shared;
    ctl.discover = async () => ({ audit: shared, positions: blendPositions(), heldTokens: [] });
    ctl.preview = async () => ({
      tree: makeTree({ audit: shared }),
      unroutableCredits: [
        { key: "USDC:GISSUER", code: "USDC", issuer: "GISSUER", amount: "5.0000000" },
      ],
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();

    fireEvent.click(await screen.findByTestId("resolve-rebuild"));
    const alert = await screen.findByTestId("flow-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(/signing request/i);
    // nothing was restarted
    expect((screen.getByTestId("machine-state") as HTMLInputElement).value).toBe(
      "awaiting_confirmation",
    );
  });
});

describe("start over clears the token conversion choice (L-57)", () => {
  it("does not carry convert-to-XLM into the next close", async () => {
    const token: HeldToken = { contractId: TOKEN_C, balance: 50n };
    ctl.discover = async () => ({
      audit: makeAudit(),
      positions: emptyPositions(),
      heldTokens: [token],
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();

    // pick the token, opt in to converting it, then rebuild; that rebuild fails
    // before a plan exists, which offers Start over
    fireEvent.click(await screen.findByTestId(`held-token-${TOKEN_C}`));
    fireEvent.click(await screen.findByTestId("held-token-convert-toggle"));
    ctl.preview = async () => {
      throw new Error("preview broke");
    };
    fireEvent.click(screen.getByTestId("acknowledge-rebuild"));
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(2));
    expect(ctl.previewInputs.at(-1)?.["convertHeldTokensToXLM"]).toBe(true);
    fireEvent.click(await screen.findByTestId("preflight-reset"));

    // a fresh close on a reconnected account, picking the same token
    ctl.preview = async () => ({ tree: makeTree(), unroutableCredits: [] });
    connect();
    await configureAndStart();
    fireEvent.click(await screen.findByTestId(`held-token-${TOKEN_C}`));
    const toggle = await screen.findByTestId("held-token-convert-toggle");
    expect((toggle as HTMLInputElement).checked ?? toggle.getAttribute("aria-checked")).not.toBe(
      true,
    );
    fireEvent.click(screen.getByTestId("acknowledge-rebuild"));
    await waitFor(() => expect(ctl.previewInputs.length).toBeGreaterThanOrEqual(4));
    expect(ctl.previewInputs.at(-1)?.["convertHeldTokensToXLM"]).toBeUndefined();
  });
});

function sharedAudit(): AccountAudit {
  return makeAudit({
    requiresMultisig: true,
    thresholds: { low: 2, medium: 2, high: 2, masterWeight: 1 },
    signers: [
      { key: ACC, type: "ed25519_public_key", weight: 1 },
      { key: DEST, type: "ed25519_public_key", weight: 1 },
    ],
  });
}

function setUpSharedAccount(): void {
  const shared = sharedAudit();
  ctl.preflightAudit = shared;
  ctl.discover = async () => ({ audit: shared, positions: emptyPositions(), heldTokens: [] });
  ctl.preview = async () => ({
    tree: makeTree({ audit: shared }),
    unroutableCredits: [],
  });
}

function state(): string {
  return (screen.getByTestId("machine-state") as HTMLInputElement).value;
}

describe("Back returns to Configure with the form kept (L-62)", () => {
  it("goes from Review to Configure without a cancelled screen", async () => {
    connect();
    render(<DemolishFlow />);
    await configureAndStart();

    fireEvent.click(await screen.findByTestId("review-back"));
    await waitFor(() => expect(state()).toBe("idle"));
    expect((screen.getByTestId("destination-input") as HTMLInputElement).value).toBe(DEST);
    expect(screen.queryByTestId("demolish-cancelled-reset")).toBeNull();
    expect(document.body.textContent).not.toMatch(/You cancelled/);
  });
});

describe("a published signing request after a wallet change (L-52)", () => {
  it("takes the collector down and says the request stays valid", async () => {
    setUpSharedAccount();
    connect();
    render(<DemolishFlow />);
    await configureAndStart();

    fireEvent.click(await screen.findByTestId("review-create-request"));
    await screen.findByTestId("collect-stub");
    expect(ctl.published).toHaveLength(1);

    act(() => useWalletStore.getState().disconnect());
    await waitFor(() => expect(state()).toBe("cancelled"));
    expect(screen.queryByTestId("collect-stub")).toBeNull();
    expect(screen.getByTestId("cancelled-request-note").textContent).toMatch(/stays valid until/);
    expect(screen.getByTestId("cancelled-request-note").textContent).toMatch(/bump sequence/);
  });
});

describe("resuming a signing request after a reload (L-54)", () => {
  async function publishThenReload(): Promise<string> {
    setUpSharedAccount();
    connect();
    const first = render(<DemolishFlow />);
    await configureAndStart();
    fireEvent.click(await screen.findByTestId("review-create-request"));
    const planId = (await screen.findByTestId("collect-stub")).textContent ?? "";
    // a reload: the page mounts again with the same wallet session
    first.unmount();
    render(<DemolishFlow />);
    await screen.findByTestId("resume-signing-request");
    return planId;
  }

  it("refuses an envelope from the relay that isn't the published request", async () => {
    await publishThenReload();
    const other = new TransactionBuilder(new Account(ACC, "9"), {
      fee: "100",
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(
        (await import("@stellar/stellar-sdk")).Operation.accountMerge({ destination: DEST }),
      )
      .setTimeout(60)
      .build() as Transaction;
    ctl.relayXdr = other.toXdr();

    fireEvent.click(screen.getByTestId("resume-request"));
    expect(
      (await screen.findByText(/different transaction from the request you published/)).textContent,
    ).toBeTruthy();
    expect(state()).toBe("idle");
    expect(screen.queryByTestId("collect-stub")).toBeNull();
  });

  it("picks the request up again when the rebuilt close matches it", async () => {
    await publishThenReload();
    ctl.relayXdr = ctl.published[0]!.xdr;
    const planId = Buffer.from(
      (TransactionBuilder.fromXdr(ctl.relayXdr, TESTNET.passphrase) as Transaction).hash(),
    ).toString("hex");

    fireEvent.click(screen.getByTestId("resume-request"));
    expect((await screen.findByTestId("collect-stub")).textContent).toBe(planId);
    // nothing new was published
    expect(ctl.published).toHaveLength(1);
  });
});

describe("a run keeps its own network after a navbar switch (M-35)", () => {
  it("links the proof and reads the delivered amount on the run's network", async () => {
    const merge = "ab".repeat(32);
    const gate = deferred<void>();
    ctl.execute = async (tree) => {
      await gate.promise;
      const final = tree.allNodes.get("final-classic-tx")!;
      final.status = "confirmed";
      final.executed = { txHash: merge, ledger: 7 };
      return { result: { ok: true, errors: [], mergedTxHash: merge }, tree };
    };
    ctl.effects = [
      { type: "account_credited", account: DEST, asset_type: "native", amount: "99.9000000" },
    ];
    connect();
    render(<DemolishFlow />);
    await configureAndStart();

    fireEvent.click(await screen.findByTestId("demolish-confirm"));
    fireEvent.change(screen.getByTestId("typed-confirmation-input"), {
      target: { value: DEST.slice(-4) },
    });
    const confirm = (await screen.findByTestId(
      "typed-confirmation-confirm",
      {},
      { timeout: 6000 },
    )) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(state()).toBe("executing"));

    act(() => useNetworkStore.getState().setNetwork("mainnet"));
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(state()).toBe("succeeded"));

    const proof = (await screen.findByTitle(
      /public record of this transaction/,
    )) as HTMLAnchorElement;
    expect(proof.href).toBe(`https://stellar.expert/explorer/testnet/tx/${merge}`);
    await screen.findByText(/99\.9 XLM/);
    expect(ctl.effectNetworks).toEqual(["testnet"]);
  }, 20_000);
});
