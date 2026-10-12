"use client";

import { useMemo } from "react";

import { openPositionCount } from "@/lib/adapters/positions/interface";
import type { NetworkConfig } from "@/lib/config/networks";
import { thresholdForClose } from "@/lib/multisig/signing-request";
import {
  confirmBlockers,
  discoveryWarningFor,
  previewBlockers,
  type PageFlowContext,
} from "@/lib/orchestrator/page-flow-machine";
import { assessCloseValue } from "@/lib/safety/high-value";
import { runScamHeuristics, type ScamFinding } from "@/lib/safety/scam-heuristics";
import { topologicalOrder, type PlanNode, type PlanTree } from "@/lib/plan/tree";

import type { ClaimChoices } from "../_components/AcknowledgePanel";
import type { ConversionChoices } from "../_components/ConversionChoicesCard";
import { claimableSplit, type ClaimableSplit } from "../_lib/claimables";
import { stroopsToXlm } from "../_lib/fees";
import { heldSelectionDirty } from "../_lib/held-selection";
import { groupPlanNodes, runProgress, type PlanGroup } from "../_lib/plan-copy";
import { hasClassicPoolShares } from "../_lib/signing-bundle";
import { useClaimedCreditQuotes, type ClaimedCreditQuotes } from "./use-claimed-credit-quotes";
import type { CloseChoices } from "./use-close-choices";
import { useHeldTokenScam, type HeldTokenScam } from "./use-held-token-scam";
import type { MultisigInfo, Preflight } from "./use-multisig-preflight";

type FinalNode = Extract<PlanNode, { kind: "FinalClassicTx" }>;

