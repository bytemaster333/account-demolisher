"use client";

// destructive-action confirmation. confirm enables once the last 4 chars are typed AND 5s elapse.

import { useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface TypedConfirmationProps {
  // full destination G-address; the last 4 chars are the required confirmation string
  readonly destination: string;
  // delay before confirm enables. defaults to 5000ms.
  readonly delayMs?: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly className?: string;
}

const DEFAULT_DELAY_MS = 5000;

export function TypedConfirmation({
  destination,
  delayMs = DEFAULT_DELAY_MS,
  onConfirm,
  onCancel,
  className,
}: TypedConfirmationProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const required = destination.slice(-4);
  const [typed, setTyped] = useState("");
  // start true when delay is non-positive so tests can skip the wait
  const [delayElapsed, setDelayElapsed] = useState(delayMs <= 0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (delayMs <= 0) return;
    const handle = setTimeout(() => {
      setDelayElapsed(true);
    }, delayMs);
    return () => clearTimeout(handle);
  }, [delayMs]);

  const matches = typed === required && required.length > 0;
  const confirmDisabled = !matches || !delayElapsed;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="typed-confirmation"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-slate-300 bg-white p-6 shadow-xl">
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">
          Confirm demolition
        </h2>
        <p id={descriptionId} className="text-sm text-slate-700">
          This action is irreversible. To proceed, type the{" "}
          <strong className="font-semibold">last 4 characters</strong> of the destination address.
        </p>
        <p className="rounded-md bg-slate-100 px-3 py-2 font-mono text-xs text-slate-900">
          Destination: <span className="font-semibold">{destination || "(empty)"}</span>
        </p>

        <label htmlFor={inputId} className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-800">
            Last 4 characters: <span className="font-mono">{required || "----"}</span>
          </span>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            maxLength={4}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            data-testid="typed-confirmation-input"
            aria-invalid={typed.length === 4 && !matches}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </label>

        <p
          aria-live="polite"
          data-testid="typed-confirmation-status"
          className={cn(
            "text-xs",
            delayElapsed ? "text-slate-600" : "text-amber-700",
            matches && delayElapsed ? "text-emerald-700" : null,
          )}
        >
          {!delayElapsed
            ? `Wait ${Math.ceil(delayMs / 1000)}s before confirming…`
            : matches
              ? "Match. You may confirm."
              : "Type the 4 characters above to enable Confirm."}
        </p>

        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="typed-confirmation-cancel"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            data-testid="typed-confirmation-confirm"
            className={cn(
              "rounded-md px-4 py-2 text-sm font-medium text-white transition-colors",
              "bg-red-700 hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-900",
              "disabled:cursor-not-allowed disabled:bg-red-300",
            )}
          >
            Confirm demolition
          </button>
        </div>
      </div>
    </div>
  );
}
