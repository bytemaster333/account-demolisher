"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/errors";
import { explorerTxUrl } from "@/lib/explorer";
import {
  inspectPendingForward,
  isCloseInFlight,
  legacyFlowId,
  loadPendingForwards,
  pendingForwardNetwork,
  removePendingForward,
  resumePendingForward,
  subscribePendingForwards,
  waitForCloseIdle,
  type PendingForwardStatus,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";

// how often a row that has nothing to offer yet asks the chain again. nothing
// writes storage when a merge lands and the forward after it fails, so without
// this a row that looked too early would stay quiet for good.
export const PENDING_FORWARD_RECHECK_MS = 30_000;

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function describeError(err: unknown, fallback: string): string {
  return errorMessage(err, fallback);
}

interface Delivered {
  readonly record: PendingMediatorForward;
  readonly txHash: string;
}

export interface PendingForwardBannerProps {
  readonly publicKey: string | null;
  // only this flow's record; for a banner that belongs to one close
  readonly mediatorPublicKey?: string;
  // the banner sits in the view of the close that just failed, so it speaks of
  // "this close" rather than "a previous close"
  readonly current?: boolean;
  // called once a shown record's forward is delivered (resumed here, or found
  // already delivered on chain)
  readonly onResolved?: () => void;
}

// Recovery for exchange closes that were interrupted between the merge into the
// mediator and the forward out of it. Every stored record for the connected
// account is checked against the chain before anything is shown, so the banner
// only asks for action when the balance really sits in a mediator. It re-reads
// the records whenever they change (in this tab or another), rechecks rows that
// had nothing to show yet, and stays hidden while a close for this account is
// running somewhere.
export function PendingForwardBanner({
  publicKey,
  mediatorPublicKey,
  current = false,
  onResolved,
}: PendingForwardBannerProps): React.JSX.Element | null {
  const [records, setRecords] = useState<readonly PendingMediatorForward[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  // null until the first check answers, so nothing flashes up for a close
  // that another tab is still running
  const [inFlight, setInFlight] = useState<boolean | null>(null);
  const [delivered, setDelivered] = useState<readonly Delivered[]>([]);

  useEffect(() => {
    if (publicKey === null) {
      // localStorage is not reactive and is unavailable during SSR, so the
      // records are read here and on every change notification
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecords([]);
      return;
    }
    const read = (): void => {
      try {
        const all = loadPendingForwards(publicKey);
        setRecords(
          mediatorPublicKey === undefined
            ? all
            : all.filter((r) => r.mediatorPublicKey === mediatorPublicKey),
        );
        setStorageError(null);
      } catch (err) {
        setStorageError(describeError(err, "Could not read browser storage."));
      }
    };
    read();
    return subscribePendingForwards(read);
  }, [publicKey, mediatorPublicKey]);

  // hide while a close for this account holds the lock, and look again once
  // it lets go: that is when an in-session forward failure becomes visible
  useEffect(() => {
    if (publicKey === null) return;
    const controller = new AbortController();
    const watch = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const busy = await isCloseInFlight(publicKey);
        if (controller.signal.aborted) return;
        setInFlight(busy);
        if (!busy) return;
        await waitForCloseIdle(publicKey, controller.signal);
      }
    };
    watch().catch((err: unknown) => {
      if (!controller.signal.aborted) {
        setStorageError(describeError(err, "Could not check whether a close is running."));
      }
    });
    return () => controller.abort();
  }, [publicKey, records]);

  // the parent's callback lives in a ref so onDelivered stays stable: a row's
  // chain check depends on it, and an inline callback would otherwise send a
  // horizon request on every parent render
  const onResolvedRef = useRef(onResolved);
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);
  // a delivery can be seen more than once (the record is written again by
  // another tab, or the row re-checks), but the parent hears about it once
  const reported = useRef(new Set<string>());

  const onDelivered = useCallback((record: PendingMediatorForward, txHash: string): void => {
    setDelivered((prev) =>
      prev.some((d) => d.txHash === txHash) ? prev : [...prev, { record, txHash }],
    );
    if (reported.current.has(txHash)) return;
    reported.current.add(txHash);
    onResolvedRef.current?.();
  }, []);

  if (publicKey === null) return null;
  const subject = current ? "This close" : "A previous close";

  return (
    <>
      {storageError !== null ? (
        <Notice tone="danger" role="alert" title="Exchange-forward recovery is unavailable">
          {storageError} If a close to an exchange was interrupted, keep this browser profile and
          contact the operator before clearing site data.
        </Notice>
      ) : null}
      {delivered
        .filter((d) => d.record.publicKey === publicKey)
        .map((d) => {
          const network = pendingForwardNetwork(d.record);
          return (
            <Notice key={d.txHash} tone="success" role="status" title="Exchange forward delivered">
              The balance from {current ? "this" : "your earlier"} close reached{" "}
              {shorten(d.record.ultimateDestination)}.{" "}
              {network !== null ? (
                <a href={explorerTxUrl(network, d.txHash)} target="_blank" rel="noreferrer">
                  View the forward transaction
                </a>
              ) : null}
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDelivered((prev) => prev.filter((x) => x.txHash !== d.txHash))}
                >
                  Dismiss
                </Button>
              </div>
            </Notice>
          );
        })}
      {inFlight !== false
        ? null
        : records.map((record) => (
            <PendingForwardRow
              key={`${record.networkId}:${record.mediatorPublicKey}`}
              record={record}
              subject={subject}
              onDelivered={onDelivered}
            />
          ))}
    </>
  );
}

