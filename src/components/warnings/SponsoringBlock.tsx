"use client";

// full-screen block when audit.sponsorship.numSponsoring > 0. account can't be merged until sponsorships are resolved.

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

export interface SponsoringBlockProps {
  // audit.sponsorship.numSponsoring
  readonly numSponsoring: number;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

export function SponsoringBlock({
  numSponsoring,
  onDismiss,
  className,
}: SponsoringBlockProps): React.JSX.Element {
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
      data-testid="sponsoring-block"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-amber-950/70 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-lg border-2 border-amber-600 bg-white p-6 shadow-2xl">
        <h2 id={titleId} className="text-xl font-semibold text-amber-900">
          Account is sponsoring third-party reserves
        </h2>
        <div id={descriptionId} className="flex flex-col gap-3 text-sm text-slate-800">
          <p>
            This account is sponsoring{" "}
            <strong
              data-testid="sponsoring-block-count"
              className="font-mono font-semibold text-amber-900"
            >
              {numSponsoring}
            </strong>{" "}
            subentries belonging to other accounts. Stellar refuses to merge an account whose
            sponsorship count is non-zero.
          </p>
          <p>
            Resolving this requires each sponsored party to either revoke the sponsored entry or
            transfer the sponsorship to another account. That is a cooperative step Account
            Demolisher cannot perform unilaterally.
          </p>
          <p>
            Coordinate with the sponsored parties off-line, complete the sponsorship transfers, then
            re-run the audit.
          </p>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            ref={buttonRef}
            type="button"
            onClick={onDismiss}
            data-testid="sponsoring-block-dismiss"
            className="rounded-md border border-amber-600 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-900"
          >
            Go back
          </button>
        </div>
      </div>
    </div>
  );
}
