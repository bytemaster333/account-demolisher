"use client";

import { AddressActions } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import { shortAddress } from "@/lib/safe-display";

import { ReceiptFooter } from "./ReceiptFooter";
import { RunNotes } from "./RunNotes";
import { CheckIcon, DiscoveryDiagnostics } from "./StatusFrame";
import type { DeliveredAmount, StatusRun, StatusView } from "./types";

export function succeededView(run: StatusRun): StatusView {
  return {
    accent: "var(--success)",
    icon: <CheckIcon />,
    iconAnimation: "pop .35s ease-out",
    title: "Account closed",
    subtitle: (
      <SucceededSubtitle
        delivered={run.delivered}
        destination={run.destination}
        network={run.network}
      />
    ),
    headerExtras: (
      <>
        {run.mergeHash ? <ProofLink network={run.network} mergeHash={run.mergeHash} /> : null}
        <RunNotes executionNotes={run.executionNotes} />
      </>
    ),
    footer: (
      <ReceiptFooter
        kind="succeeded"
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

function SucceededSubtitle({
  delivered,
  destination,
  network,
}: {
  readonly delivered: DeliveredAmount;
  readonly destination: string;
  readonly network: NetworkConfig;
}): React.JSX.Element {
  return (
    <>
      {delivered.status === "ok" ? (
        <>
          <strong style={{ color: "var(--fg)", fontFamily: "'Geist Mono', monospace" }}>
            {delivered.xlm} XLM
          </strong>{" "}
          was delivered to{" "}
        </>
      ) : (
        // no figure until the chain confirms one: the pre-close balance ignores
        // fees and every conversion
        <>Your remaining balance was sent to </>
      )}
      <span
        title={destination}
        style={{ fontFamily: "'Geist Mono', monospace", color: "var(--fg-2)" }}
      >
        {destination.length > 10 ? shortAddress(destination) : destination}
      </span>{" "}
      <AddressActions
        value={destination}
        href={explorerAccountUrl(network, destination)}
        label="destination"
      />
      <span style={{ display: "block", marginTop: 7 }}>
        This account is now permanently closed. If that&apos;s an exchange or another wallet, the
        funds will appear there shortly.
      </span>
    </>
  );
}

// the merge transaction on a block explorer, as proof of the close
function ProofLink({
  network,
  mergeHash,
}: {
  readonly network: NetworkConfig;
  readonly mergeHash: string;
}): React.JSX.Element {
  return (
    <a
      href={explorerTxUrl(network, mergeHash)}
      target="_blank"
      rel="noreferrer noopener"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        marginTop: 14,
        padding: "8px 11px",
        borderRadius: 9,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        color: "var(--fg)",
        textDecoration: "none",
        font: "500 12px/1 'Geist Mono', monospace",
      }}
      title="Open the public record of this transaction on a block explorer"
    >
      <span style={{ fontSize: 10, color: "var(--fg-3)" }}>PROOF</span>
      <span>{shortAddress(mergeHash, 8, 6)}</span>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </a>
  );
}
