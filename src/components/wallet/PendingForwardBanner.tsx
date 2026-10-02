"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, Notice } from "@/components/ui";
import { resolveNetwork } from "@/lib/config/networks";
import { explorerTxUrl } from "@/lib/explorer";
import {
  inspectPendingForward,
  isCloseInFlight,
  loadPendingForwards,
  removePendingForward,
  resumePendingForward,
  subscribePendingForwards,
  waitForCloseIdle,
  type PendingForwardStatus,
  type PendingMediatorForward,
} from "@/lib/mediator/pending-flow";

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

interface Delivered {
  readonly record: PendingMediatorForward;
  readonly txHash: string;
}

// Recovery for exchange closes that were interrupted between the merge into the
// mediator and the forward out of it. Every stored record for the connected
// account is checked against the chain before anything is shown, so the banner
// only asks for action when the balance really sits in a mediator. It re-reads
// the records whenever they change (in this tab or another), and stays hidden
// while a close for this account is running somewhere.
export function PendingForwardBanner({
  publicKey,
}: {
  readonly publicKey: string | null;
}): React.JSX.Element | null {
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
        setRecords(loadPendingForwards(publicKey));
        setStorageError(null);
      } catch (err) {
        setStorageError(describeError(err, "Could not read browser storage."));
      }
    };
    read();
    return subscribePendingForwards(read);
  }, [publicKey]);

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

  // stable, so a row's chain check doesn't re-run on every banner render
  const onDelivered = useCallback((record: PendingMediatorForward, txHash: string): void => {
    setDelivered((prev) =>
      prev.some((d) => d.txHash === txHash) ? prev : [...prev, { record, txHash }],
    );
  }, []);

  if (publicKey === null) return null;

  return (
    <>
      {storageError !== null ? (
        <Notice tone="danger" role="alert" title="Exchange-forward recovery is unavailable">
          {storageError} If a previous close to an exchange was interrupted, keep this browser
          profile and contact the operator before clearing site data.
        </Notice>
      ) : null}
      {delivered
        .filter((d) => d.record.publicKey === publicKey)
        .map((d) => (
          <Notice key={d.txHash} tone="success" role="status" title="Exchange forward delivered">
            The balance from your earlier close reached {shorten(d.record.ultimateDestination)}.{" "}
            <a
              href={explorerTxUrl(resolveNetwork(d.record.networkId), d.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              View the forward transaction
            </a>
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
        ))}
      {inFlight !== false
        ? null
        : records.map((record) => (
            <PendingForwardRow
              key={`${record.networkId}:${record.mediatorPublicKey}`}
              record={record}
              onDelivered={onDelivered}
            />
          ))}
    </>
  );
}

type RowState =
  | { readonly kind: "checking" }
  | { readonly kind: "check-failed"; readonly error: string }
  | PendingForwardStatus;

function PendingForwardRow({
  record,
  onDelivered,
}: {
  readonly record: PendingMediatorForward;
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
        setState(status);
      })
      .catch((err: unknown) => {
        if (live) setState({ kind: "check-failed", error: describeError(err, "Horizon error.") });
      });
    return () => {
      live = false;
    };
  }, [record, check, onDelivered]);

  const network = resolveNetwork(record.networkId);

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
    case "delivered":
      return null;
    case "check-failed":
      return (
        <Notice tone="warning" role="alert" title="Could not check an interrupted exchange forward">
          A previous close to {shorten(record.ultimateDestination)} on {network.id} left a recovery
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
          A previous close merged your account&apos;s balance into the temporary account{" "}
          {shorten(record.mediatorPublicKey)} on {network.id}, but the forward to{" "}
          {shorten(record.ultimateDestination)} has not gone out. Resume it to deliver the balance
          with your deposit memo.
          {errorLine}
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
    case "misdirected":
      return (
        <Notice tone="danger" role="alert" title="Exchange forward went to another address">
          The temporary account {shorten(record.mediatorPublicKey)} was merged into{" "}
          {shorten(state.into)}, not {shorten(record.ultimateDestination)}. Contact the operator
          with transaction{" "}
          <a href={explorerTxUrl(network, state.txHash)} target="_blank" rel="noreferrer">
            {shorten(state.txHash)}
          </a>
          .
        </Notice>
      );
    case "not-merged":
      return (
        <Notice tone="neutral" title="An earlier exchange close stopped before the merge">
          A previous close to {shorten(record.ultimateDestination)} on {network.id} ended before
          your account was merged into its temporary account, so your balance did not move.
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
