"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PlanTree } from "@/lib/plan/tree";

import type { ConfirmStage } from "../_lib/flow-steps";

// the awaiting_confirmation phase has three stages:
//  "resolve"    , act on what blocks the close + rebuild
//  "acknowledge", read-and-understand every warning / info card
//  "review"     , the clean "here is what will happen" review + demolish
// the stage is initialised per built plan, skipping any empty step. The final
// typed-confirmation dialog opens from the review step.
export function useConfirmStage(args: {
  readonly tree: PlanTree | null;
  readonly isAwaitingConfirmation: boolean;
  readonly hasBlocker: boolean;
  readonly hasAckItems: boolean;
  readonly setFormError: (error: string | null) => void;
}): {
  readonly confirmStage: ConfirmStage;
  readonly goToStage: (stage: ConfirmStage) => void;
  readonly showConfirmDialog: boolean;
  readonly setShowConfirmDialog: (open: boolean) => void;
} {
  const { tree, isAwaitingConfirmation, hasBlocker, hasAckItems, setFormError } = args;
  const [confirmStage, setConfirmStage] = useState<ConfirmStage>("review");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  // initialise the confirm stage per built plan: resolve blockers first, then
  // acknowledge warnings/info, then the clean review, skipping any empty step.
  // a refusal shown for the previous plan doesn't belong to the new one
  const initedTreeRef = useRef<unknown>(null);
  useEffect(() => {
    if (tree !== null && isAwaitingConfirmation) {
      if (initedTreeRef.current !== tree) {
        initedTreeRef.current = tree;
        setConfirmStage(hasBlocker ? "resolve" : hasAckItems ? "acknowledge" : "review");
        setShowConfirmDialog(false);
        setFormError(null);
      }
    } else if (tree === null) {
      initedTreeRef.current = null;
    }
  }, [tree, isAwaitingConfirmation, hasBlocker, hasAckItems, setFormError]);

  const goToStage = useCallback(
    (stage: ConfirmStage) => {
      setFormError(null);
      setConfirmStage(stage);
    },
    [setFormError],
  );

  return { confirmStage, goToStage, showConfirmDialog, setShowConfirmDialog };
}
