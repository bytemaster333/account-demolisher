"use client";

// bulk revoke controller. sits above the AllowanceList and revokes many
// standing approvals in one sweep: all active, or only those to unknown
// spenders. every approve(amount=0) is built first and the summed fee is shown
// for the user to accept before anything is signed. the sweep then runs strictly
// sequentially: each revoke is submitted and confirmed on-chain before the next,
// because the next tx carries the following sequence number and would be
// rejected as tx_bad_seq if the previous hadn't landed yet. one wallet signature
// per approval.

import { useEffect, useMemo, useRef, useState } from "react";

import { isActive } from "@/components/allowance-viewer/allowance-state";
import { Button, Card, Notice, Progress, Spinner } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import {
  confirmRevoke,
  prepareRevokes,
  submitPreparedRevoke,
  type PreparedRevoke,
} from "@/lib/soroban/revoke";
import { lookupSpender } from "@/lib/soroban/spender-registry";
import { stroopsToTrimmedDecimal } from "@/lib/stellar/amount";
import type { Connector } from "@/lib/wallet/connector";
import { useNetworkStore } from "@/stores/network";
import { shortAddress } from "@/lib/safe-display";

export interface BulkRevokeBarProps {
  readonly records: readonly AllowanceRecord[];
  readonly userAddress: string;
  readonly network: NetworkConfig;
  // null = wallet can't sign here; an idle bar renders nothing, a running or
  // finished sweep keeps its card. ref read only in handlers
  readonly connectorRef: React.RefObject<Connector | null> | null;
  // re-enumerate after the sweep so revoked (now-expired) rows drop out
  readonly onComplete: () => void;
  // reports whether a sweep is running, so the caller can disable per-row revokes
  readonly onRunningChange?: (running: boolean) => void;
}

type Outcome =
  | { readonly record: AllowanceRecord; readonly ok: true; readonly hash: string }
  | { readonly record: AllowanceRecord; readonly ok: false; readonly error: string };

type Failure = Extract<Outcome, { ok: false }>;

type Phase = "idle" | "preparing" | "confirm" | "running" | "done";

