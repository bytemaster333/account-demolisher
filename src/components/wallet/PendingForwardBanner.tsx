"use client";

import { useEffect, useState } from "react";

import { Button, Notice } from "@/components/ui";
import {
  loadPendingForward,
  resumePendingForward,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// SEC-01 part B: if a prior close was interrupted after the merge-into-mediator
// landed but before the forward swept the funds out, a recovery record is stored
// for the connected account. Surface it and let the user resume the forward.
export function PendingForwardBanner({
  publicKey,
}: {
  readonly publicKey: string | null;
}): React.JSX.Element | null {
  const [pending, setPending] = useState<PendingMediatorForward | null>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // localStorage is not reactive and is unavailable during SSR, so the pending
    // record must be read on mount / when the connected account changes — the
    // documented exception to the set-state-in-effect heuristic.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(publicKey === null ? null : loadPendingForward(publicKey));
  }, [publicKey]);

  if (pending === null) return null;

  const onResume = async (): Promise<void> => {
    setResuming(true);
    setError(null);
    const result = await resumePendingForward(pending);
    if (result.ok) {
      setPending(null);
    } else {
      setError(result.error);
    }
    setResuming(false);
  };

  return (
    <Notice tone="warning" role="alert" title="An exchange forward was interrupted">
      A previous close moved your account&apos;s balance into a temporary mediator account, but the
      final forward to {shorten(pending.ultimateDestination)} did not finish. Resume it to sweep
      those funds to your destination.
      {error ? (
        <div style={{ marginTop: 8, color: "var(--danger)", fontSize: 12.5 }}>{error}</div>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <Button
          variant="primary"
          onClick={() => void onResume()}
          loading={resuming}
          disabled={resuming}
        >
          {resuming ? "Resuming…" : "Resume the forward"}
        </Button>
      </div>
    </Notice>
  );
}
