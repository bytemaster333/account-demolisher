"use client";

// bulk revoke controller. sits above the AllowanceList and revokes many
// standing approvals in one sweep — all active, or only those to unknown
// spenders. runs strictly sequentially: each approve(amount=0) is submitted and
// confirmed on-chain before the next, because the next tx reloads the source
// account's sequence number and would be rejected as tx_bad_seq if the previous
// hadn't landed yet. one wallet signature per approval.

import { useEffect, useMemo, useRef, useState } from "react";

import { Button, Card, Notice, Progress, Spinner } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import type { AllowanceRecord } from "@/lib/soroban/allowances";
import { confirmRevoke, submitRevoke } from "@/lib/soroban/revoke";
import { lookupSpender } from "@/lib/soroban/spender-registry";
import type { Connector } from "@/lib/wallet/connector";
import { useNetworkStore } from "@/stores/network";

export interface BulkRevokeBarProps {
  readonly records: readonly AllowanceRecord[];
  readonly userAddress: string;
  readonly network: NetworkConfig;
  // null = wallet can't sign here; the bar renders nothing. ref read only in handlers
  readonly connectorRef: React.RefObject<Connector | null> | null;
  // re-enumerate after the sweep so revoked (now-expired) rows drop out
  readonly onComplete: () => void;
}

type Outcome =
  | { readonly record: AllowanceRecord; readonly ok: true; readonly hash: string }
  | { readonly record: AllowanceRecord; readonly ok: false; readonly error: string };

type Phase = "idle" | "confirm" | "running" | "done";

export function BulkRevokeBar({
  records,
  userAddress,
  network,
  connectorRef,
  onComplete,
}: BulkRevokeBarProps): React.JSX.Element | null {
  const activeRevocable = useMemo(() => records.filter((r) => !r.expired), [records]);
  const unknownActive = useMemo(
    () => activeRevocable.filter((r) => lookupSpender(r.spender) === null),
    [activeRevocable],
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingTargets, setPendingTargets] = useState<readonly AllowanceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [current, setCurrent] = useState<AllowanceRecord | null>(null);
  const [outcomes, setOutcomes] = useState<readonly Outcome[]>([]);
  const [stopping, setStopping] = useState(false);
  // read synchronously inside the loop; the state above only drives the label
  const stopRef = useRef(false);

  // on unmount (e.g. client-side navigation away from /allowances) halt the loop
  // so it can't keep submitting real approve(0) txs with the Stop control gone.
  // stops at the next iteration check; a signature already in flight still lands.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
      stopRef.current = true;
    },
    [],
  );

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

  // warn before a tab close / reload while a sweep is live — a partial run leaves
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

  const ask = (list: readonly AllowanceRecord[]): void => {
    setPendingTargets(list);
    setPhase("confirm");
  };

  const run = async (list: readonly AllowanceRecord[]): Promise<void> => {
    stopRef.current = false;
    setStopping(false);
    setPhase("running");
    setTotal(list.length);
    setDoneCount(0);
    setOutcomes([]);
    setCurrent(null);

    const acc: Outcome[] = [];
    for (const record of list) {
      if (stopRef.current) break;
      setCurrent(record);
      try {
        const connector = connectorRef?.current ?? null;
        if (connector === null) throw new Error("Wallet is no longer connected.");
        const hash = await submitRevoke(network, connector, record, userAddress);
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

  // bulk only earns its place for 2+ active approvals; one row's own button is enough
  if (connectorRef === null || activeRevocable.length < 2) return null;

  const hasUnknownSubset =
    unknownActive.length > 0 && unknownActive.length < activeRevocable.length;

  if (phase === "running") {
    const succeeded = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - succeeded;
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-running">
        <Progress
          value={doneCount}
          max={total}
          label="Revoking approvals"
          valueLabel={`${doneCount} / ${total}`}
          data-testid="bulk-revoke-progress"
        />
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
              ? `Revoking ${doneCount + 1} of ${total} — approve your wallet prompt for ${short(current.spender)}`
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
    const failures = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-done">
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          Revoked {succeeded.length} of {outcomes.length}
          {failures.length > 0 ? ` · ${failures.length} failed` : ""}
        </div>
        {failures.length > 0 ? (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            {failures.map((f) => (
              <div
                key={`${f.record.contractId}|${f.record.spender}`}
                style={{
                  fontSize: 11.5,
                  color: "var(--fg-3)",
                  fontFamily: '"Geist Mono", monospace',
                }}
              >
                <span style={{ color: "var(--danger)" }}>✕</span> {short(f.record.spender)} —{" "}
                <span style={{ fontFamily: "Geist, sans-serif" }}>{f.error}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
          {failures.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void run(failures.map((f) => f.record))}
              data-testid="bulk-revoke-retry"
            >
              Retry {failures.length} failed
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

  if (phase === "confirm") {
    return (
      <Card padding={18} style={{ marginBottom: 16 }} data-testid="bulk-revoke-confirm">
        <Notice tone="warning" title={`Revoke ${pendingTargets.length} approvals?`}>
          Your wallet will prompt you to sign each one — {pendingTargets.length} signature
          {pendingTargets.length === 1 ? "" : "s"} in total. Each revoke is submitted and confirmed
          on-chain before the next, so this can take a couple of minutes. You can stop after any
          approval.
        </Notice>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void run(pendingTargets)}
            data-testid="bulk-revoke-confirm-go"
          >
            Revoke {pendingTargets.length}
          </Button>
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
          on this account. Revoke them in one sweep instead of row by row.
        </span>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {hasUnknownSubset ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => ask(unknownActive)}
              data-testid="bulk-revoke-unknown"
            >
              Revoke {unknownActive.length} unknown
            </Button>
          ) : null}
          <Button
            variant="danger"
            size="sm"
            onClick={() => ask(activeRevocable)}
            data-testid="bulk-revoke-all"
          >
            Revoke all {activeRevocable.length}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
