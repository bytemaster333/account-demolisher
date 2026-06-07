"use client";

// full-screen block when audit.flags.authImmutable is true. no continue path.

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

export interface AuthImmutableBlockProps {
  // back / dismiss handler
  readonly onDismiss?: () => void;
  readonly className?: string;
}

export function AuthImmutableBlock({
  onDismiss,
  className,
}: AuthImmutableBlockProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="auth-immutable-block"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-red-950/80 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border-2 border-red-700 bg-white p-6 shadow-2xl">
        <h2 id={titleId} className="text-xl font-semibold text-red-900">
          Account is permanently unmergeable
        </h2>
        <div id={descriptionId} className="flex flex-col gap-3 text-sm text-slate-800">
          <p>
            This account has the <code className="font-mono text-red-900">AUTH_IMMUTABLE</code> flag
            set. Once that flag is enabled, the Stellar protocol forbids clearing it. As a
            consequence:
          </p>
          <ul className="list-disc space-y-1 pl-6">
            <li>The account can never be merged into another.</li>
            <li>Issued asset trustlines on this account can never be revoked.</li>
            <li>Any XLM remaining in this account is locked forever.</li>
          </ul>
          <p>
            Account Demolisher cannot help here. There is no path through this tool, or any other,
            that will recover the funds.
          </p>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            ref={buttonRef}
            type="button"
            onClick={onDismiss}
            data-testid="auth-immutable-block-dismiss"
            className="rounded-md border border-red-700 bg-white px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-900"
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
