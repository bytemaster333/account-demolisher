"use client";

import { Account, TransactionBuilder, type Horizon, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useMemo, useState } from "react";

import { DirectContractProvider } from "@/lib/adapters/positions/direct";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { fetchPlan, publishPlan } from "@/lib/multisig/plan-client";
import type { BundleabilityResult } from "@/lib/multisig/signing-request";
import type { PageFlowRunInput } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree } from "@/lib/plan/tree";
import { getHorizon } from "@/lib/stellar/horizon-client";
import type { AccountAudit } from "@/lib/types/account";
import type { Connector } from "@/lib/wallet/connector";

import { buildReviewedBundle, reprobeBeforePublish } from "../_lib/signing-bundle";
import {
  clearSigningRequest,
  loadSigningRequest,
  sameOperationsAndMemo,
  saveSigningRequest,
  verifyRelayEnvelope,
  type StoredSigningRequest,
} from "../_lib/signing-request-store";

export interface PublishedRequest {
  readonly planId: string;
  readonly xdr: string;
  readonly validUntil: Date | null;
}

function maxTimeOf(tx: Transaction): Date | null {
  const max = Number(tx.timeBounds?.maxTime ?? 0);
  return max > 0 ? new Date(max * 1000) : null;
}

function hashHex(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

// the claim selection a plan was built with: the run's explicit list, or the
// list the generator recorded on the close when the run left it to the planner
export function reviewedClaimList(
  tree: PlanTree,
  runInput: Pick<PageFlowRunInput, "selectedClaimableBalanceIds">,
): readonly string[] {
  if (runInput.selectedClaimableBalanceIds !== undefined) {
    return runInput.selectedClaimableBalanceIds;
  }
  const final = tree.allNodes.get("final-classic-tx");
  if (
    !final ||
    final.kind !== "FinalClassicTx" ||
    final.metadata.claimableBalanceIds === undefined
  ) {
    throw new Error("The reviewed plan doesn't record which pending payments it collects.");
  }
  return final.metadata.claimableBalanceIds;
}

// everything about the shared-account signing request on the initiator's side:
// publishing the reviewed close, keeping it across a reload, and picking it up
// again only once the rebuilt plan is shown to be the same transaction
export function useSigningRequest(args: {
  readonly runInput: PageFlowRunInput | null;
  // the wallet the run holds (the machine's connector); it signs the request
  readonly connector: Connector | null;
  readonly audit: AccountAudit | null;
  readonly tree: PlanTree | null;
  // the network the run is on
  readonly network: NetworkConfig;
  readonly gate: BundleabilityResult;
  readonly runMismatched: boolean;
  readonly isAwaitingConfirmation: boolean;
  // the connected account and navbar network, for the resume offer
  readonly publicKey: string | null;
  readonly storeNetworkId: string;
  readonly nowMs: number;
}) {
  const [published, setPublished] = useState<PublishedRequest | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notStored, setNotStored] = useState(false);
  // a stored request the user chose to resume: verified against the relay, then
  // held until the rebuilt plan can be compared with it
  const [resuming, setResuming] = useState<PublishedRequest | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // bumps when the stored record changes so the offer re-reads it
  const [storeVersion, setStoreVersion] = useState(0);

  const stored = useMemo<StoredSigningRequest | null>(() => {
    void storeVersion;
    if (args.publicKey === null || typeof window === "undefined") return null;
    return loadSigningRequest(args.publicKey, args.storeNetworkId, args.nowMs);
  }, [args.publicKey, args.storeNetworkId, args.nowMs, storeVersion]);

  // once the resumed run's plan is built, the published request is only reused
  // if it does exactly what the rebuilt plan does
  const resumeCheck = useMemo<
    { readonly ok: true } | { readonly ok: false; readonly reason: string } | null
  >(() => {
    if (resuming === null || !args.isAwaitingConfirmation) return null;
    if (args.tree === null || args.runInput === null || args.audit === null) return null;
    if (!args.gate.ok)
      return { ok: false, reason: args.gate.reason ?? "This close can't be bundled." };
    try {
      const relayTx = TransactionBuilder.fromXdr(resuming.xdr, args.network.passphrase);
      if (!("operations" in relayTx)) {
        return { ok: false, reason: "The stored request isn't a close transaction." };
      }
      // sequence and time bounds don't matter for the comparison
      const source = new Account(args.audit.accountId, "0") as unknown as Horizon.AccountResponse;
      const rebuilt = buildReviewedBundle({
        tree: args.tree,
        input: args.runInput,
        sourceAccount: source,
        network: args.network,
      });
      return sameOperationsAndMemo(rebuilt, relayTx as Transaction)
        ? { ok: true }
        : {
            ok: false,
            reason:
              "The account changed since this request was created, so it no longer matches the close. Discard it and create a new one.",
          };
    } catch (err) {
      return { ok: false, reason: errorMessage(err, "The stored request couldn't be checked.") };
    }
  }, [
    resuming,
    args.isAwaitingConfirmation,
    args.tree,
    args.runInput,
    args.audit,
    args.gate,
    args.network,
  ]);

  const active: PublishedRequest | null =
    published ?? (resuming !== null && resumeCheck?.ok === true ? resuming : null);

  const create = useCallback(async (): Promise<void> => {
    const { runInput, audit, tree, network, connector } = args;
    if (runInput === null || audit === null || tree === null) return;
    if (connector === null) {
      setError("Connect a wallet first.");
      return;
    }
    if (args.runMismatched) {
      setError("Your wallet or network changed since this plan was built. Start over.");
      return;
    }
    if (!args.gate.ok) {
      setError(args.gate.reason ?? "This close can't be packaged as one signing request.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // the single-signer executor re-probes DeFi positions before its merge;
      // do the same before co-signers are asked to sign one
      const probe = await reprobeBeforePublish(runInput.publicKey, network, (pk, net) =>
        new DirectContractProvider().getPositions(pk, net),
      );
      if (!probe.ok) {
        setError(probe.reason ?? "The account's DeFi positions couldn't be confirmed closed.");
        return;
      }
      const sourceAccount = await getHorizon(network).loadAccount(audit.accountId);
      const tx = buildReviewedBundle({ tree, input: runInput, sourceAccount, network });
      const { signedXdr } = await connector.signTransaction(tx, network.passphrase);
      const id = await publishPlan(network.id, signedXdr);
      if (id.toLowerCase() !== hashHex(tx)) {
        throw new Error("The relay returned an id that doesn't match the signed transaction.");
      }
      const validUntil = maxTimeOf(tx);
      setPublished({ planId: id, xdr: signedXdr, validUntil });
      const saved = saveSigningRequest({
        planId: id,
        networkId: network.id,
        publicKey: runInput.publicKey,
        destination: runInput.destination,
        ...(runInput.memo ? { memo: runInput.memo } : {}),
        returnToIssuer: runInput.returnToIssuerAssetKeys ?? [],
        sendToDestination: runInput.sendToDestinationAssetKeys ?? [],
        // the claim list the reviewed plan was built with, so a resume rebuilds
        // exactly this close ([] would claim none)
        selectedCbIds: reviewedClaimList(tree, runInput),
        validUntil: validUntil?.getTime() ?? null,
        createdAt: Date.now(),
      });
      setNotStored(!saved);
      setStoreVersion((v) => v + 1);
    } catch (e: unknown) {
      setError(errorMessage(e, "Couldn't create the signing request."));
    } finally {
      setCreating(false);
    }
  }, [args]);

  // fetch the stored request from the relay and check it before rebuilding the
  // plan it came from; startRun kicks off that rebuild with the stored inputs
  const resume = useCallback(
    async (record: StoredSigningRequest, startRun: (record: StoredSigningRequest) => void) => {
      setResumeBusy(true);
      setResumeError(null);
      try {
        const relay = await fetchPlan(record.planId);
        const check = verifyRelayEnvelope({
          planId: record.planId,
          relay,
          expected: {
            networkId: record.networkId,
            publicKey: record.publicKey,
            destination: record.destination,
          },
          passphrase: args.network.passphrase,
        });
        if (!check.ok) {
          setResumeError(check.reason);
          return;
        }
        setResuming({
          planId: record.planId,
          xdr: relay.xdr,
          validUntil: record.validUntil === null ? null : new Date(record.validUntil),
        });
        startRun(record);
      } catch (e: unknown) {
        setResumeError(errorMessage(e, "Couldn't load the signing request from the relay."));
      } finally {
        setResumeBusy(false);
      }
    },
    [args.network.passphrase],
  );

  const discardStored = useCallback(() => {
    clearSigningRequest();
    setResuming(null);
    setResumeError(null);
    setStoreVersion((v) => v + 1);
  }, []);

  // drop this tab's request state (start over / a new run). The stored record
  // stays, so a still-valid published request can be resumed later.
  const reset = useCallback(() => {
    setPublished(null);
    setResuming(null);
    setResumeError(null);
    setError(null);
    setNotStored(false);
    setCreating(false);
    setStoreVersion((v) => v + 1);
  }, []);

  // the request was submitted: nothing left to resume
  const finished = useCallback(() => {
    clearSigningRequest();
    setStoreVersion((v) => v + 1);
  }, []);

  return {
    active,
    // the request this tab published or picked up, whatever the run's state,
    // so a cancelled run can still say it remains valid on the relay
    published: published ?? resuming,
    creating,
    error,
    notStored,
    stored,
    resumeBusy,
    resumeError,
    resumeMismatch: resumeCheck !== null && !resumeCheck.ok ? resumeCheck.reason : null,
    create,
    resume,
    discardStored,
    reset,
    finished,
  };
}
