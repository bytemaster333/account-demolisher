"use client";

// The /demolish -> /plan bridge (initiator side), the PRIMARY way to close a
// shared account: bundle the whole close into one transaction, sign your part,
// and get a link to share so each co-signer signs once, on their own device,
// with their own key. Nobody has to hand their secret key to one browser (which
// is what the "paste every key" advanced path does, and why this is preferred).
//
// On success it hands the plan hash back to the page, which advances the close
// flow to an inline "collect signatures" step, no navigation away.

import { useCallback, useState } from "react";

import { Badge, Button, Card, Notice } from "@/components/ui";
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
  // called with the created plan hash; the page advances to the collect step
  readonly onPlanCreated: (hash: string) => void;
}

type Phase = "idle" | "creating" | "error";

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
  onPlanCreated,
}: CreatePlanPanelProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const bundleability = assessBundleability({
    hasSorobanPositions,
    hasSelectedAllowances,
    useMediator,
  });

  // non-XLM balances block the merge until cleared. A shared plan can't rely on a
  // market (a sell could fail and sink the signed bundle), so default every token
  // to the always-safe deterministic option: return it to its issuer. A token the
  // user explicitly routed to the destination is honored instead.
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
      const { hash } = await createClosurePlan({
        audit,
        destination,
        network,
        sourceAccount,
        connector,
        disposal: chosen,
      });
      onPlanCreated(hash);
    } catch (e: unknown) {
      setError(errorMessage(e, "Couldn't create the signing plan."));
      setPhase("error");
    }
  }, [audit, creditBalances, destination, network, connectorRef, disposal, onPlanCreated]);

  return (
    <Card padding={22} data-testid="create-plan-panel">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <span
          aria-hidden
          style={{
            width: 36,
            height: 36,
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
            width="18"
            height="18"
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
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Create a shareable signing plan
            </h3>
            <Badge tone="accent">Recommended</Badge>
          </div>
          <p style={{ margin: "7px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--fg-2)" }}>
            Each co-signer signs on their own device, with their own key, nobody shares a secret.
            You sign your part now and get a link to send them; the account closes automatically
            once enough have signed. You&apos;ll watch the progress right here.
          </p>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {!bundleability.ok ? (
          <Notice tone="warning" role="status">
            {bundleability.reason} For this account, use the advanced &ldquo;sign here now&rdquo;
            option below instead.
          </Notice>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {tokenCount > 0 ? (
              <Notice tone="neutral" role="status">
                This account holds {tokenCount} non-XLM token{tokenCount === 1 ? "" : "s"}.{" "}
                {tokenCount === 1 ? "It is" : "They are"} returned to{" "}
                {tokenCount === 1 ? "its" : "their"} issuer so the account can close, a market sell
                could fail and sink the signed plan. The account&apos;s XLM goes to your
                destination.
              </Notice>
            ) : null}
            <div>
              <Button
                size="lg"
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
              Your part is signed in your browser; the transaction is uploaded to Refractor (a
              third-party signing service). It never holds your secret key.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
