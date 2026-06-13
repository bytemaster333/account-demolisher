// idle
import { assign, fromPromise, setup, type ActorRefFrom } from "xstate";
import type { Horizon, rpc } from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { enumerateAllowances, type AllowanceRecord } from "@/lib/soroban/allowances";
import type { IDeFiPositionProvider, ProtocolPositions } from "@/lib/adapters/positions/interface";
import { generatePlan, type GeneratePlanOptions } from "@/lib/plan/generator";
import { hydratePlanTransactions } from "@/lib/plan/hydration";
import { simulateNode } from "@/lib/plan/simulator";
import { isSorobanNode, topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";
import { auditAccount } from "@/lib/stellar/account-audit";
import { buildClassicTransaction } from "@/lib/stellar/classic-builder";
import { batchClassicDemolition } from "@/lib/plan/classic-batcher";
import { submitMediatorForward } from "@/lib/mediator/forward";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountAudit } from "@/lib/types/account";
import type { Connector } from "@/lib/wallet/connector";

import { mergeSignatures } from "@/lib/multisig/partial-xdr";

import { applyFixup, classifyFailure, type RecoveryDecision } from "./recovery";
import type {
  DiscoveryResult,
  MultisigRequirement,
  MultisigState,
  OrchestratorContext,
  OrchestratorEvent,
  OrchestratorFailure,
  OrchestratorInput,
} from "./states";

export interface ConfirmationReceipt {
  readonly txHash: string;
  readonly ledger: number;
}

// narrow subset of horizon.server the orchestrator touches
export type HorizonLike = Pick<Horizon.Server, "loadAccount">;

// narrow subset of rpc.server used during discovery
export type RpcLike = Pick<
  rpc.Server,
  "getLatestLedger" | "getEvents" | "simulateTransaction" | "prepareTransaction"
>;

export interface OrchestratorDeps {
  readonly network: NetworkConfig;
  readonly connector: Connector;
  readonly positionProvider: IDeFiPositionProvider;
  readonly horizon: HorizonLike;
  readonly rpc: RpcLike;
  readonly submitClassic: (signedXdr: string) => Promise<ConfirmationReceipt>;
  readonly submitSoroban: (signedXdr: string) => Promise<ConfirmationReceipt>;
  readonly discover?: (publicKey: string) => Promise<DiscoveryResult>;
  readonly simulateNodeFn?: typeof simulateNode;
  readonly generatePlanFn?: (
    audit: AccountAudit,
    positions: ProtocolPositions,
    allowances: readonly AllowanceRecord[],
    destination: string,
    opts: GeneratePlanOptions,
  ) => PlanTree;
  readonly hydratePlanFn?: typeof hydratePlanTransactions;
}

interface DiscoveryOutput {
  readonly discovery: DiscoveryResult;
}

interface PreviewOutput {
  readonly tree: PlanTree;
}

interface ExecutionOutput {
  readonly receipts: Record<string, ConfirmationReceipt>;
  readonly tree: PlanTree;
}