// a record is written when a close starts, well before its merge. Until it is
// this old, "no merge yet" may just mean the close is still on its way there;
// nothing has moved, so there is no reason to speak up early.
const NOT_MERGED_QUIET_MS = 15 * 60 * 1000;

type RowState =
  | { readonly kind: "checking" }
  | { readonly kind: "quiet" }
  | { readonly kind: "check-failed"; readonly error: string }
  | PendingForwardStatus;

function PendingForwardRow({
  record,
  subject,
  onDelivered,
}: {
  readonly record: PendingMediatorForward;
  readonly subject: string;
  readonly onDelivered: (record: PendingMediatorForward, txHash: string) => void;
}): React.JSX.Element | null {
  const [state, setState] = useState<RowState>({ kind: "checking" });
  const [check, setCheck] = useState(0);
  const [resuming, setResuming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    inspectPendingForward(record)
      .then((status) => {
        if (!live) return;
        if (status.kind === "delivered") {
          onDelivered(record, status.txHash);
          removePendingForward(record);
          return;
        }
        if (status.kind === "not-merged" && Date.now() - record.savedAt < NOT_MERGED_QUIET_MS) {
          setState({ kind: "quiet" });
          return;
        }
        setState(status);
      })
      .catch((err: unknown) => {
        if (live) setState({ kind: "check-failed", error: describeError(err, "Horizon error.") });
      });
    return () => {
      live = false;
    };
  }, [record, check, onDelivered]);

  // a merge can still land under a row that saw none: the close was running
  // without a lock, or this tab looked before the merge
  const waiting = state.kind === "quiet" || state.kind === "not-merged";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setCheck((n) => n + 1), PENDING_FORWARD_RECHECK_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  const network = pendingForwardNetwork(record);
  const networkName = network?.id ?? record.networkId;
  const legacyId = legacyFlowId(record.flowToken);

  const onResume = async (): Promise<void> => {
    setResuming(true);
    setActionError(null);
    try {
      const result = await resumePendingForward(record);
      if (result.ok) onDelivered(record, result.txHash);
      else setActionError(result.error);
    } catch (err) {
      setActionError(describeError(err, "Could not resume the forward. Try again."));
    } finally {
      setResuming(false);
    }
  };

  const onDismiss = (): void => {
    try {
      removePendingForward(record);
    } catch (err) {
      setActionError(describeError(err, "Could not remove the record."));
    }
  };

  const errorLine =
    actionError !== null ? (
      <div style={{ marginTop: 8, color: "var(--danger)", fontSize: 12.5 }}>{actionError}</div>
    ) : null;

  switch (state.kind) {
    // a delivered record is handed to the banner and removed, never kept as row state
    case "checking":
    case "quiet":
    case "delivered":
      return null;
    case "check-failed":
      return (
        <Notice tone="warning" role="alert" title="Could not check an interrupted exchange forward">
          {subject} to {shorten(record.ultimateDestination)} on {networkName} left a recovery
          record, but its state could not be read from Horizon: {state.error}
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={() => setCheck((n) => n + 1)}>
              Check again
            </Button>
          </div>
        </Notice>
      );
    case "awaiting-forward":
      return (
        <Notice tone="warning" role="alert" title="An exchange forward was interrupted">
          {subject} merged your account&apos;s balance into the temporary account{" "}
          {shorten(record.mediatorPublicKey)} on {networkName}, but the forward to{" "}
          {shorten(record.ultimateDestination)} has not gone out.{" "}
          {legacyId !== null ? (
            <>
              The record was saved by an earlier version of the app, whose flow token can no longer
              be renewed, so the app can&apos;t send the forward. Contact the operator with the
              temporary account {record.mediatorPublicKey} and flow id {legacyId}; the balance stays
              in that account until then.
            </>
          ) : (
            <>Resume it to deliver the balance with your deposit memo.</>
          )}
          {errorLine}
          {legacyId === null ? (
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
          ) : null}
        </Notice>
      );
    case "misdirected":
      return (
        <Notice tone="danger" role="alert" title="Exchange forward went to another address">
          The temporary account {shorten(record.mediatorPublicKey)} was merged into{" "}
          {shorten(state.into)}, not {shorten(record.ultimateDestination)}. Contact the operator
          with transaction{" "}
          {network !== null ? (
            <a href={explorerTxUrl(network, state.txHash)} target="_blank" rel="noreferrer">
              {shorten(state.txHash)}
            </a>
          ) : (
            state.txHash
          )}
          .
        </Notice>
      );
    case "not-merged":
      return (
        <Notice tone="neutral" title="An earlier exchange close stopped before the merge">
          {subject} to {shorten(record.ultimateDestination)} on {networkName} ended before your
          account was merged into its temporary account, so your balance did not move.
          {state.mediatorBalance !== null
            ? ` The temporary account ${shorten(record.mediatorPublicKey)} still holds ${state.mediatorBalance} XLM of funding from that attempt. This record is the only way the app can reach it; dismissing it gives that amount up.`
            : null}
          {errorLine}
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </Notice>
      );
  }
}
