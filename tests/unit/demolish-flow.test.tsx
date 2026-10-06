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
import type { EmissionForfeit, RefusedConversion } from "@/lib/orchestrator/page-flow-machine";

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
    readonly reason?: "no_path" | "price_impact" | "unpriced" | "requote_worse";
    readonly priceImpactBps?: number;
  }[];
  readonly reviewBlockers?: readonly string[];
  readonly refusedConversions?: readonly RefusedConversion[];
  readonly emissionForfeits?: readonly EmissionForfeit[];
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
  execute: null as null | ((tree: PlanTree, input: Record<string, unknown>) => Promise<unknown>),
  previewInputs: [] as Record<string, unknown>[],
  // what the publish-time position re-probe answers
  probe: null as null | (() => Promise<ProtocolPositions>),
  // data entries of the destination account, as Horizon reports them
  destinationData: {} as Record<string, string>,
  // the last 4 the collector's confirmation hands back
  typedTail: "",
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
        // the signing request is built on this account's next sequence; the
        // destination check reads its SEP-29 data entries
        loadAccount: async (id: string) =>
          Object.assign(new SdkAccount(id, "4100"), {
            data_attr: id === ACC ? {} : ctl.destinationData,
          }),
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
  const { requireNetwork } = await import("@/lib/config/networks");
  return {
    publishPlan: async (network: string, xdr: string) => {
      ctl.published.push({ network, xdr });
      const tx = sdk.TransactionBuilder.fromXdr(xdr, requireNetwork(network).passphrase);
      return Buffer.from(tx.hash()).toString("hex");
    },
    fetchPlan: async () => {
      if (ctl.relayXdr === null) throw new Error("relay unreachable");
      return {
        network: "testnet",
        xdr: ctl.relayXdr,
        account: ACC,
        signers: [
          { key: ACC, weight: 1 },
          { key: DEST, weight: 1 },
        ],
        thresholds: { low: 2, med: 2, high: 2 },
        expiresAt: Date.now() + 3_600_000,
      };
    },
  };
});
vi.mock("@/lib/adapters/positions/direct", async () => {
  const fx = await import("./demolish-fixtures");
  return {
    DirectContractProvider: class {
      async getPositions() {
        return ctl.probe === null ? fx.emptyPositions() : ctl.probe();
      }
    },
  };
});
// the live signature collector talks to the relay; here it only has to show up,
// and a button stands in for the signers finishing
vi.mock("@/components/multisig/CollectSignatures", () => ({
  CollectSignatures: ({
    planId,
    onClose,
  }: {
    planId: string;
    onClose: (signedXdr: string, typed: string) => void;
  }) => (
    <div>
      <div data-testid="collect-stub">{planId}</div>
      <button
        type="button"
        data-testid="collect-close"
        onClick={() => onClose(ctl.relayXdr ?? "", ctl.typedTail)}
      />
    </div>
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
        execute: fromPromise(
          async ({ input }: { input: { tree: PlanTree } & Record<string, unknown> }) =>
            ctl.execute!(input.tree, input),
        ) as never,
      },
    }),
  };
});

import { DemolishFlow } from "@/app/demolish/_components/DemolishFlow";
import { TESTNET } from "@/lib/config/networks";
import { setActiveConnector } from "@/lib/wallet/active-connector";
import { useCloseBusy } from "@/stores/close-busy";
import { useNetworkStore } from "@/stores/network";
import { useWalletStore } from "@/stores/wallet";

