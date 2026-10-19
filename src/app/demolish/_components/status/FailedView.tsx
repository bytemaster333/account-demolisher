"use client";

import { useMemo, useState } from "react";

import { PendingForwardBanner } from "@/components/wallet/PendingForwardBanner";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerTxUrl } from "@/lib/explorer";
import { loadPendingForwards } from "@/lib/mediator/pending-flow";
import type { PhaseReceipt } from "@/lib/orchestrator/journal";
import type { FailureKind } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree } from "@/lib/plan/tree";
import { shortAddress } from "@/lib/safe-display";

import { parseDemolishError, type ParsedError } from "../../_lib/demolish-error";
import { failureNoteFor, type FailureNote } from "../../_lib/failure-note";
import { nodePlainLabel } from "../../_lib/plan-copy";
import { RunNotes } from "./RunNotes";
import { DETAILS_STYLE, DiscoveryDiagnostics, FOOTER_STYLE } from "./StatusFrame";
import type { StatusRun, StatusView } from "./types";

export function failedView(run: StatusRun): StatusView {
  const parsed = parseDemolishError(run.error);
  return {
    accent: "var(--danger)",
    icon: <AlertIcon />,
    iconAnimation: "none",
    title: "Couldn't finish closing the account",
    subtitle: parsed.summary,
    headerExtras: (
      <>
        <FailureDetails
          tree={run.tree}
          landedPhases={run.landedPhases}
          network={run.network}
          destination={run.destination}
          closedAccount={run.closedAccount}
          retryResumes={run.retryResumes}
          failureKind={run.failureKind}
        />
        <RunNotes
          executionNotes={run.executionNotes}
          allowanceHistoryThroughLedger={run.allowanceHistoryThroughLedger ?? null}
        />
        <ResultCodes parsed={parsed} />
      </>
    ),
    footer: (
      <FailedActions
        onRetry={run.onRetry}
        onReset={run.onReset}
        retryDisabledReason={run.retryDisabledReason}
      />
    ),
    trailing: (
      <>
        <DiscoveryDiagnostics items={run.discoveryDiagnostics} />
        {run.error ? <RawError error={run.error} /> : null}
      </>
    ),
  };
}

