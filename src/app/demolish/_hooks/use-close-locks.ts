"use client";

import { useEffect } from "react";

import { useCloseBusy } from "@/stores/close-busy";
import { useNetworkStore } from "@/stores/network";

// while a close runs, or signatures are being gathered for one, switching the
// network or the wallet would tear down the session it signs with, and leaving
// the page would stop it partway
export function useCloseLocks(args: {
  readonly isExecuting: boolean;
  // the Signatures step is on screen for the current run
  readonly collecting: boolean;
  readonly gatheringSignatures: boolean;
}): void {
  const { isExecuting, collecting, gatheringSignatures } = args;
  const setLockReason = useNetworkStore((s) => s.setLockReason);

  useEffect(() => {
    setLockReason(
      isExecuting
        ? "A close is running on this network. Switch after it finishes."
        : gatheringSignatures
          ? "Signatures are being collected for this close."
          : null,
    );
  }, [isExecuting, gatheringSignatures, setLockReason]);
  useEffect(() => {
    useCloseBusy.getState().setBusy(isExecuting);
  }, [isExecuting]);
  useEffect(
    () => () => {
      useNetworkStore.getState().setLockReason(null);
      useCloseBusy.getState().setBusy(false);
    },
    [],
  );

  // guard against navigating away / closing the tab mid-execution, a partial
  // run leaves the account half-dismantled; while signatures are being
  // collected, leaving drops the live view of them.
  useEffect(() => {
    if (!isExecuting && !collecting) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isExecuting, collecting]);
}