// builds a typed xstate v5 machine bound to deps
export function createOrchestratorMachine(deps: OrchestratorDeps) {
  // discovery: parallel audit + positions + allowances reads
  const defaultDiscover = async (publicKey: string): Promise<DiscoveryResult> => {
    const [audit, positions, ledger] = await Promise.all([
      auditAccount(publicKey, deps.network),
      deps.positionProvider.getPositions(publicKey, deps.network),
      deps.rpc.getLatestLedger(),
    ]);
    const allowances = await enumerateAllowances(
      deps.rpc as unknown as rpc.Server,
      publicKey,
      ledger.sequence,
    );
    return {
      audit,
      positions,
      allowances,
      latestLedger: ledger.sequence,
    };
  };

  const discoveryActor = fromPromise<DiscoveryOutput, { publicKey: string }>(async ({ input }) => {
    const discoverFn = deps.discover ?? defaultDiscover;
    const discovery = await discoverFn(input.publicKey);
    return { discovery };
  });

  // preview: generatePlan + simulateNode in topo order; thrown errors flow
  // through the machine's onError classifier
  const previewActor = fromPromise<
    PreviewOutput,
    {
      publicKey: string;
      discovery: DiscoveryResult;
      options: OrchestratorContext["options"];
    }
  >(async ({ input }) => {
    const generate = deps.generatePlanFn ?? generatePlan;
    const generateOpts: GeneratePlanOptions = {
      ...(input.options.useMediator !== undefined
        ? { useMediator: input.options.useMediator }
        : {}),
      ...(input.options.mediatorPublicKey !== undefined
        ? { mediatorPublicKey: input.options.mediatorPublicKey }
        : {}),
      ...(input.options.selectedAllowances !== undefined
        ? { selectedAllowances: input.options.selectedAllowances }
        : {}),
      ...(input.options.selectedClaimableBalanceIds !== undefined
        ? {
            selectedClaimableBalanceIds: input.options.selectedClaimableBalanceIds,
          }
        : {}),
      ...(input.options.userFallbackAddress !== undefined
        ? { userFallbackAddress: input.options.userFallbackAddress }
        : {}),
      ...(input.options.memo !== undefined ? { memo: input.options.memo } : {}),
    };

    const tree = generate(
      input.discovery.audit,
      input.discovery.positions,
      input.discovery.allowances,
      input.options.destination,
      generateOpts,
    );

    // hydrate every soroban node
    const hydrate = deps.hydratePlanFn ?? hydratePlanTransactions;
    await hydrate(tree, input.publicKey, {
      rpc: deps.rpc as unknown as rpc.Server,
      horizon: deps.horizon as unknown as Horizon.Server,
      network: deps.network,
      currentLedger: input.discovery.latestLedger,
      fetchSourceAccount: (publicKey: string) => deps.horizon.loadAccount(publicKey),
    });

    const simulator = deps.simulateNodeFn ?? simulateNode;
    for (const node of topologicalOrder(tree)) {
      // skip nodes hydration already marked failed
      if (node.status === "failed") continue;
      // classic-only nodes simulate via their batches
      if (isSorobanNode(node) && !hasBuiltTransaction(node)) {
        // hydrator silently skipped this node — surface it as failed
        node.status = "failed";
        node.error = `hydration produced no transaction for ${node.kind} (id=${node.id})`;
        continue;
      }
      try {
        node.simulated = await simulator(node, {
          server: deps.rpc as unknown as rpc.Server,
          network: deps.network,
          fetchSourceAccount: (publicKey: string) => deps.horizon.loadAccount(publicKey),
        });
        node.status = "simulated";
      } catch (err) {
        node.status = "failed";
        node.error = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }
    return { tree };
  });

  // execution: depth-first topo walk; re-loads the account between nodes
  const executionActor = fromPromise<
    ExecutionOutput,
    {
      publicKey: string;
      tree: PlanTree;
      previousReceipts: Record<string, ConfirmationReceipt>;
    }
  >(({ input }) => executePlanTreeOnChain(input, deps));

  const machine = setup({
    types: {
      context: {} as OrchestratorContext,
      events: {} as OrchestratorEvent,
      input: {} as OrchestratorInput,
    },
    actors: {
      discovery: discoveryActor,
      preview: previewActor,
      execution: executionActor,
    },
    actions: {
      recordDiscovery: assign({
        discovery: (_, params: DiscoveryResult) => params,
      }),
      recordTree: assign({
        tree: (_, params: PlanTree) => params,
      }),
      recordReceipts: assign({
        receipts: ({ context }, params: Record<string, ConfirmationReceipt>) => ({
          ...context.receipts,
          ...params,
        }),
      }),
      recordFailure: assign({
        failure: (_, params: OrchestratorFailure) => params,
      }),
      bumpAttempts: assign({
        attempts: ({ context }) => context.attempts + 1,
      }),
      resetAttempts: assign({
        attempts: () => 0,
      }),
      clearFailure: assign({
        failure: () => null,
      }),
      clearAll: assign({
        tree: () => null,
        discovery: () => null,
        receipts: () => ({}),
        failure: () => null,
        attempts: () => 0,
        currentNodeId: () => null,
        multisig: () => null,
      }),
      // multisig coordination
      initMultisig: assign({
        multisig: (
          _,
          params: {
            canonicalXdr: string;
            sourceAccountId: string;
            required: MultisigRequirement;
            initialSignerKey: string;
          },
        ): MultisigState => {
          const initialWeight = tallyWeight(params.required, [params.initialSignerKey]);
          return {
            sourceAccountId: params.sourceAccountId,
            required: params.required,
            canonicalXdr: params.canonicalXdr,
            gatheredSignerKeys: [params.initialSignerKey],
            signaturesGathered: initialWeight,
            signedXdr: initialWeight >= params.required.threshold ? params.canonicalXdr : null,
          };
        },
      }),
      addSignature: assign({
        multisig: (
          { context },
          params: { partialXdr: string; signerKey: string; networkPassphrase: string },
        ): MultisigState | null => {
          const current = context.multisig;
          if (current === null) return null;
          // de-dup signer keys
          const nextKeys = current.gatheredSignerKeys.includes(params.signerKey)
            ? current.gatheredSignerKeys
            : [...current.gatheredSignerKeys, params.signerKey];
          // merge the partial onto the canonical
          let mergedXdr = current.canonicalXdr;
          try {
            mergedXdr = mergeSignatures(
              current.canonicalXdr,
              [params.partialXdr],
              params.networkPassphrase,
              { expectedSigners: current.required.signers.map((s) => s.key) },
            );
          } catch {
            // bad signature: keep the prior canonical; UI layer surfaces the error
          }
          const weight = tallyWeight(current.required, nextKeys);
          return {
            ...current,
            canonicalXdr: mergedXdr,
            gatheredSignerKeys: nextKeys,
            signaturesGathered: weight,
            signedXdr: weight >= current.required.threshold ? mergedXdr : null,
          };
        },
      }),
      completeMultisig: assign({
        multisig: (
          { context },
          params: { signedXdr: string; signerKeys: readonly string[] },
        ): MultisigState | null => {
          const current = context.multisig;
          if (current === null) return null;
          const keys = Array.from(new Set(params.signerKeys));
          return {
            ...current,
            canonicalXdr: params.signedXdr,
            gatheredSignerKeys: keys,
            signaturesGathered: tallyWeight(current.required, keys),
            signedXdr: params.signedXdr,
          };
        },
      }),
      clearMultisig: assign({
        multisig: () => null,
      }),
    },
    guards: {
      isFatal: ({ context }) => context.failure?.kind === "fatal",
      isRecoverable: ({ context }) => context.failure?.kind === "recoverable",
      isSurfaceConsent: ({ context }) => {
        const tag = context.failure?.tag;
        return (
          tag === "slippage-exceeded" ||
          tag === "multisig-threshold" ||
          tag === "needs-user-consent"
        );
      },
      canPlainRetry: ({ context }) => {
        const tag = context.failure?.tag;
        // slippage and multisig require explicit consent
        return tag !== "slippage-exceeded" && tag !== "multisig-threshold";
      },
      multisigThresholdMet: ({ context }) =>
        context.multisig !== null &&
        context.multisig.signaturesGathered >= context.multisig.required.threshold,
    },
  }).createMachine({
    id: "orchestrator",
    initial: "idle",
    context: ({ input }): OrchestratorContext => ({
      publicKey: input.publicKey,
      options: input.options,
      discovery: null,
      tree: null,
      currentNodeId: null,
      failure: null,
      attempts: 0,
      receipts: {},
      multisig: null,
    }),
    states: {
      idle: {
        on: {
          DISCOVER: { target: "discovering" },
        },
      },

      discovering: {
        invoke: {
          src: "discovery",
          input: ({ context }) => ({ publicKey: context.publicKey }),
          onDone: {
            target: "previewing",
            actions: [
              {
                type: "recordDiscovery",
                params: ({ event }) => event.output.discovery,
              },
              "clearFailure",
              "resetAttempts",
            ],
          },
          onError: {
            target: "failed",
            actions: {
              type: "recordFailure",
              params: ({ event, context }) =>
                classifyFailure({
                  error: event.error,
                  stage: "discovering",
                  attempts: context.attempts,
                  maxAttempts: context.options.maxRecoveryAttempts ?? 3,
                }).failure,
            },
          },
        },
      },

      previewing: {
        invoke: {
          src: "preview",
          input: ({ context }) => {
            if (context.discovery === null) {
              throw new Error("preview: discovery is null");
            }
            return {
              publicKey: context.publicKey,
              discovery: context.discovery,
              options: context.options,
            };
          },
          onDone: {
            target: "awaitingConfirmation",
            actions: {
              type: "recordTree",
              params: ({ event }) => event.output.tree,
            },
          },
          onError: {
            target: "failed",
            actions: {
              type: "recordFailure",
              params: ({ event, context }) =>
                classifyFailure({
                  error: event.error,
                  stage: "previewing",
                  attempts: context.attempts,
                  maxAttempts: context.options.maxRecoveryAttempts ?? 3,
                }).failure,
            },
          },
        },
      },

      awaitingConfirmation: {
        on: {
          USER_CONFIRM: { target: "executing" },
          USER_CANCEL: { target: "idle", actions: "clearAll" },
          MULTISIG_REQUIRED: {
            target: "multisigCollection",
            actions: {
              type: "initMultisig",
              params: ({ event }) => ({
                canonicalXdr: event.canonicalXdr,
                sourceAccountId: event.sourceAccountId,
                required: event.required,
                initialSignerKey: event.initialSignerKey,
              }),
            },
          },
        },
      },

      // multisig coordination: hold the canonical envelope + collected signers,
      multisigCollection: {
        always: [
          {
            target: "executing",
            guard: "multisigThresholdMet",
          },
        ],
        on: {
          ADD_SIGNATURE: {
            actions: {
              type: "addSignature",
              params: ({ event }) => ({
                partialXdr: event.partialXdr,
                signerKey: event.signerKey,
                networkPassphrase: deps.network.passphrase,
              }),
            },
          },
          MULTISIG_COMPLETE: {
            target: "executing",
            actions: {
              type: "completeMultisig",
              params: ({ event }) => ({
                signedXdr: event.signedXdr,
                signerKeys: event.signerKeys,
              }),
            },
          },
          MULTISIG_CANCEL: {
            target: "awaitingConfirmation",
            actions: "clearMultisig",
          },
          USER_CANCEL: {
            target: "idle",
            actions: "clearAll",
          },
        },
      },

      executing: {
        invoke: {
          src: "execution",
          input: ({ context }) => {
            if (context.tree === null) {
              throw new Error("execution: tree is null");
            }
            return {
              publicKey: context.publicKey,
              tree: context.tree,
              previousReceipts: context.receipts,
            };
          },
          onDone: {
            target: "succeeded",
            actions: [
              {
                type: "recordReceipts",
                params: ({ event }) => event.output.receipts,
              },
              {
                type: "recordTree",
                params: ({ event }) => event.output.tree,
              },
            ],
          },
          onError: {
            target: "failed",
            actions: [
              // recordFailure runs before bumpAttempts so the classifier sees
              // the pre-bump count
              {
                type: "recordFailure",
                params: ({ event, context }) =>
                  classifyFailure({
                    error: event.error,
                    stage: "executing",
                    attempts: context.attempts + 1,
                    maxAttempts: context.options.maxRecoveryAttempts ?? 3,
                  }).failure,
              },
              "bumpAttempts",
            ],
          },
        },
      },

      failed: {
        initial: "classifying",
        states: {
          classifying: {
            always: [
              { target: "fatal", guard: "isFatal" },
              { target: "recoverable", guard: "isRecoverable" },
              { target: "fatal" },
            ],
          },
          recoverable: {
            on: {
              RETRY: {
                target: "#orchestrator.executing",
                guard: "canPlainRetry",
                actions: "clearFailure",
              },
              USER_CONSENT: {
                target: "#orchestrator.executing",
                guard: "isSurfaceConsent",
                actions: "clearFailure",
              },
              USER_CANCEL: {
                target: "#orchestrator.idle",
                actions: "clearAll",
              },
              RESET: {
                target: "#orchestrator.idle",
                actions: "clearAll",
              },
            },
          },
          fatal: {
            type: "final",
          },
        },
      },

      succeeded: {
        type: "final",
      },
    },
  });

  return machine;
}

export type OrchestratorActorRef = ActorRefFrom<ReturnType<typeof createOrchestratorMachine>>;

// reads a node's pre-built transaction; undefined for classic-only kinds
export function pickTransaction(node: PlanNode) {
  switch (node.kind) {
    case "RevokeAllowance":
    case "RepayBlend":
    case "PayFxDAODebt":
    case "WithdrawBlend":
    case "WithdrawAquarius":
    case "WithdrawSoroswapLp":
    case "RedeemFxDAO":
    case "ClaimBlendEmissions":
    case "ClaimAquariusRewards":
    case "ConvertSorobanToXLM":
    case "TransferAsIs":
    case "BackstopQueue":
      return node.metadata.transaction;
    case "FinalClassicTx":
    case "MediatorForward":
      return undefined;
  }
}

function hasBuiltTransaction(node: PlanNode): boolean {
  return pickTransaction(node) !== undefined;
}

// cumulative weight of signerKeys under required.signers. duplicates and
// unknown keys contribute zero
export function tallyWeight(required: MultisigRequirement, signerKeys: Iterable<string>): number {
  const seen = new Set<string>();
  let total = 0;
  for (const key of signerKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const found = required.signers.find((s) => s.key === key);
    if (found) total += found.weight;
  }
  return total;
}

export { applyFixup, classifyFailure };
export type { RecoveryDecision };

// shared executor used by both the orchestrator's execution actor and the
export async function executePlanTreeOnChain(
  input: {
    publicKey: string;
    tree: PlanTree;
    previousReceipts: Record<string, ConfirmationReceipt>;
    // fires after every node.status mutation so the ui can re-render with
    onNodeUpdate?: (node: PlanNode) => void;
  },
  deps: Pick<
    OrchestratorDeps,
    "network" | "connector" | "horizon" | "submitClassic" | "submitSoroban"
  >,
): Promise<ExecutionOutput> {
  const receipts: Record<string, ConfirmationReceipt> = { ...input.previousReceipts };
  const ordered = topologicalOrder(input.tree);
  const notify = (node: PlanNode): void => {
    try {
      input.onNodeUpdate?.(node);
    } catch {
      // notifications must never abort execution
    }
  };

  for (const node of ordered) {
    if (receipts[node.id] !== undefined) {
      const prior = receipts[node.id]!;
      node.status = "confirmed";
      node.executed = { txHash: prior.txHash, ledger: prior.ledger };
      notify(node);
      continue;
    }
    if (node.executed !== undefined) {
      node.status = "confirmed";
      receipts[node.id] = { txHash: node.executed.txHash, ledger: node.executed.ledger };
      notify(node);
      continue;
    }
    if (node.status === "skipped" || node.status === "failed") continue;

    try {
      await deps.horizon.loadAccount(input.publicKey);
    } catch {
      // transient horizon 5xx — continue; submit will surface a real failure
    }

    if (node.kind === "FinalClassicTx") {
      // soroban exits shift classical balances, so the cached batches are
      const freshAudit = await auditAccount(input.publicKey, deps.network);
      const freshBatches = batchClassicDemolition(freshAudit, {
        destination: node.metadata.destination,
        useMediator: node.metadata.useMediator,
        ...(node.metadata.claimableBalanceIds
          ? { claimableBalanceIds: node.metadata.claimableBalanceIds }
          : {}),
        ...(node.metadata.userFallbackAddress
          ? { userFallbackAddress: node.metadata.userFallbackAddress }
          : {}),
        ...(node.metadata.mediatorPublicKey
          ? { mediatorPublicKey: node.metadata.mediatorPublicKey }
          : {}),
      });
      if (freshBatches.length === 0) {
        throw new Error(`executing: node "${node.id}" produced no fresh batches`);
      }
      let lastReceipt: ConfirmationReceipt | null = null;
      for (let i = 0; i < freshBatches.length; i++) {
        const sourceAccount = await deps.horizon.loadAccount(input.publicKey);
        const built = buildClassicTransaction(freshBatches[i]!, sourceAccount, deps.network);
        const signed = await deps.connector.signTransaction(
          built.transaction,
          deps.network.passphrase,
        );
        node.status = "signed";
        notify(node);
        lastReceipt = await deps.submitClassic(signed.signedXdr);
        node.status = "submitted";
        node.executed = { txHash: lastReceipt.txHash, ledger: lastReceipt.ledger };
        notify(node);
      }
      if (lastReceipt === null) {
        throw new Error(`executing: node "${node.id}" produced no receipt`);
      }
      node.status = "confirmed";
      node.executed = { txHash: lastReceipt.txHash, ledger: lastReceipt.ledger };
      receipts[node.id] = lastReceipt;
      notify(node);
      continue;
    }

    if (node.kind === "MediatorForward") {
      const forwardInput: Parameters<typeof submitMediatorForward>[0] = {
        mediatorPublicKey: node.metadata.mediatorPublicKey,
        destination: node.metadata.ultimateDestination,
        network: deps.network,
        ...(node.metadata.memo
          ? { memo: { type: "text" as const, value: node.metadata.memo } }
          : {}),
      };
      node.status = "signed";
      notify(node);
      const forwardResult = await submitMediatorForward(forwardInput);
      if (!forwardResult.ok) {
        node.status = "failed";
        node.error = forwardResult.error;
        notify(node);
        throw new Error(`MediatorForward failed: ${forwardResult.error}`);
      }
      node.status = "confirmed";
      node.executed = { txHash: forwardResult.txHash, ledger: 0 };
      receipts[node.id] = { txHash: forwardResult.txHash, ledger: 0 };
      notify(node);
      continue;
    }

    const tx = pickTransaction(node);
    if (!tx) {
      throw new Error(`executing: node "${node.id}" (${node.kind}) has no transaction attached`);
    }
    const signed = await deps.connector.signTransaction(tx, deps.network.passphrase);
    node.status = "signed";
    notify(node);

    const submit = isSorobanNode(node) ? deps.submitSoroban : deps.submitClassic;
    const receipt = await submit(signed.signedXdr);

    node.status = "confirmed";
    node.executed = { txHash: receipt.txHash, ledger: receipt.ledger };
    receipts[node.id] = receipt;
    notify(node);
    void TransactionBuilder;
  }

  return { receipts, tree: input.tree };
}
