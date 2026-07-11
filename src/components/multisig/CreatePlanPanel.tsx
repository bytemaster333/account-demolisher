"use client";

// The /demolish -> /plan bridge (initiator side). For a shared (multisig)
// account, instead of gathering every signer's key here to sign live, the
// initiator can bundle the whole close into one transaction and upload it to
// Refractor, producing a /plan/<hash> link to share so each co-signer signs
// once, on their own, over time.

import { useCallback, useState } from "react";

import { Button, Card, Notice } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import {
  assessBundleability,
  createClosurePlan,
  type ClosurePlanDisposal,
} from "@/lib/multisig/closure-plan";
import { getHorizon } from "@/lib/stellar/horizon-client";
import type { AccountAudit } from "@/lib/types/account";
import { pathKey } from "@/lib/types/plan";
import type { Connector } from "@/lib/wallet/connector";

export interface CreatePlanPanelProps {
  readonly audit: AccountAudit;
  readonly destination: string;
  readonly destinationReady: boolean;
  readonly network: NetworkConfig;
  // read only inside the click handler, never during render
  readonly connectorRef: React.RefObject<Connector | null>;
  readonly hasConnector: boolean;
  readonly disposal: {
    readonly returnToIssuer: readonly string[];
    readonly sendToDestination: readonly string[];
  };
  readonly hasSorobanPositions: boolean;
  readonly hasSelectedAllowances: boolean;
  readonly useMediator: boolean;
}

type Phase = "idle" | "creating" | "created" | "error";

export function CreatePlanPanel({
  audit,
  destination,
  destinationReady,
  network,
  connectorRef,
  hasConnector,
  disposal,
  hasSorobanPositions,
  hasSelectedAllowances,
  useMediator,
}: CreatePlanPanelProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [planUrl, setPlanUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const bundleability = assessBundleability({
    hasSorobanPositions,
    hasSelectedAllowances,
    useMediator,
  });

  // non-XLM balances block the merge until they're cleared. In a shared plan the
  // disposal has to be decided up-front and can't rely on a market (a sell could
  // fail and sink the signed bundle), so default every token to the always-safe
  // deterministic option: return it to its issuer. A token the user explicitly
  // routed to the destination (form state) is honored instead.
  const creditBalances = audit.balances.filter((b) => b.asset.kind === "credit");
  const tokenCount = creditBalances.length;

  const onCreate = useCallback(async () => {
    const connector = connectorRef.current;
    if (connector === null) {
      setError("Connect your signer first.");
      setPhase("error");
      return;
    }
    setPhase("creating");
    setError(null);
    try {
      const sourceAccount = await getHorizon(network).loadAccount(audit.accountId);
      const sendSet = new Set(disposal.sendToDestination);
      const returnToIssuerAssetKeys = creditBalances
        .map((b) => pathKey(b.asset))
        .filter((k) => !sendSet.has(k));
      const chosen: ClosurePlanDisposal = {
        ...(returnToIssuerAssetKeys.length > 0 ? { returnToIssuerAssetKeys } : {}),
        ...(disposal.sendToDestination.length > 0
          ? { sendToDestinationAssetKeys: disposal.sendToDestination }
          : {}),
      };
      const { planPath } = await createClosurePlan({
        audit,
        destination,
        network,
        sourceAccount,
        connector,
        disposal: chosen,
      });
      setPlanUrl(`${window.location.origin}${planPath}`);
      setPhase("created");
    } catch (e: unknown) {
      setError(errorMessage(e, "Couldn't create the signing plan."));
      setPhase("error");
    }
  }, [audit, creditBalances, destination, network, connectorRef, disposal]);

  const onCopy = useCallback(() => {
    if (planUrl === null) return;
    void navigator.clipboard?.writeText(planUrl);
    setCopied(true);
  }, [planUrl]);

  return (
    <Card padding={20} data-testid="create-plan-panel">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            flexShrink: 0,
            background: "var(--surface-2)",
            border: "1px solid var(--accent-line)",
            color: "var(--accent)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <path d="M16 6l-4-4-4 4M12 2v13" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 15.5, fontWeight: 600, letterSpacing: "-0.01em" }}>
            Sign separately, over time
          </h3>
          <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--fg-2)" }}>
            Rather than pasting every signer&apos;s key here, package this close into one
            transaction and share a link. Each co-signer opens it, reviews it, and signs once, on
            their own. Once enough have signed, it submits and the account closes.
          </p>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {!bundleability.ok ? (
          <Notice tone="warning" role="status">
            {bundleability.reason} For this account, add the required signers above and sign here
            instead.
          </Notice>
        ) : phase === "created" && planUrl !== null ? (
          <Notice tone="success" title="Signing plan created" role="status">
            Share this link with the other signers. It shows a live signing status; once enough have
            signed, the account closes automatically.
            <div
              style={{
                marginTop: 12,
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <code
                data-testid="create-plan-url"
                style={{
                  flex: 1,
                  minWidth: 200,
                  padding: "9px 11px",
                  borderRadius: 9,
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  font: "500 12px/1.4 'Geist Mono', monospace",
                  color: "var(--fg-2)",
                  wordBreak: "break-all",
                }}
              >
                {planUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={onCopy}>
                {copied ? "Copied" : "Copy link"}
              </Button>
              <a
                href={planUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  font: "600 13px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  textDecoration: "none",
                }}
              >
                Open ↗
              </a>
            </div>
          </Notice>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {tokenCount > 0 ? (
              <Notice tone="neutral" role="status">
                This account holds {tokenCount} non-XLM token{tokenCount === 1 ? "" : "s"}. In a
                shared plan {tokenCount === 1 ? "it is" : "they are"} returned to{" "}
                {tokenCount === 1 ? "its" : "their"} issuer so the account can close (a market sell
                could fail and sink the signed plan). The account&apos;s XLM goes to your
                destination.
              </Notice>
            ) : null}
            <div>
              <Button
                onClick={() => void onCreate()}
                loading={phase === "creating"}
                disabled={!hasConnector || !destinationReady || phase === "creating"}
                disabledReason={
                  !hasConnector
                    ? "Connect your signer first"
                    : !destinationReady
                      ? "Choose a valid destination above first"
                      : undefined
                }
                data-testid="create-plan-button"
              >
                {phase === "creating" ? "Creating plan…" : "Create signing plan"}
              </Button>
            </div>
            {error !== null ? (
              <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
                {error}
              </p>
            ) : null}
            <p style={{ margin: 0, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
              You sign your part now; the transaction is uploaded to Refractor (a third-party
              signing service). Market sells aren&apos;t included in a shared plan, so it can&apos;t
              fail once signed.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