// the note and the landed-transaction list come from the same facts, so they
// can't contradict each other
function FailureDetails({
  tree,
  landedPhases,
  network,
  destination,
  closedAccount,
  retryResumes,
  failureKind,
}: {
  readonly tree: PlanTree;
  readonly landedPhases: readonly PhaseReceipt[];
  readonly network: NetworkConfig;
  readonly destination: string;
  readonly closedAccount: string;
  readonly retryResumes: boolean;
  readonly failureKind: FailureKind | null;
}): React.JSX.Element {
  const note = useMemo(() => failureNoteFor(tree, landedPhases), [tree, landedPhases]);
  const kindCopy = failureKind !== null ? FAILURE_KIND_COPY[failureKind] : undefined;
  return (
    <>
      <FailureNoteView
        note={note}
        network={network}
        destination={destination}
        closedAccount={closedAccount}
        retryResumes={retryResumes}
      />
      {kindCopy ? (
        <p
          data-testid="failure-kind-note"
          style={{ margin: "10px 0 0", fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-2)" }}
        >
          {kindCopy}
        </p>
      ) : null}
    </>
  );
}

// the failure note, branched on what the tree's receipts prove happened. It
// never claims the balance is untouched once any step has a receipt, and after
// the merge into the helper account it points at the one recovery action.
function FailureNoteView({
  note,
  network,
  destination,
  closedAccount,
  retryResumes,
}: {
  readonly note: FailureNote;
  readonly network: NetworkConfig;
  readonly destination: string;
  readonly closedAccount: string;
  readonly retryResumes: boolean;
}): React.JSX.Element {
  const retryCopy = retryResumes
    ? "Press Retry to run the remaining steps again; steps marked done are not repeated."
    : "Retry re-checks the account and builds a fresh plan before anything else runs.";
  const warn = note.kind === "in-mediator" || note.kind === "partial" || note.kind === "closed";
  // the resume action needs this flow's own record, saved before the merge. read
  // once: a delivered forward removes the record, and the banner must stay put
  // to show the delivery. storage that can't be read is said, not taken as "no
  // record"
  const [record] = useState<{ readonly found: boolean; readonly error: string | null }>(() => {
    if (note.kind !== "in-mediator") return { found: false, error: null };
    try {
      return {
        found: loadPendingForwards(closedAccount).some(
          (r) => r.mediatorPublicKey === note.mediatorPublicKey && r.networkId === network.id,
        ),
        error: null,
      };
    } catch (err) {
      return { found: false, error: errorMessage(err) };
    }
  });
  const hadRecord = record.found;
  const [forwardDelivered, setForwardDelivered] = useState(false);
  return (
    <div
      role="note"
      data-testid="demolish-failure-note"
      data-kind={note.kind}
      style={{
        marginTop: 14,
        padding: "12px 14px",
        borderRadius: 12,
        border: `1px solid color-mix(in srgb, var(${warn ? "--warning" : "--border-2"}) 45%, transparent)`,
        fontSize: 12.5,
        lineHeight: 1.55,
        color: "var(--fg-2)",
      }}
    >
      {note.kind === "in-mediator" ? (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            {forwardDelivered
              ? "Your account was closed and the forward was delivered."
              : "Your account was closed and the funds are in a temporary forwarding account."}
          </strong>{" "}
          The merge (
          <a
            href={explorerTxUrl(network, note.mergeHash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--fg)" }}
          >
            {shortAddress(note.mergeHash, 8, 6)}
          </a>
          ) moved the whole balance into the helper account {shortAddress(note.mediatorPublicKey)}
          {forwardDelivered
            ? `, and the forward has now delivered it to ${shortAddress(destination)}.`
            : `, but the delivery to ${shortAddress(destination)} didn't finish.`}{" "}
          {hadRecord ? (
            <>
              {forwardDelivered
                ? null
                : "Use Resume the forward below: it sends that balance on to your destination with your memo."}
              <div style={{ marginTop: 10 }}>
                <PendingForwardBanner
                  publicKey={closedAccount}
                  mediatorPublicKey={note.mediatorPublicKey}
                  current
                  onResolved={() => setForwardDelivered(true)}
                />
              </div>
            </>
          ) : (
            // the record is written before the merge; without it (storage blocked)
            // this page has nothing to resume from
            <>
              {record.error !== null
                ? `This browser's storage couldn't be read (${record.error}), so the forward can't be resumed from here.`
                : "This browser has no saved record of the forward, so it can't be resumed from here."}{" "}
              Keep the merge link above and the helper account address:{" "}
              <code style={{ wordBreak: "break-all" }}>{note.mediatorPublicKey}</code>.
              {retryResumes ? (
                <div style={{ marginTop: 8 }}>
                  Retry runs the forward again from this tab; the merge is not repeated.
                </div>
              ) : null}
            </>
          )}
          <LandedList phases={note.landed} network={network} />
        </>
      ) : note.kind === "closed" ? (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            The account merge landed, so this account is closed.
          </strong>{" "}
          See the merge on the explorer:{" "}
          <a
            href={explorerTxUrl(network, note.mergeHash)}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--fg)" }}
          >
            {shortAddress(note.mergeHash, 8, 6)}
          </a>
          .
          <LandedList phases={note.landed} network={network} />
        </>
      ) : note.kind === "partial" ? (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            Some steps already ran and changed your balances.
          </strong>{" "}
          Your account is still open.
          {note.ran.length > 0 ? (
            <>
              {" "}
              These steps finished on chain and are not undone:
              <ul style={{ margin: "6px 0 6px", paddingLeft: 18 }}>
                {note.ran.map((n) => (
                  <li key={n.id}>{nodePlainLabel(n)}</li>
                ))}
              </ul>
            </>
          ) : null}
          <LandedList phases={note.landed} network={network} />
          <div style={{ marginTop: 6 }}>{retryCopy}</div>
        </>
      ) : (
        <>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            Your account is still open.
          </strong>{" "}
          No step of this close finished on chain.
          {note.multiBatch
            ? " The close needed more than one transaction, so an earlier one may already have run; check the account on the explorer before retrying."
            : ""}{" "}
          {retryCopy}
        </>
      )}
    </div>
  );
}

// what Retry does for each failure kind, where the generic copy isn't enough
const FAILURE_KIND_COPY: Partial<Record<FailureKind, string>> = {
  forward_pending:
    "Your balance is in the temporary forwarding account. Retry runs the forward again from this tab; the merge is not repeated.",
  bundle_stale:
    "The signed bundle can no longer land, so its signatures can't be used. Retry starts a new signing request, and every signer has to sign again.",
  interrupted:
    "The close stopped between steps, because it was cancelled or the wallet or network changed. Retry runs the steps that didn't land; the ones marked done are not repeated.",
  mediator_expired:
    "The authorization for the temporary forwarding account ran too low to sign the merge safely, so the merge was not signed. Retry builds a fresh plan.",
  ambiguous:
    "An earlier submission's outcome isn't known yet. Retry checks it on the network before anything is signed again.",
  conversion_refused:
    "The price moved since you reviewed it, so the conversion was not signed. Retry rebuilds the plan so you can decide again for each token.",
  claim_unavailable:
    "A Blend backstop rewards claim that worked at review can no longer run, so nothing more was signed. Retry rebuilds the plan, and the review then asks whether to leave those rewards unclaimed.",
  close_running:
    "A close for this account is already running in this tab. Wait for it to finish, then Retry runs only what didn't land.",
};

// the run's own classic transactions that reached the chain (an unwind phase,
// an earlier close batch, or the merge), so the user knows what is already
// final when a later one failed. Nothing is said when none landed: the failure
// note covers that.
function LandedList({
  phases,
  network,
}: {
  readonly phases: readonly PhaseReceipt[];
  readonly network: NetworkConfig;
}): React.JSX.Element | null {
  if (phases.length === 0) return null;
  return (
    <div data-testid="landed-phases" data-count={phases.length} style={{ marginTop: 6 }}>
      These transactions of this close are on chain and are not undone:
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {phases.map((p) => (
          <li key={p.txHash}>
            <a
              href={explorerTxUrl(network, p.txHash)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--fg)" }}
            >
              {shortAddress(p.txHash, 8, 6)}
            </a>{" "}
            in ledger {p.ledger}
          </li>
        ))}
      </ul>
    </div>
  );
}

// the transaction result code and each operation's, as the network returned them
function ResultCodes({ parsed }: { readonly parsed: ParsedError }): React.JSX.Element | null {
  if (parsed.ops.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 5,
        marginTop: 12,
      }}
    >
      {parsed.txCode !== null ? (
        <code
          style={{
            padding: "3px 7px",
            borderRadius: 6,
            font: "600 10.5px/1 'Geist Mono', monospace",
            color: "var(--danger)",
            background: "var(--surface-2)",
            border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
          }}
        >
          {parsed.txCode}
        </code>
      ) : null}
      {parsed.ops.map((op, i) => {
        const isFail = op !== "op_success";
        return (
          <code
            key={i}
            title={`operation ${i + 1} in the transaction: ${op}`}
            style={{
              padding: "3px 7px",
              borderRadius: 6,
              font: "600 10.5px/1 'Geist Mono', monospace",
              color: isFail ? "var(--danger)" : "var(--success)",
              background: "var(--surface-2)",
              border: `1px solid color-mix(in srgb, var(${isFail ? "--danger" : "--success"}) 25%, transparent)`,
            }}
          >
            {isFail ? `${i + 1}: ${op}` : `${i + 1} ✓`}
          </code>
        );
      })}
    </div>
  );
}

