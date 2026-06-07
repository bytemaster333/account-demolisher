"use client";

// non-blocking warning for claimable balances whose predicates aren't yet satisfied.
// merging forfeits the claim; defer is the safe default.

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

export interface PendingClaimableBalanceEntry {
  readonly id: string;
  // decimal string
  readonly amount: string;
  // asset code or "XLM"
  readonly assetLabel: string;
  // optional reason why it isn't claimable yet
  readonly reason?: string;
}

export interface PendingClaimableBalancesProps {
  readonly pending: readonly PendingClaimableBalanceEntry[];
  readonly onDefer: () => void;
  readonly onProceed: () => void;
  readonly className?: string;
}

export function PendingClaimableBalances({
  pending,
  onDefer,
  onProceed,
  className,
}: PendingClaimableBalancesProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const deferRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    deferRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="pending-claimable-balances"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border border-amber-400 bg-white p-6 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-amber-900">
          Pending claimable balances will be forfeited
        </h2>
        <p id={descriptionId} className="text-sm text-slate-700">
          You are a claimant on the following claimable balances, but their predicates have not yet
          become claimable. If you merge now, you will forfeit your claim on each of them.
        </p>
        <ul
          data-testid="pending-claimable-balances-list"
          className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-md border border-amber-200 bg-amber-50 p-3 text-xs"
        >
          {pending.length === 0 ? (
            <li className="text-slate-600">No pending claimable balances.</li>
          ) : (
            pending.map((cb) => (
              <li key={cb.id} className="flex flex-col gap-0.5 font-mono">
                <span className="font-semibold text-amber-900">
                  {cb.amount} {cb.assetLabel}
                </span>
                <span className="text-slate-700">id: {cb.id}</span>
                {cb.reason !== undefined ? (
                  <span className="text-slate-600">reason: {cb.reason}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>

        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            ref={deferRef}
            type="button"
            onClick={onDefer}
            data-testid="pending-claimable-balances-defer"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            Defer
          </button>
          <button
            type="button"
            onClick={onProceed}
            data-testid="pending-claimable-balances-proceed"
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-900"
          >
            Forfeit and proceed
          </button>
        </div>
      </div>
    </div>
  );
}
