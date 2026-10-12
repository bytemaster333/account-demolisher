"use client";

import { useMemo } from "react";

import type { NetworkConfig } from "@/lib/config/networks";
import {
  SIGNING_WINDOW_SECONDS,
  assessBundleability,
  type BundleabilityResult,
} from "@/lib/multisig/signing-request";
import type { PageFlowContext } from "@/lib/orchestrator/page-flow-machine";
import type { HeldToken } from "@/lib/soroban/held-tokens";

import {
  assessSigningRequest,
  claimsAtRiskInWindow,
  hasClassicPoolShares,
  type ClaimAtRisk,
} from "../_lib/signing-bundle";
import type { MultisigInfo } from "./use-multisig-preflight";
import { useSigningRequest, type SigningRequest } from "./use-signing-request";

export interface SharedClose {
  // what Configure can tell before a plan exists: the destination kind, the
  // pool shares and the token pick
  readonly configureGate: BundleabilityResult;
  // the full gate once a plan exists: positions, the built tree, deterministic
  // disposal
  readonly signingGate: BundleabilityResult;
  // claimable balances whose claim may fail before co-signers finish
  readonly claimRisks: readonly ClaimAtRisk[];
  readonly signing: SigningRequest;
  // the Signatures step is shown only while still gathering signatures for the
  // current, matching run; a cancel or a wallet/network change takes it down
  readonly collecting: boolean;
  readonly gatheringSignatures: boolean;
}

// a shared account's close is published as one signing request the other
// signers add signatures to; this is everything about it on the initiator's side
export function useSharedClose(args: {
  readonly ctx: PageFlowContext;
  readonly publicKey: string | null;
  // the navbar's network, for the stored request offer
  readonly network: NetworkConfig;
  // the network the run is on
  readonly runNetwork: NetworkConfig;
  readonly mountedAt: number;
  readonly useMediator: boolean;
  readonly multisigRequired: boolean;
  readonly effectiveMultisig: MultisigInfo | null;
  readonly selectedHeldTokens: readonly HeldToken[];
  readonly runMismatched: boolean;
  readonly isAwaitingConfirmation: boolean;
}): SharedClose {
  const { ctx, publicKey, network, runNetwork, mountedAt, useMediator } = args;
  const { multisigRequired, effectiveMultisig, selectedHeldTokens } = args;
  const { runMismatched, isAwaitingConfirmation } = args;
  const audit = ctx.audit;
  const tree = ctx.tree;
  const runInput = ctx.input;

  const configureGate = assessBundleability({
    hasSorobanPositions: false,
    hasSelectedAllowances: false,
    useMediator,
    hasClassicPoolShares: effectiveMultisig?.hasClassicPoolShares === true,
    hasSelectedHeldTokens: selectedHeldTokens.length > 0,
  });
  const signingGate = assessSigningRequest({
    positions: ctx.positions,
    allowanceCount: ctx.allowances.length,
    useMediator: runInput?.useMediator ?? useMediator,
    heldTokensSelected: Math.max(
      selectedHeldTokens.length,
      runInput?.selectedHeldTokens?.length ?? 0,
    ),
    hasClassicPoolShares: audit !== null && hasClassicPoolShares(audit),
    tree,
    audit,
    deterministic: runInput?.deterministicDisposal === true,
  });
  const claimRisks = useMemo(
    () =>
      multisigRequired && audit !== null && tree !== null
        ? claimsAtRiskInWindow({
            audit,
            tree,
            publicKey: audit.accountId,
            nowMs: mountedAt,
            windowSeconds: SIGNING_WINDOW_SECONDS,
          })
        : [],
    [multisigRequired, audit, tree, mountedAt],
  );

  const signing = useSigningRequest({
    runInput,
    connector: ctx.connector,
    audit,
    tree,
    network: runNetwork,
    gate: signingGate,
    runMismatched,
    isAwaitingConfirmation,
    publicKey,
    storeNetworkId: network.id,
    nowMs: mountedAt,
  });
  const collecting = signing.active !== null && isAwaitingConfirmation && !runMismatched;
  // while a close runs, or signatures are being gathered for one, switching the
  // network or the wallet would tear down the session it signs with
  const gatheringSignatures = collecting || signing.creating;

  return { configureGate, signingGate, claimRisks, signing, collecting, gatheringSignatures };
}