export function BulkRevokeBar({
  records,
  userAddress,
  network,
  connectorRef,
  onComplete,
  onRunningChange,
}: BulkRevokeBarProps): React.JSX.Element | null {
  const activeRevocable = useMemo(() => records.filter(isActive), [records]);
  const unknownActive = useMemo(
    () => activeRevocable.filter((r) => lookupSpender(r.spender, network) === null),
    [activeRevocable, network],
  );

  const [phase, setPhase] = useState<Phase>("idle");
  // the built revokes whose summed fee is on screen, in signing order
  const [prepared, setPrepared] = useState<readonly PreparedRevoke[]>([]);
  // records that could not be built (simulation error, auth guard, fee cap);
  // nothing is signed for them
  const [notPrepared, setNotPrepared] = useState<readonly Failure[]>([]);
  // set when building could not start at all (account or ledger read failed)
  const [prepError, setPrepError] = useState<string | null>(null);
  const [prepTotal, setPrepTotal] = useState(0);
  const [prepDone, setPrepDone] = useState(0);
  const prepAbort = useRef<AbortController | null>(null);
  const [total, setTotal] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [current, setCurrent] = useState<AllowanceRecord | null>(null);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [stopping, setStopping] = useState(false);
  // why the sweep ended early, when it wasn't the user's own stop
  const [stopReason, setStopReason] = useState<string | null>(null);
  // read synchronously inside the loop; the state above only drives the label
  const stopRef = useRef(false);

  // on unmount (e.g. client-side navigation away from /allowances) halt the loop
  // so it can't keep submitting real approve(0) txs with the Stop control gone.
  // stops at the next iteration check; a signature already in flight still lands.
  const mountedRef = useRef(true);
  useEffect(() => {
    // reset on (re)mount: under StrictMode's mount/unmount/remount the cleanup
    // below would otherwise leave it false and the sweep loop would halt at once.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
      prepAbort.current?.abort();
    };
  }, []);

  // tell the caller when a sweep is running so it can disable per-row revokes
  useEffect(() => {
    onRunningChange?.(phase === "running");
  }, [phase, onRunningChange]);

  // a mid-sweep network switch invalidates the connected account and the
  // closed-over network the loop is still signing against; treat it as a stop.
  // skip the initial mount (only an actual switch should abort a sweep).
  const networkId = useNetworkStore((s) => s.networkId);
  const initialNetworkId = useRef(networkId);
  useEffect(() => {
    if (networkId === initialNetworkId.current) return;
    stopRef.current = true;
    setStopping(true);
  }, [networkId]);

  // warn before a tab close / reload while a sweep is live. A partial run leaves
  // some approvals revoked and others not, and an in-flight signature could still
  // land. Mirrors the demolish execute-phase beforeunload guard.
  useEffect(() => {
    if (phase !== "running") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  // build every revoke and read its fee; nothing is signed here
  const ask = async (list: readonly AllowanceRecord[]): Promise<void> => {
    const connector = connectorRef?.current ?? null;
    setPrepared([]);
    setNotPrepared([]);
    setPrepError(null);
    setPrepTotal(list.length);
    setPrepDone(0);
    if (connector === null) {
      setPrepError("Connect the wallet that owns this address to revoke.");
      setPhase("confirm");
      return;
    }
    const controller = new AbortController();
    prepAbort.current = controller;
    setPhase("preparing");
    try {
      const result = await prepareRevokes(network, connector, list, userAddress, {
        signal: controller.signal,
        onProgress: (done) => {
          if (!controller.signal.aborted) setPrepDone(done);
        },
      });
      if (controller.signal.aborted) return;
      setPrepared(result.prepared);
      setNotPrepared(
        result.failed.map((f) => ({
          record: f.record,
          ok: false,
          error: errorMessage(f.error, "Could not build the revoke."),
        })),
      );
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      setPrepError(errorMessage(e, "Could not build the revokes."));
    } finally {
      if (prepAbort.current === controller) prepAbort.current = null;
    }
    setPhase("confirm");
  };

  const cancelPrepare = (): void => {
    prepAbort.current?.abort();
    setPhase("idle");
  };

  const run = async (list: readonly PreparedRevoke[]): Promise<void> => {
    stopRef.current = false;
    setStopping(false);
    setPhase("running");
    setTotal(list.length);
    setDoneCount(0);
    setOutcomes([]);
    setCurrent(null);
    setStopReason(null);

    const acc: Outcome[] = [];
    for (const [i, revoke] of list.entries()) {
      const record = revoke.record;
      if (stopRef.current) break;
      const connector = connectorRef?.current ?? null;
      if (connector === null) {
        // every later revoke would fail the same way; stop once and say so
        const left = list.length - i;
        setStopReason(
          `Stopped: wallet disconnected. ${left} approval${left === 1 ? " was" : "s were"} not attempted.`,
        );
        break;
      }
      setCurrent(record);
      try {
        // signs the reviewed tx, or a rebuilt one that costs no more than the
        // fee the user accepted; a dearer one throws and nothing is signed
        const hash = await submitPreparedRevoke(connector, revoke);
        await confirmRevoke(network, hash);
        acc.push({ record, ok: true, hash });
      } catch (e: unknown) {
        acc.push({ record, ok: false, error: errorMessage(e, "Revoke failed.") });
      }
      // if we unmounted while awaiting, stop before touching state or the next tx
      if (!mountedRef.current) break;
      setOutcomes([...acc]);
      setDoneCount(acc.length);
    }
    if (!mountedRef.current) return;
    setCurrent(null);
    setPhase("done");
  };

  if (phase === "running") {
    const succeeded = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - succeeded;
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-running">
        <Progress
          value={doneCount}
          max={total}
          tone="accent"
          label="Revoking approvals"
          valueLabel={`${doneCount} / ${total}`}
          data-testid="bulk-revoke-progress"
        />
        <div style={{ marginTop: 12 }}>
          <Notice tone="warning" role="alert">
            Keep this tab open until the sweep finishes. Each approval is a separate signature and
            transaction; leaving now would revoke some but not others.
          </Notice>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 14,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            <Spinner size={14} />
            {current !== null
              ? `Revoking ${doneCount + 1} of ${total}: approve your wallet prompt for ${shortAddress(current.spender)}`
              : stopping
                ? "Finishing current revoke…"
                : "Working…"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={stopping}
            onClick={() => {
              // ref drives the loop; state drives this label
              stopRef.current = true;
              setStopping(true);
            }}
            data-testid="bulk-revoke-stop"
          >
            {stopping ? "Stopping…" : "Stop after current"}
          </Button>
        </div>
        {failed > 0 ? (
          <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--danger)" }}>
            {failed} failed so far · {succeeded} revoked.
          </p>
        ) : null}
      </Card>
    );
  }

  if (phase === "done") {
    const succeeded = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o): o is Failure => !o.ok);
    // the ones that were never built count as failed too, and a retry covers them
    const retryable = [...failures, ...notPrepared];
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-done">
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          Revoked {succeeded.length} of {outcomes.length}
          {failures.length > 0 ? ` · ${failures.length} failed` : ""}
        </div>
        {stopReason !== null ? (
          <p role="status" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--warning)" }}>
            {stopReason}
          </p>
        ) : null}
        {notPrepared.length > 0 ? (
          <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--warning)" }}>
            {notPrepared.length} could not be built and {notPrepared.length === 1 ? "was" : "were"}{" "}
            not signed.
          </p>
        ) : null}
        {retryable.length > 0 ? (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            {retryable.map((f) => (
              <div
                key={`${f.record.contractId}|${f.record.spender}`}
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                  fontFamily: '"Geist Mono", monospace',
                }}
              >
                <span style={{ color: "var(--danger)" }}>✕</span> {shortAddress(f.record.spender)}:{" "}
                <span style={{ fontFamily: "Geist, sans-serif" }}>{f.error}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          {retryable.length > 0 && connectorRef !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void ask(retryable.map((f) => f.record))}
              data-testid="bulk-revoke-retry"
            >
              Retry {retryable.length} failed
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPhase("idle");
              onComplete();
            }}
            data-testid="bulk-revoke-refresh"
          >
            Refresh list
          </Button>
        </div>
      </Card>
    );
  }

  // bulk only earns its place for 2+ active approvals; one row's own button is enough
  if (connectorRef === null || activeRevocable.length < 2) return null;

  const hasUnknownSubset =
    unknownActive.length > 0 && unknownActive.length < activeRevocable.length;

  if (phase === "preparing") {
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-preparing">
        <Progress
          value={prepDone}
          max={prepTotal}
          tone="accent"
          label="Building revokes and reading their fees"
          valueLabel={`${prepDone} / ${prepTotal}`}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelPrepare}
            data-testid="bulk-revoke-prepare-cancel"
          >
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  if (phase === "confirm") {
    const totalFee = prepared.reduce((sum, p) => sum + p.fee.totalFee, 0n);
    const n = prepared.length;
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-confirm">
        {prepError !== null ? (
          <Notice tone="danger" role="alert" title="Could not build the revokes">
            {prepError}
          </Notice>
        ) : n > 0 ? (
          <Notice tone="warning" title={`Revoke ${n} approval${n === 1 ? "" : "s"}?`}>
            <span data-testid="bulk-revoke-fee-total">
              Network fees: up to{" "}
              <strong style={{ fontFamily: '"Geist Mono", monospace' }}>
                {stroopsToTrimmedDecimal(totalFee)} XLM
              </strong>{" "}
              in total.
            </span>{" "}
            Your wallet will prompt you to sign each one: {n} signature
            {n === 1 ? "" : "s"} in total. Each revoke is submitted and confirmed on-chain before
            the next, so this can take a couple of minutes. None is signed for more than its fee
            here; one whose fee has gone up by then is skipped and you can review it again. You can
            stop after any approval.
          </Notice>
        ) : null}
        {notPrepared.length > 0 ? (
          <div style={{ marginTop: 12 }} data-testid="bulk-revoke-not-prepared">
            <Notice
              tone="warning"
              title={`${notPrepared.length} could not be built and will not be signed`}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {notPrepared.map((f) => (
                  <div key={`${f.record.contractId}|${f.record.spender}`} style={{ fontSize: 12 }}>
                    <span style={{ fontFamily: '"Geist Mono", monospace' }}>
                      {shortAddress(f.record.spender)}
                    </span>
                    : {f.error}
                  </div>
                ))}
              </div>
            </Notice>
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          {n > 0 && prepError === null ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => void run(prepared)}
              data-testid="bulk-revoke-confirm-go"
            >
              Revoke {n}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPhase("idle")}
            data-testid="bulk-revoke-cancel"
          >
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  // idle
  return (
    <Card padding={16} style={{ marginBottom: 16 }} data-testid="bulk-revoke-bar">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--fg-2)" }}>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            {activeRevocable.length} active approvals
          </strong>{" "}
          on this account. Revoke them in one sweep instead of row by row.{" "}
          {hasUnknownSubset
            ? "Revoking all also cancels approvals for apps you may still use (you'd re-approve them next time), so if you're just cleaning up, start with the ones we don't recognize."
            : "Revoking cancels approvals for apps you may still use; you'd re-approve them next time."}
        </span>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {hasUnknownSubset ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => void ask(unknownActive)}
              data-testid="bulk-revoke-unknown"
            >
              Revoke {unknownActive.length} unrecognized
            </Button>
          ) : null}
          <Button
            variant={hasUnknownSubset ? "secondary" : "danger"}
            size="sm"
            onClick={() => void ask(activeRevocable)}
            data-testid="bulk-revoke-all"
          >
            Revoke all {activeRevocable.length}
          </Button>
        </div>
      </div>
    </Card>
  );
}
