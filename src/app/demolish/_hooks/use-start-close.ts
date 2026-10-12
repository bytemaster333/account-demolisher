"use client";

import { useCallback } from "react";

import { getPublicEnv } from "@/lib/config/env";
import type { NetworkConfig } from "@/lib/config/networks";
import type { BundleabilityResult } from "@/lib/multisig/signing-request";
import type {
  PageFlowContext,
  PageFlowEvent,
  PageFlowInput,
} from "@/lib/orchestrator/page-flow-machine";
import { requireMemoEnforcement, validateMemoFormat } from "@/lib/safety/cex-registry";

import { FORM_SCHEMA, INITIAL_FORM, parseMemo } from "../_lib/form";
import {
  assessSigningRequest,
  hasClassicPoolShares,
  type ClaimAtRisk,
} from "../_lib/signing-bundle";
import type { StoredSigningRequest } from "../_lib/signing-request-store";
import type { CloseChoices } from "./use-close-choices";
import type { FlowConnector } from "./use-flow-connector";
import type { SigningRequest } from "./use-signing-request";

export interface StartClose {
  // checks the form and starts a run that discovers the account and builds the
  // plan
  readonly onStart: () => void;
  // rebuilds the close a stored signing request was made from
  readonly onResumeRequest: (record: StoredSigningRequest) => void;
  // drops a published request the account outgrew and plans the close again
  readonly onRebuildRequest: () => void;
  // rebuilds without the claims the bundle can't make within the signing window
  readonly onLeaveOutRisky: () => void;
}

