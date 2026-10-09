"use client";

import { AddressActions } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerContractUrl, explorerTxUrl } from "@/lib/explorer";
import type { LeftBehindToken } from "@/lib/orchestrator/executor";
import { shortAddress } from "@/lib/safe-display";

import { ReceiptFooter } from "./ReceiptFooter";
import { RunNotes } from "./RunNotes";
import { CheckIcon, DiscoveryDiagnostics } from "./StatusFrame";
import type { DeliveredAmount, StatusRun, StatusView } from "./types";

// the merge landed. a held token the user asked to send that did not go with it
// stays on the closed account for good, so that close is not shown as a clean one
export function succeededView(run: StatusRun): StatusView {
  const leftBehind = run.leftBehind.length > 0;
  return {
    accent: leftBehind ? "var(--warning)" : "var(--success)",
    icon: <CheckIcon />,
    iconAnimation: "pop .35s ease-out",
    title: leftBehind ? "Account closed, tokens left behind" : "Account closed",
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
        {leftBehind ? <LeftBehindTokens tokens={run.leftBehind} network={run.network} /> : null}
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
        leftBehind={run.leftBehind}
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

// the held tokens the close could not send, each by its full contract id. the
// account is gone, so nothing can move them any more.
function LeftBehindTokens({
  tokens,
  network,
}: {
  readonly tokens: readonly LeftBehindToken[];
  readonly network: NetworkConfig;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid="left-behind-tokens"
      style={{
        marginTop: 14,
        padding: "10px 12px",
        borderRadius: 9,
        background: "var(--warning-soft)",
        border: "1px solid var(--warning)",
        fontSize: 12.5,
        lineHeight: 1.55,
        color: "var(--fg-2)",
      }}
    >
      <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
        {tokens.length === 1
          ? "One held token you asked to send stays on the closed account:"
          : `${tokens.length} held tokens you asked to send stay on the closed account:`}
      </strong>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {tokens.map((t) => (
          <li key={t.contractId}>
            <span style={{ fontFamily: "'Geist Mono', monospace", wordBreak: "break-all" }}>
              {t.contractId}
            </span>{" "}
            <AddressActions
              value={t.contractId}
              href={explorerContractUrl(network, t.contractId)}
              label="token contract"
            />{" "}
            {t.amount.toString()} base units.{" "}
            {t.unconfirmedTxHash !== undefined
              ? `Its transfer ${shortAddress(t.unconfirmedTxHash, 8, 6)} was submitted, but the ` +
                "network has not confirmed whether it landed."
              : `It was not sent: ${t.reason}`}
          </li>
        ))}
      </ul>
    </div>
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
