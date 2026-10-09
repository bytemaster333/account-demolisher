"use client";

import { useCallback } from "react";

import type { SignerSnapshot } from "@/lib/multisig/bundle-freshness";
import type { PageFlowEvent, PageFlowRunInput } from "@/lib/orchestrator/page-flow-machine";
import { disconnectSession } from "@/lib/wallet/active-connector";

import type { CloseChoices } from "./use-close-choices";
import type { FlowConnector } from "./use-flow-connector";
import type { SigningRequest } from "./use-signing-request";

export interface RunControls {
  // back from the first confirmation stage to Configure, form kept
  readonly onBackToConfigure: () => void;
  // start over from Connect: everything is dropped, the wallet included
  readonly onReset: () => void;
  // leaves a prepared close for Configure on the same connection
  readonly onPreparedDone: () => void;
  // back to Configure after the run guard cancelled the run
  readonly onStartOverAfterCancel: () => void;
  readonly onRetry: () => void;
  // the typed confirmation: starts the close
  readonly confirmClose: (typed: string) => void;
  // submits a shared close's collected bundle
  readonly submitBundle: (signedXdr: string, typed: string, snapshot: SignerSnapshot) => void;
}

// what the user can do to a run once it exists: confirm it, retry it, go back
// or start over
export function useRunControls(args: {
  readonly send: (event: PageFlowEvent) => void;
  // read right after an event, to tell whether the machine took it
  readonly getMachineState: () => unknown;
  readonly runInput: PageFlowRunInput | null;
  readonly publicKey: string | null;
  // the navbar's network
  readonly networkId: string;
  readonly runMismatched: boolean;
  readonly blockers: readonly string[];
  readonly connector: FlowConnector;
  readonly choices: CloseChoices;
  readonly signing: SigningRequest;
  readonly setFormError: (error: string | null) => void;
  readonly setShowConfirmDialog: (open: boolean) => void;
  readonly disconnectWallet: () => void;
  readonly onTeardownError: (err: unknown) => void;
  readonly clearTeardownError: () => void;
}): RunControls {
  const { send, getMachineState, runInput, publicKey, networkId, runMismatched, blockers } = args;
  const { signing, setFormError, setShowConfirmDialog } = args;
  const { disconnectWallet, onTeardownError, clearTeardownError } = args;
  const { connectorRef, setConnector } = args.connector;
  const { clearChoices, resetForm } = args.choices;

  // back from the first confirmation stage returns to Configure with the form
  // as it was: the plan is discarded (cancel), then the run is reset to idle.
  // Nothing else cancels a run by hand, so a cancelled run on screen always
  // came from the run guard (wallet or network changed). The answers given for
  // that plan go with it: a price accepted once must be asked for again.
  const onBackToConfigure = useCallback(() => {
    setShowConfirmDialog(false);
    setFormError(null);
    clearChoices();
    signing.reset();
    send({ type: "CANCEL" });
    send({ type: "RESET" });
  }, [send, signing, clearChoices, setShowConfirmDialog, setFormError]);

  const onReset = useCallback(() => {
    setShowConfirmDialog(false);
    resetForm();
    clearChoices();
    setFormError(null);
    signing.reset();
    // the account we operated on is gone (merged) or abandoned, fully drop the
    // connection so "Start over" returns to Connect, not Configure with a dead
    // account still selected. disconnectSession tears down the connector + kit +
    // store.
    setConnector(null);
    clearTeardownError();
    void disconnectSession(disconnectWallet, onTeardownError);
    send({ type: "RESET" });
  }, [
    send,
    setConnector,
    disconnectWallet,
    signing,
    resetForm,
    clearChoices,
    onTeardownError,
    clearTeardownError,
    setShowConfirmDialog,
    setFormError,
  ]);

  // a prepared close leaves the account open: back to Configure with the same
  // connection, so the close can be finished once the withdrawal unlocks
  const onPreparedDone = useCallback(() => {
    setShowConfirmDialog(false);
    resetForm();
    clearChoices();
    setFormError(null);
    signing.reset();
    send({ type: "RESET" });
  }, [send, signing, resetForm, clearChoices, setShowConfirmDialog, setFormError]);

  // start over after a cancel: back to Configure for the same connection. the
  // cancel came from a wallet or network switch, so the answers given for the
  // old plan (accepted rates, held-token choices, forfeits) may belong to
  // another account and must be asked again
  const onStartOverAfterCancel = useCallback(() => {
    clearChoices();
    signing.reset();
    send({ type: "RESET" });
  }, [send, signing, clearChoices]);

  // a retry signs with the wallet connected now; without one the machine can
  // only rebuild the plan from fresh discovery
  const onRetry = useCallback(() => {
    if (runMismatched) return;
    send({ type: "RETRY", connector: connectorRef.current });
  }, [send, runMismatched, connectorRef]);

  // the confirm-dialog and Collect actions refuse a plan whose account or
  // network no longer match (the guard also cancels it). Each event also names
  // the account and network on screen, so the machine can refuse one that
  // doesn't match the run it holds. A refused event leaves the machine where it
  // was, and the page says so instead of doing nothing.
  const expected = { publicKey: publicKey ?? "", networkId };
  const confirmClose = (typed: string): void => {
    setShowConfirmDialog(false);
    if (runMismatched) return;
    send({ type: "CONFIRM", typed, expected });
    if (getMachineState() !== "executing") {
      setFormError(
        blockers[0] ??
          "The close didn't start: the confirmation didn't match the plan on screen. Review it and try again.",
      );
    }
  };

  // the collector hands up the relay's signer set it checked and trimmed the
  // bundle against, so the submit is bound to exactly that snapshot
  const submitBundle = (signedXdr: string, typed: string, snapshot: SignerSnapshot): void => {
    const activeRequest = signing.active;
    if (runMismatched || activeRequest === null || runInput === null) return;
    setFormError(null);
    send({
      type: "SUBMIT_BUNDLE",
      signedXdr,
      planId: activeRequest.planId,
      typed,
      expected,
      snapshot,
    });
    if (getMachineState() !== "executing") {
      setFormError(
        blockers[0] ??
          "The collected transaction doesn't match the reviewed close, so it was not submitted.",
      );
    }
  };

  return {
    onBackToConfigure,
    onReset,
    onPreparedDone,
    onStartOverAfterCancel,
    onRetry,
    confirmClose,
    submitBundle,
  };
}