function FailedActions({
  onRetry,
  onReset,
  retryDisabledReason,
}: {
  readonly onRetry: () => void;
  readonly onReset: () => void;
  readonly retryDisabledReason: string | null;
}): React.JSX.Element {
  return (
    <div style={FOOTER_STYLE}>
      <button
        type="button"
        onClick={onRetry}
        disabled={Boolean(retryDisabledReason)}
        title={retryDisabledReason ?? undefined}
        data-testid="demolish-retry"
        style={{
          flex: 1,
          height: 40,
          padding: "0 16px",
          borderRadius: 10,
          border: "1px solid var(--border-2)",
          background: "var(--surface)",
          color: "var(--fg)",
          fontWeight: 600,
          fontSize: 13.5,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
      <button
        type="button"
        onClick={onReset}
        data-testid="demolish-failed-reset"
        style={{
          flex: 1,
          height: 40,
          padding: "0 16px",
          borderRadius: 10,
          border: "1px solid var(--accent-line)",
          background: "transparent",
          color: "var(--accent)",
          fontWeight: 600,
          fontSize: 13.5,
          cursor: "pointer",
        }}
      >
        Start over
      </button>
    </div>
  );
}

// the raw error, collapsed: available but out of the way
function RawError({ error }: { readonly error: string }): React.JSX.Element {
  return (
    <details style={DETAILS_STYLE}>
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          listStyle: "revert",
        }}
      >
        raw error
      </summary>
      <pre
        style={{
          margin: "8px 0 0",
          padding: 0,
          font: "500 11px/1.5 'Geist Mono', monospace",
          color: "var(--fg-2)",
          wordBreak: "break-all",
          whiteSpace: "pre-wrap",
          maxHeight: 200,
          overflowY: "auto",
        }}
      >
        {error}
      </pre>
    </details>
  );
}

function AlertIcon(): React.JSX.Element {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 9v4M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}