function finalNodeOf(tree: PlanTree | null): FinalNode | null {
  const node = tree?.allNodes.get("final-classic-tx");
  return node !== undefined && node.kind === "FinalClassicTx" ? node : null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

export interface RunReview {
  readonly finalNode: FinalNode | null;
  // the shared-account facts: from the discovery audit once it exists, else
  // from the read-only preflight
  readonly effectiveMultisig: MultisigInfo | null;
  // the initiator's own signing weight on the shared account (their key alone)
  readonly primaryWeight: number;
  readonly multisigRequired: boolean;
  readonly heldScam: HeldTokenScam;
  readonly scamFindings: readonly ScamFinding[];
  readonly numSponsoring: number;
  // self-sponsored claimable balances the close can release when it claims them
  // all
  readonly numCoverable: number;
  readonly isImmutableBlock: boolean;
  // sponsorships no plan can release take over the page
  readonly isSponsorBlock: boolean;
  readonly blocked: boolean;
  readonly claimables: ClaimableSplit;
  // the claim list the built plan used
  readonly builtClaimList: readonly string[];
  readonly claimChoices: ClaimChoices | undefined;
  readonly claimedQuotes: ClaimedCreditQuotes;
  readonly closeValue: ReturnType<typeof assessCloseValue> | null;
  // everything that keeps the close from starting
  readonly blockers: readonly string[];
  // the blockers the Resolve step can't offer a choice for
  readonly otherBlockers: readonly string[];
  // facts about the built plan worth knowing before the review
  readonly planNotes: readonly string[];
  readonly hasBlocker: boolean;
  readonly hasAckItems: boolean;
  readonly discoveryWarnings: readonly string[];
  readonly showTokenSection: boolean;
  readonly conversionChoices: ConversionChoices | undefined;
  // why the plan on screen has to be rebuilt before the close can go on
  readonly rebuildRequired: string | null;
  readonly planGroups: readonly PlanGroup[];
  readonly activeCount: number;
  readonly doneCount: number;
}

// what the page derives from the run the machine holds and the user's choices:
// the shared-account facts, the warnings and blockers, and the plan's progress
export function useRunReview(args: {
  readonly ctx: PageFlowContext;
  readonly isAwaitingConfirmation: boolean;
  readonly publicKey: string | null;
  readonly preflight: Preflight;
  // the network the run is on
  readonly runNetwork: NetworkConfig;
  // the reference time for claim windows
  readonly mountedAt: number;
  readonly choices: CloseChoices;
}): RunReview {
  const { ctx, isAwaitingConfirmation, publicKey, preflight, runNetwork, mountedAt } = args;
  const { form, claimSelection, setClaimSelection, selectedHeldTokens } = args.choices;
  const { convertHeldTokensToXLM, onConversionChoice } = args.choices;
  const audit = ctx.audit;
  const tree = ctx.tree;
  const runInput = ctx.input;
  const finalNode = finalNodeOf(tree);

  // prefer the discovery audit once it's available: ctx.audit is the audit the
  // plan is actually built from, so it is the one to trust.
  const effectiveMultisig = useMemo(() => {
    if (audit) {
      return {
        required: audit.requiresMultisig,
        threshold: thresholdForClose(audit.thresholds),
        signers: audit.signers,
        hasClassicPoolShares: hasClassicPoolShares(audit),
      };
    }
    return preflight.status === "ready" ? preflight.info : null;
  }, [audit, preflight]);

  const primaryWeight = useMemo(() => {
    if (!effectiveMultisig || !publicKey) return 0;
    return effectiveMultisig.signers.find((s) => s.key === publicKey)?.weight ?? 0;
  }, [effectiveMultisig, publicKey]);
  const multisigRequired = publicKey !== null && effectiveMultisig?.required === true;

  // scam heuristics over the classic credit balances and over the standalone
  // tokens, whose symbol and name their own contract sets
  const heldScam = useHeldTokenScam(ctx.heldTokens, runNetwork, audit?.accountId ?? null);
  const scamFindings = useMemo(
    () =>
      audit ? [...runScamHeuristics(audit.balances, runNetwork.id), ...heldScam.findings] : [],
    [audit, runNetwork.id, heldScam.findings],
  );

  const authImmutable = audit?.flags.authImmutable === true;
  const numSponsoring = audit?.sponsorship.numSponsoring ?? 0;
  // the plan-specific check (what this plan really claims) is a preview
  // blocker, shown before anything can be confirmed
  const numCoverable = audit?.sponsorship.coverable ?? 0;
  const isSponsorBlock = !authImmutable && numSponsoring > numCoverable;
  const isImmutableBlock = authImmutable;
  const blocked = isImmutableBlock || isSponsorBlock;

  // what the reviewed close collects, and the claimable balances it leaves
  const claimables = useMemo(
    () =>
      audit
        ? claimableSplit({ audit, tree, publicKey: audit.accountId, nowMs: mountedAt })
        : { collectCount: 0, leftBehind: [], trustlineChanges: [] },
    [audit, tree, mountedAt],
  );

  // the claim list the built plan used, and the user's pick where they changed it
  const builtClaimList = useMemo<readonly string[]>(
    () => runInput?.selectedClaimableBalanceIds ?? finalNode?.metadata.claimableBalanceIds ?? [],
    [runInput, finalNode],
  );
  const claimChoices = useMemo<ClaimChoices | undefined>(() => {
    if (audit === null || multisigRequired) return undefined;
    const selected = new Set(claimSelection ?? builtClaimList);
    return {
      balances: audit.claimableBalances
        .filter((cb) => cb.claimableNow !== false)
        .map((cb) => ({
          id: cb.id,
          asset: cb.asset,
          amount: cb.amount,
          locked: cb.sponsor === audit.accountId,
        })),
      selected,
      onToggle: (id, checked) =>
        setClaimSelection((prev) => {
          const base = new Set(prev ?? builtClaimList);
          if (checked) base.add(id);
          else base.delete(id);
          return [...base];
        }),
    };
  }, [audit, multisigRequired, claimSelection, builtClaimList, setClaimSelection]);

  // the claimable balances the built close really claims
  const claimedIds = useMemo<readonly string[]>(
    () =>
      finalNode === null
        ? []
        : finalNode.metadata.batches
            .flatMap((b) => b.operations)
            .filter((o) => o.kind === "claim_claimable_balance")
            .map((o) => String(o.metadata["balanceId"])),
    [finalNode],
  );
  // a credit the close claims more of is priced at a quote sized to the balance
  // plus the claims; the reviewed quotes cover the balance alone. A shared
  // account's close sells nothing, so it has no market quotes to check.
  const claimedQuotes = useClaimedCreditQuotes({
    audit,
    network: runNetwork,
    claimedBalanceIds: claimedIds,
    enabled: runInput !== null && runInput.deterministicDisposal !== true,
  });

  // what the close is expected to move. A credit that can't be priced trips the
  // large-value gate, so a failed quote lookup leaves the claimed ones unpriced
  // and says why.
  const closeValue = useMemo(() => {
    if (audit === null || finalNode === null) return null;
    const quotes =
      claimedQuotes.status === "ready"
        ? claimedQuotes.quotes
        : new Map(Object.entries(finalNode.metadata.reviewedConversionQuotes ?? {}));
    const movedTokens = [...(tree?.allNodes.values() ?? [])].filter(
      (n) => n.kind === "TransferAsIs" || n.kind === "ConvertSorobanToXLM",
    ).length;
    return assessCloseValue({
      audit,
      creditQuotes: quotes,
      claimedBalanceIds: claimedIds,
      unpricedPositions: openPositionCount(ctx.positions) + movedTokens,
    });
  }, [audit, finalNode, tree, ctx.positions, claimedIds, claimedQuotes]);
  const isHighValue = closeValue?.highValue === true;

  // the machine refuses CONFIRM and SUBMIT_BUNDLE while any blocker is open, so
  // the page says why
  const blockers = useMemo(() => {
    const list = [...confirmBlockers(ctx)];
    if (isAwaitingConfirmation && ctx.connector === null) {
      list.push("No wallet is connected to this run. Connect your wallet, then rebuild the plan.");
    }
    return list;
  }, [ctx, isAwaitingConfirmation]);
  const otherBlockers = useMemo(() => {
    const refusedTokens = new Set(ctx.refusedConversions.map((r) => r.contractId));
    const forfeitable = new Set(ctx.emissionForfeits.map((f) => f.poolId));
    const preview = previewBlockers(tree)
      .filter((b) => {
        const node = tree?.allNodes.get(b.nodeId);
        if (node?.kind === "ConvertSorobanToXLM" && node.metadata.asset.kind === "contract") {
          return !refusedTokens.has(node.metadata.asset.contractId);
        }
        if (node?.kind === "ClaimBackstopEmissions") return !forfeitable.has(node.metadata.poolId);
        return true;
      })
      .map((b) => `${b.description}: ${b.error}`);
    return [
      ...preview,
      ...ctx.reviewBlockers,
      ...ctx.positions.errors.map((e) => discoveryWarningFor(e)),
      ...(isAwaitingConfirmation && ctx.connector === null
        ? ["No wallet is connected to this run. Connect your wallet, then rebuild the plan."]
        : []),
    ];
  }, [ctx, tree, isAwaitingConfirmation]);

  const planNotes = useMemo<readonly string[]>(() => {
    const notes: string[] = [];
    for (const f of tree?.forfeitedBackstopEmissions ?? []) {
      notes.push(
        `Leaves ${stroopsToXlm(f.accruedEmissions)} BLND of Blend backstop rewards for pool ${f.poolId} unclaimed, as you chose.`,
      );
    }
    if (finalNode?.metadata.closeMarker === false) {
      notes.push(
        "This close won't carry the on-chain Account Demolisher marker (the account can't spare the reserve it needs at the merge), so it won't be counted in the app's public close numbers. The close itself is not affected.",
      );
    }
    return notes;
  }, [tree, finalNode]);

  // two distinct concerns, kept as separate steps:
  //  - a blocker needs an action + rebuild          → "resolve"
  //  - warnings / info need only read-and-understand → "acknowledge"
  const hasBlocker = blockers.length > 0;
  const hasScam = scamFindings.length > 0;
  const discoveryWarnings = useMemo(
    () => [...ctx.discoveryWarnings, ...heldScam.unreadable],
    [ctx.discoveryWarnings, heldScam.unreadable],
  );
  const hasDiscovery = discoveryWarnings.length > 0;
  const hasAutoHandled =
    claimables.collectCount > 0 || numCoverable > 0 || claimables.trustlineChanges.length > 0;
  const hasLeftBehind = claimables.leftBehind.length > 0;
  // the standalone-token section belongs with the warnings (it's about funds that
  // could be left behind). Show it whenever there's a real reason to look: tokens
  // found, unreadable candidates, or the optional scan couldn't finish (so the
  // manual add-a-token is still reachable). A clean, complete scan doesn't nag.
  const showTokenSection =
    ctx.heldTokens.length > 0 || ctx.unreadableHeldTokens.length > 0 || ctx.heldTokenScanFailed;
  const hasClaimChoices = claimChoices !== undefined && claimChoices.balances.length > 0;
  // a shared account's bundle sells nothing, so it has no conversions to choose
  // for
  const hasConversionChoices = !multisigRequired && ctx.routableCredits.length > 0;
  const hasAckItems =
    hasScam ||
    hasDiscovery ||
    hasAutoHandled ||
    hasLeftBehind ||
    isHighValue ||
    showTokenSection ||
    hasClaimChoices ||
    hasConversionChoices ||
    planNotes.length > 0;

  const conversionChoices = useMemo<ConversionChoices | undefined>(
    () =>
      !hasConversionChoices
        ? undefined
        : {
            credits: ctx.routableCredits,
            viaExchange: runInput?.useMediator === true,
            choiceFor: (key) =>
              form.sendToDestination.includes(key)
                ? "destination"
                : form.returnToIssuer.includes(key)
                  ? "issuer"
                  : "sell",
            onChoose: onConversionChoice,
          },
    [
      hasConversionChoices,
      ctx.routableCredits,
      runInput,
      form.sendToDestination,
      form.returnToIssuer,
      onConversionChoice,
    ],
  );

  // plan in execution order; groups are consecutive runs of one phase
  const orderedNodes = useMemo(() => (tree ? topologicalOrder(tree) : []), [tree]);
  const planGroups = useMemo(() => groupPlanNodes(orderedNodes), [orderedNodes]);
  // a skipped step never ran: it is neither done nor counted, so the total
  // matches the review's "N steps run"
  const { done: doneCount, total: activeCount } = runProgress(orderedNodes);

  // choices made on the Warnings step only reach the plan by a rebuild
  const claimSelectionDirty = claimSelection !== null && !sameSet(claimSelection, builtClaimList);
  // a send or return choice made for a conversion on this step
  const disposalDirty =
    runInput !== null &&
    (!sameSet(form.sendToDestination, runInput.sendToDestinationAssetKeys ?? []) ||
      !sameSet(form.returnToIssuer, runInput.returnToIssuerAssetKeys ?? []));
  // a failed look-alike check over the standalone tokens checked none of them, so
  // the close waits for a rebuild, which reads their names again
  const rebuildRequired =
    heldScam.error !== null
      ? `The standalone tokens' names couldn't be checked for look-alikes (${heldScam.error}). Rebuild the plan to check them again.`
      : runInput !== null &&
          !multisigRequired &&
          heldSelectionDirty(selectedHeldTokens, convertHeldTokensToXLM, runInput)
        ? "Your token choices aren't in the plan yet. Rebuild the plan to apply them before continuing."
        : runInput !== null && claimSelectionDirty
          ? "Your choice of pending payments isn't in the plan yet. Rebuild the plan to apply it before continuing."
          : disposalDirty
            ? "Your choices for the balances sold for XLM aren't in the plan yet. Rebuild the plan to apply them before continuing."
            : null;

  return {
    finalNode,
    effectiveMultisig,
    primaryWeight,
    multisigRequired,
    heldScam,
    scamFindings,
    numSponsoring,
    numCoverable,
    isImmutableBlock,
    isSponsorBlock,
    blocked,
    claimables,
    builtClaimList,
    claimChoices,
    claimedQuotes,
    closeValue,
    blockers,
    otherBlockers,
    planNotes,
    hasBlocker,
    hasAckItems,
    discoveryWarnings,
    showTokenSection,
    conversionChoices,
    rebuildRequired,
    planGroups,
    activeCount,
    doneCount,
  };
}