const connector: Connector = {
  kind: "secret",
  connect: async () => ({ publicKey: ACC }),
  disconnect: async () => {},
  getPublicKey: async () => ACC,
  // the relay is mocked, so an unsigned envelope stands in for the signed one
  signTransaction: async (tx) => ({ signedXdr: tx.toXdr(), signerPublicKey: ACC }),
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
  ctl.probe = null;
  ctl.destinationData = {};
  ctl.typedTail = "";
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

async function confirmTyped(): Promise<void> {
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
}

describe("the position re-probe runs before a signing request is published (C-08)", () => {
  async function createRequest(): Promise<void> {
    setUpSharedAccount();
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    fireEvent.click(await screen.findByTestId("review-create-request"));
  }

  it("refuses when a backstop is still queued", async () => {
    ctl.probe = async () =>
      emptyPositions({ backstop: [{ poolId: "P", shares: 0n, queuedForWithdrawal: 5n }] });
    await createRequest();
    expect((await screen.findByRole("alert")).textContent).toMatch(/open DeFi position/);
    expect(ctl.published).toHaveLength(0);
  });

  it("refuses when the probe recorded an error", async () => {
    ctl.probe = async () =>
      emptyPositions({ errors: [{ protocol: "Blend", message: "rpc down" }] });
    await createRequest();
    expect((await screen.findByRole("alert")).textContent).toMatch(/rpc down/);
    expect(ctl.published).toHaveLength(0);
  });

  it("refuses when the probe throws", async () => {
    ctl.probe = async () => {
      throw new Error("probe timed out");
    };
    await createRequest();
    expect((await screen.findByRole("alert")).textContent).toMatch(/probe timed out/);
    expect(ctl.published).toHaveLength(0);
  });
});

describe("the collected bundle is submitted bound to the reviewed close (M-41, M-63)", () => {
  it("sends the typed tail, the request id and the relay's signer set", async () => {
    setUpSharedAccount();
    ctl.execute = async (tree) => ({ result: { ok: true, errors: [], mergedTxHash: "aa" }, tree });
    const seen: Record<string, unknown>[] = [];
    const run = ctl.execute;
    ctl.execute = async (tree, input) => {
      seen.push(input);
      return run(tree, input);
    };
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    fireEvent.click(await screen.findByTestId("review-create-request"));
    const planId = (await screen.findByTestId("collect-stub")).textContent ?? "";
    ctl.relayXdr = ctl.published[0]!.xdr;

    // a wrong tail is refused and said so
    ctl.typedTail = "XXXX";
    fireEvent.click(screen.getByTestId("collect-close"));
    expect((await screen.findByTestId("flow-error")).textContent).toMatch(/doesn't match/);
    expect(state()).toBe("awaiting_confirmation");

    ctl.typedTail = DEST.slice(-4);
    fireEvent.click(screen.getByTestId("collect-close"));
    await waitFor(() => expect(state()).not.toBe("awaiting_confirmation"));
    expect(seen).toHaveLength(1);
    const bundle = seen[0]!["bundle"] as { signedXdr: string; snapshot: { signers: unknown[] } };
    expect(bundle.signedXdr).toBe(ctl.relayXdr);
    expect(bundle.snapshot.signers).toHaveLength(2);
    expect(planId).toBe(
      Buffer.from(
        (TransactionBuilder.fromXdr(ctl.relayXdr, TESTNET.passphrase) as Transaction).hash(),
      ).toString("hex"),
    );
  });
});

describe("a memo-required destination is found before the close starts (H-15, L-24)", () => {
  it("asks for a memo and routes through the mediator for an unlisted SEP-29 account", async () => {
    ctl.destinationData = { "config.memo_required": "MQ==" };
    connect();
    render(<DemolishFlow />);
    const input = await screen.findByTestId("destination-input");
    fireEvent.change(input, { target: { value: DEST } });
    await waitFor(
      () =>
        expect(screen.getByTestId("demolish-start-hint").textContent).toMatch(/requires a memo/i),
      { timeout: 3000 },
    );
    const start = screen.getByTestId("demolish-start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Memo type" }));
    fireEvent.click(await screen.findByRole("option", { name: "Text" }));
    fireEvent.change(screen.getByTestId("memo-value-input"), { target: { value: "deposit-42" } });
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(1));
    expect(ctl.previewInputs[0]!["useMediator"]).toBe(true);
    expect(ctl.previewInputs[0]!["memo"]).toEqual({ type: "text", value: "deposit-42" });
  });

  it("refuses an exchange's internal wallet as the destination", async () => {
    connect();
    render(<DemolishFlow />);
    const input = await screen.findByTestId("destination-input");
    fireEvent.change(input, {
      target: { value: "GAGL7APMF7BZT6AVGNLBXKCMEHHLKPOL6PADWSLWFVYULGHPQQSIUU2W" },
    });
    await waitFor(
      () =>
        expect(screen.getByTestId("demolish-start-hint").textContent).toMatch(
          /internal wallet, not a deposit address/,
        ),
      { timeout: 3000 },
    );
    expect((screen.getByTestId("demolish-start") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a close that can't start says why (H-05)", () => {
  it("lists the preview's blockers in the Resolve step", async () => {
    ctl.preview = async () => ({
      tree: makeTree(),
      unroutableCredits: [],
      reviewBlockers: ["Your BLND trustline is not authorized by its issuer."],
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    expect((await screen.findByTestId("blockers")).textContent).toMatch(/BLND trustline/);
    expect(screen.queryByTestId("demolish-confirm")).toBeNull();
  });
});

describe("refused conversions are decided per asset (decision 3, M-18, M-19)", () => {
  it("sells a credit over the price-impact cap only once accepted", async () => {
    const key = "USDC:GISSUER";
    ctl.preview = async () => ({
      tree: makeTree(),
      unroutableCredits: [
        {
          key,
          code: "USDC",
          issuer: "GISSUER",
          amount: "5000.0000000",
          reason: "price_impact",
          priceImpactBps: 1680,
        },
      ],
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    expect((await screen.findByTestId(`price-choice-${key}`)).textContent).toMatch(/16\.80%/);
    fireEvent.click(screen.getByTestId(`price-accept-${key}`));
    fireEvent.click(screen.getByTestId("resolve-rebuild"));
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(2));
    expect(ctl.previewInputs[1]!["acceptedPriceImpactAssetKeys"]).toEqual([key]);
  });

  it("drops a held token the user leaves out of a refused swap", async () => {
    const token: HeldToken = { contractId: TOKEN_C, balance: 50n };
    ctl.discover = async () => ({
      audit: makeAudit(),
      positions: emptyPositions(),
      heldTokens: [token],
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    fireEvent.click(await screen.findByTestId(`held-token-${TOKEN_C}`));
    ctl.preview = async () => ({
      tree: makeTree(),
      unroutableCredits: [],
      refusedConversions: [
        { key: `contract:${TOKEN_C}`, contractId: TOKEN_C, reason: "price impact 9.00% over cap" },
      ],
    });
    fireEvent.click(screen.getByTestId("acknowledge-rebuild"));
    fireEvent.click(await screen.findByTestId(`refused-leave-${TOKEN_C}`));
    fireEvent.click(screen.getByTestId("resolve-rebuild"));
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(3));
    expect(ctl.previewInputs[2]!["selectedHeldTokens"]).toEqual([]);
  });
});

describe("unclaimable backstop emissions need a forfeit acknowledgement (L-49)", () => {
  it("shows the accrued BLND and rebuilds with the pool forfeited", async () => {
    ctl.preview = async () => ({
      tree: makeTree(),
      unroutableCredits: [],
      emissionForfeits: [
        { poolId: "CPOOL", accruedEmissions: 7_114_578_242n, reason: "HostError: trapped" },
      ],
    });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    expect((await screen.findByTestId("emission-forfeits")).textContent).toMatch(
      /711\.4578242 BLND/,
    );
    fireEvent.click(screen.getByTestId("forfeit-CPOOL"));
    fireEvent.click(screen.getByTestId("resolve-rebuild"));
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(2));
    expect(ctl.previewInputs[1]!["forfeitBackstopEmissionPoolIds"]).toEqual(["CPOOL"]);
  });
});

describe("the claim selection reaches the plan explicitly (H-11)", () => {
  it("leaves the first plan to the planner, then sends exactly the user's pick", async () => {
    const id = `00000000${"a1".repeat(32)}`;
    const audit = makeAudit({
      claimableBalances: [
        {
          id,
          asset: { kind: "native" },
          amount: "5.0000000",
          sponsor: DEST,
          predicate: [{ destination: ACC, predicate: { unconditional: true } }],
          claimants: [ACC],
          claimableNow: true,
        },
      ],
    });
    ctl.discover = async () => ({ audit, positions: emptyPositions(), heldTokens: [] });
    ctl.preview = async () => ({ tree: makeTree({ audit }), unroutableCredits: [] });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(1));
    expect(ctl.previewInputs[0]!["selectedClaimableBalanceIds"]).toBeUndefined();

    fireEvent.click(await screen.findByTestId(`cb-checkbox-${id}`));
    fireEvent.click(await screen.findByTestId("acknowledge-rebuild"));
    await waitFor(() => expect(ctl.previewInputs).toHaveLength(2));
    // unticking the only balance claims none, rather than every one
    expect(ctl.previewInputs[1]!["selectedClaimableBalanceIds"]).toEqual([]);
  });
});

describe("a retry signs with the wallet connected now (M-10)", () => {
  it("resumes a retryable failure with the current connector", async () => {
    let calls = 0;
    ctl.execute = async (tree) => {
      calls += 1;
      return calls === 1
        ? { result: { ok: false, errors: ["horizon 503"] }, tree, failureKind: "network" }
        : { result: { ok: true, errors: [], mergedTxHash: "bb" }, tree };
    };
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    await confirmTyped();
    await waitFor(() => expect(state()).toBe("failed"));
    fireEvent.click(screen.getByTestId("demolish-retry"));
    await waitFor(() => expect(state()).toBe("succeeded"));
    expect(calls).toBe(2);
  }, 20_000);

  it("holds the network switch and navigation while the close executes (M-35)", async () => {
    const gate = deferred<void>();
    ctl.execute = async (tree) => {
      await gate.promise;
      return { result: { ok: true, errors: [], mergedTxHash: "cc" }, tree };
    };
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    await confirmTyped();
    await waitFor(() => expect(state()).toBe("executing"));
    expect(useNetworkStore.getState().lockReason).toMatch(/close is running/);
    expect(useCloseBusy.getState().busy).toBe(true);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await waitFor(() => expect(state()).toBe("succeeded"));
    expect(useNetworkStore.getState().lockReason).toBeNull();
    expect(useCloseBusy.getState().busy).toBe(false);
  }, 20_000);
});

describe("a run that only prepares the close (M-25)", () => {
  it("says the account is still open and keeps the wallet connected", async () => {
    const unlocksAt = new Date(Date.now() + 17 * 86_400_000);
    const prepared = (): PlanTree => ({
      ...makeTree(),
      allNodes: new Map(),
      rootNodes: [],
      prepareOnly: { unlocksAt, reason: "A Blend backstop withdrawal stays locked." },
    });
    ctl.preview = async () => ({ tree: prepared(), unroutableCredits: [] });
    ctl.execute = async (tree) => ({ result: { ok: true, errors: [] }, tree });
    connect();
    render(<DemolishFlow />);
    await configureAndStart();
    expect((await screen.findByTestId("review-prepare-only")).textContent).toMatch(
      /doesn't delete the account/,
    );
    await confirmTyped();
    await waitFor(() => expect(state()).toBe("succeeded"));
    expect((await screen.findByTestId("prepared-note")).textContent).toMatch(/still open/);
    expect(useWalletStore.getState().publicKey).toBe(ACC);
  }, 20_000);
});
