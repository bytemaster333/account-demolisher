"use client";

import { Button, Card, Notice } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";

import { SR_ONLY } from "../_lib/a11y";
import type { FlowStep } from "../_lib/flow-steps";
import { StepIndicator } from "./StepIndicator";

// the page heading and the step indicator above every flow panel
export function FlowHeading({ steps }: { readonly steps: readonly FlowStep[] }): React.JSX.Element {
  const active = steps.find((s) => s.isActive);
  return (
    <>
      {/* persistent page heading for assistive tech, the flow panels below
          are h2s; this keeps a single h1 per screen */}
      <h1 style={SR_ONLY}>Close a Stellar account</h1>
      <StepIndicator steps={steps} />
      {/* announces the current step to screen readers when the panel changes */}
      <div aria-live="polite" style={SR_ONLY}>
        {active ? `Now on step: ${active.label}` : ""}
      </div>
    </>
  );
}

// a wallet session that didn't close cleanly
export function TeardownNotice({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div style={{ marginBottom: 14 }}>
      <Notice tone="warning" title="The wallet wasn't fully disconnected" role="status">
        {message}
        <div style={{ marginTop: 10 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            data-testid="teardown-error-dismiss"
          >
            Dismiss
          </Button>
        </div>
      </Notice>
    </div>
  );
}

// a failure before any plan tree exists (audit / discovery error, e.g. the
// connected account has no record on the selected network)
export function PreflightFailedCard({
  error,
  network,
  retryDisabled,
  onRetry,
  onReset,
}: {
  readonly error: string | null;
  // the network the run is on
  readonly network: NetworkConfig;
  readonly retryDisabled: boolean;
  readonly onRetry: () => void;
  readonly onReset: () => void;
}): React.JSX.Element {
  return (
    <div style={{ maxWidth: 1080, margin: "0 auto" }}>
      <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Notice tone="danger" title="Couldn't prepare this close">
          {error ?? "Something went wrong before the plan could be built."}
          {error?.includes("not found on this network") ? (
            <span style={{ display: "block", marginTop: 8, color: "var(--fg-2)" }}>
              This account has no record on the {network.id} network. Check the network selector
              (top right) and make sure the account is funded there, then try again.
            </span>
          ) : null}
        </Notice>
        <div style={{ display: "flex", gap: 10 }}>
          <Button
            variant="secondary"
            onClick={onRetry}
            disabled={retryDisabled}
            data-testid="preflight-retry"
          >
            Try again
          </Button>
          <Button variant="ghost" onClick={onReset} data-testid="preflight-reset">
            Start over
          </Button>
        </div>
      </Card>
    </div>
  );
}

// a refusal from a rebuild (Resolve, the token card, Warnings) or a refused
// confirmation; Configure shows its own
export function FlowError({ message }: { readonly message: string }): React.JSX.Element {
  return (
    <p
      role="alert"
      data-testid="flow-error"
      style={{
        margin: "0 0 14px",
        padding: "11px 13px",
        borderRadius: 11,
        border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
        fontSize: 13,
        color: "var(--danger)",
      }}
    >
      {message}
    </p>
  );
}

// a stored signing request whose rebuilt plan no longer matches it
export function ResumeMismatchNotice({
  reason,
  onDiscard,
}: {
  readonly reason: string;
  readonly onDiscard: () => void;
}): React.JSX.Element {
  return (
    <Notice tone="warning" title="This signing request can't be reused">
      {reason}
      <div style={{ marginTop: 10 }}>
        <Button variant="secondary" onClick={onDiscard}>
          Discard it
        </Button>
      </div>
    </Notice>
  );
}