// every way a run is started from the page: the form, a stored signing
// request, or a rebuild of the plan on screen
export function useStartClose(args: {
  readonly send: (event: PageFlowEvent) => void;
  readonly ctx: PageFlowContext;
  readonly publicKey: string | null;
  // the navbar's network, which a new run is built for
  readonly network: NetworkConfig;
  readonly connector: FlowConnector;
  readonly choices: CloseChoices;
  // the destination's SEP-29 flag; null until it has been read
  readonly sep29MemoRequired: boolean | null;
  readonly destExistsHint: string | null;
  readonly useMediator: boolean;
  readonly multisigRequired: boolean;
  readonly configureGate: BundleabilityResult;
  readonly builtClaimList: readonly string[];
  readonly claimRisks: readonly ClaimAtRisk[];
  readonly signing: SigningRequest;
  readonly setFormError: (error: string | null) => void;
  readonly setShowConfirmDialog: (open: boolean) => void;
}): StartClose {
  const { send, ctx, publicKey, network, sep29MemoRequired, destExistsHint, useMediator } = args;
  const { multisigRequired, configureGate, builtClaimList, claimRisks, signing } = args;
  const { setFormError, setShowConfirmDialog } = args;
  const { connectorRef } = args.connector;
  const { form, setForm, claimSelection, setClaimSelection, acceptedPriceKeys } = args.choices;
  const { forfeitPools, heldAnswers, selectedHeldTokens, convertHeldTokensToXLM } = args.choices;
  const audit = ctx.audit;
  const runInput = ctx.input;

  const startRun = useCallback(
    (input: PageFlowInput) => {
      setShowConfirmDialog(false);
      send({ type: "START", input });
    },
    [send, setShowConfirmDialog],
  );

  // claimsOverride: a claim list to build with right away, before the state
  // that records it has re-rendered
  const buildAndStart = useCallback(
    (claimsOverride?: readonly string[]) => {
      setFormError(null);

      const parsed = FORM_SCHEMA.safeParse(form);
      if (!parsed.success) {
        setFormError(parsed.error.issues.map((i) => i.message).join("; "));
        return;
      }
      if (!publicKey || !connectorRef.current) {
        setFormError("Connect a wallet first.");
        return;
      }
      if (parsed.data.destination === publicKey) {
        setFormError(
          "Destination can't be your own account, Stellar rejects a self-merge (ACCOUNT_MERGE_MALFORMED).",
        );
        return;
      }
      // the destination's SEP-29 flag decides the memo and the route, so the close
      // can't be planned before it has been read
      if (sep29MemoRequired === null) {
        setFormError(
          destExistsHint ?? "The destination account hasn't been checked yet. Try again.",
        );
        return;
      }

      const memo = parseMemo(form);

      // validate the memo VALUE shape for ANY destination, so a malformed id/hash
      // memo can't slip past a non-CEX close and throw inside Memo.id()/hash() only
      // at execute time (mid-close, after earlier steps may have submitted).
      if (memo !== undefined) {
        const memoFormatError = validateMemoFormat(memo.type, memo.value);
        if (memoFormatError !== null) {
          setFormError(memoFormatError);
          return;
        }
      }

      // hard refusal when the destination needs a memo (registry exchange or SEP-29
      // flag) and it is missing, the wrong type or malformed, and for an exchange
      // internal wallet whatever the memo
      const memoCheck = requireMemoEnforcement(parsed.data.destination, memo, {
        sep29MemoRequired,
      });
      if (!memoCheck.ok) {
        setFormError(memoCheck.reason);
        return;
      }

      // a self-hosted deployment doesn't run the mediator, so it can't safely
      // route a close to an exchange or a sep-29 memo-required address: refuse
      // up front rather than fail late at the mediator step (this is the
      // documented self-hosted safety guarantee).
      if (useMediator && getPublicEnv().NEXT_PUBLIC_DEPLOYMENT_MODE === "self-hosted") {
        setFormError(
          "This self-hosted deployment doesn't run the mediator, so it can't route a close to " +
            "an exchange or an address that requires a memo. Withdraw to a self-custody address instead.",
        );
        return;
      }

      // A shared account is always closed the same way: the initiator signs with
      // their own key, the reviewed close is built as ONE deterministic bundled
      // transaction (no market sell that could sink the signed bundle) and, after
      // Review, published as a signing request the other signers add signatures
      // to. When what's already known rules that out, refuse rather than start.
      if (multisigRequired) {
        const known =
          audit !== null && audit.accountId === publicKey
            ? assessSigningRequest({
                positions: ctx.positions,
                allowanceCount: ctx.allowances.length,
                useMediator,
                heldTokensSelected: selectedHeldTokens.length,
                hasClassicPoolShares: hasClassicPoolShares(audit),
                tree: null,
                deterministic: true,
              })
            : configureGate;
        if (!known.ok) {
          setFormError(
            known.reason ??
              "This shared account's close can't be bundled into a single signing request.",
          );
          return;
        }
      }

      // once the user picked, the plan claims exactly their pick ([] claims none);
      // until then the planner claims every balance it can collect
      const claims = claimsOverride ?? claimSelection ?? runInput?.selectedClaimableBalanceIds;
      const asIs = [...heldAnswers].flatMap(([id, a]) => (a === "asis" ? [id] : []));
      const leave = [...heldAnswers].flatMap(([id, a]) => (a === "leave" ? [id] : []));
      startRun({
        publicKey,
        network,
        connector: connectorRef.current,
        destination: parsed.data.destination,
        useMediator,
        ...(memo ? { memo } : {}),
        ...(claims !== undefined ? { selectedClaimableBalanceIds: claims } : {}),
        ...(form.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: form.returnToIssuer } : {}),
        ...(form.sendToDestination.length > 0
          ? { sendToDestinationAssetKeys: form.sendToDestination }
          : {}),
        ...(acceptedPriceKeys.length > 0
          ? { acceptedPriceImpactAssetKeys: acceptedPriceKeys }
          : {}),
        ...(forfeitPools.length > 0 ? { forfeitBackstopEmissionPoolIds: forfeitPools } : {}),
        ...(asIs.length > 0 ? { sendHeldTokensAsIs: asIs } : {}),
        ...(leave.length > 0 ? { leaveHeldTokens: leave } : {}),
        ...(selectedHeldTokens.length > 0 ? { selectedHeldTokens } : {}),
        ...(convertHeldTokensToXLM && selectedHeldTokens.length > 0
          ? { convertHeldTokensToXLM: true }
          : {}),
        // the signing-request path signs ONE bundled transaction, so it can't rely
        // on a market sell: force deterministic disposal so the reviewed plan is
        // exactly the transaction every signer signs
        ...(multisigRequired ? { deterministicDisposal: true } : {}),
      });
    },
    [
      form,
      publicKey,
      network,
      connectorRef,
      sep29MemoRequired,
      destExistsHint,
      useMediator,
      multisigRequired,
      audit,
      ctx.positions,
      ctx.allowances,
      configureGate,
      claimSelection,
      runInput,
      acceptedPriceKeys,
      forfeitPools,
      heldAnswers,
      selectedHeldTokens,
      convertHeldTokensToXLM,
      startRun,
      setFormError,
    ],
  );
  const onStart = useCallback(() => buildAndStart(), [buildAndStart]);

  // resume a stored signing request: rebuild the close from the inputs it was
  // built with; the request is only reused if the rebuilt plan matches it
  const onResumeRequest = useCallback(
    (record: StoredSigningRequest) => {
      if (!publicKey || !connectorRef.current) {
        setFormError("Connect a wallet first.");
        return;
      }
      const connector = connectorRef.current;
      void signing.resume(record, (r) => {
        setForm({
          ...INITIAL_FORM,
          destination: r.destination,
          memoType: r.memo?.type ?? "none",
          memoValue: r.memo?.value ?? "",
          returnToIssuer: [...r.returnToIssuer],
          sendToDestination: [...r.sendToDestination],
        });
        setClaimSelection([...r.selectedCbIds]);
        startRun({
          publicKey,
          network,
          connector,
          destination: r.destination,
          useMediator: false,
          ...(r.memo ? { memo: r.memo } : {}),
          // the reviewed claim list, exactly; [] claims none
          selectedClaimableBalanceIds: r.selectedCbIds,
          ...(r.returnToIssuer.length > 0 ? { returnToIssuerAssetKeys: r.returnToIssuer } : {}),
          ...(r.sendToDestination.length > 0
            ? { sendToDestinationAssetKeys: r.sendToDestination }
            : {}),
          deterministicDisposal: true,
        });
      });
    },
    [publicKey, network, connectorRef, signing, startRun, setForm, setClaimSelection, setFormError],
  );

  // the account changed under a published request, so the network would refuse
  // it as signed: drop it and plan the close again from the account as it is
  // now, for a new request
  const onRebuildRequest = useCallback(() => {
    signing.discardStored();
    signing.reset();
    buildAndStart();
  }, [signing, buildAndStart]);

  const onLeaveOutRisky = useCallback(() => {
    const risky = new Set(claimRisks.map((r) => r.id));
    const kept = builtClaimList.filter((id) => !risky.has(id));
    setClaimSelection(kept);
    buildAndStart(kept);
  }, [claimRisks, builtClaimList, setClaimSelection, buildAndStart]);

  return { onStart, onResumeRequest, onRebuildRequest, onLeaveOutRisky };
}
