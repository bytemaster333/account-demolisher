"use client";

import type { PreparePlan } from "@/lib/plan/tree";

import { ReceiptFooter } from "./ReceiptFooter";
import { RunNotes } from "./RunNotes";
import { CheckIcon, DiscoveryDiagnostics } from "./StatusFrame";
import type { StatusRun, StatusView } from "./types";

// every step ran but nothing merged: the account stays open until the queued
// backstop withdrawal unlocks
export function preparedView(run: StatusRun): StatusView {
  return {
    accent: "var(--warning)",
    icon: <CheckIcon />,
    iconAnimation: "pop .35s ease-out",
    title: "Preparation done, account still open",
    subtitle: <PreparedNote prepared={run.prepared} />,
    headerExtras: (
      <RunNotes
        executionNotes={run.executionNotes}
        allowanceHistoryThroughLedger={run.allowanceHistoryThroughLedger ?? null}
      />
    ),
    footer: (
      <ReceiptFooter
        kind="prepared"
        closedAccount={run.closedAccount}
        destination={run.destination}
        delivered={run.delivered}
        network={run.network}
        mergeHash={run.mergeHash}
        planGroups={run.planGroups}
        prepared={run.prepared}
        onPreparedDone={run.onPreparedDone}
      />
    ),
    trailing: <DiscoveryDiagnostics items={run.discoveryDiagnostics} />,
  };
}

function PreparedNote({ prepared }: { readonly prepared: PreparePlan | null }): React.JSX.Element {
  const unlockDate = prepared?.unlocksAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    <span data-testid="prepared-note">
      The preparation steps landed and the account is still open. Nothing was sent to the
      destination yet.{" "}
      {prepared !== null
        ? `${prepared.reason} Come back on or after ${unlockDate} to finish the close.`
        : "Come back once the queued withdrawal unlocks to finish the close."}
    </span>
  );
}
