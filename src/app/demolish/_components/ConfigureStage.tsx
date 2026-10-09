"use client";

import type { BundleabilityResult } from "@/lib/multisig/signing-request";
import type { CexInfo } from "@/lib/safety/cex-registry";

import type { CloseChoices } from "../_hooks/use-close-choices";
import type { Gate } from "../_hooks/use-destination-checks";
import type { MultisigInfo } from "../_hooks/use-multisig-preflight";
import type { SigningRequest } from "../_hooks/use-signing-request";
import { parseMemo } from "../_lib/form";
import type { StoredSigningRequest } from "../_lib/signing-request-store";
import { ConfigurePanel, type PreflightView } from "./ConfigurePanel";
import { MultisigContextBar } from "./MultisigContextBar";
import { ResumeRequestCard } from "./ResumeRequestCard";

// the Configure step: a stored signing request to resume, if any, then the
// destination form for both account kinds
export function ConfigureStage({
  signing,
  onResumeRequest,
  multisigRequired,
  effectiveMultisig,
  primaryWeight,
  choices,
  cex,
  useMediator,
  formError,
  onStart,
  isDemo,
  preflight,
  connected,
  destinationGate,
  destExistsGate,
  memoGate,
  configureGate,
}: {
  readonly signing: SigningRequest;
  readonly onResumeRequest: (record: StoredSigningRequest) => void;
  readonly multisigRequired: boolean;
  readonly effectiveMultisig: MultisigInfo | null;
  // the initiator's own signing weight on the shared account
  readonly primaryWeight: number;
  readonly choices: CloseChoices;
  readonly cex: CexInfo | null;
  readonly useMediator: boolean;
  readonly formError: string | null;
  readonly onStart: () => void;
  readonly isDemo: boolean;
  readonly preflight: PreflightView;
  // an account is connected and a connector can sign for it here
  readonly connected: boolean;
  readonly destinationGate: Gate;
  readonly destExistsGate: Gate;
  readonly memoGate: Gate;
  readonly configureGate: BundleabilityResult;
}): React.JSX.Element {
  const stored = signing.stored;
  return (
    <>
      {stored !== null ? (
        <ResumeRequestCard
          record={stored}
          busy={signing.resumeBusy}
          error={signing.resumeError}
          onResume={() => onResumeRequest(stored)}
          onDiscard={signing.discardStored}
        />
      ) : null}

      {/* one panel for both account kinds, so it isn't remounted (and the
          focused input lost) when the shared-account check lands */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {multisigRequired ? (
          /* shared account: configure the close here (no signer keys asked at
             this step). After Review it's published as a signing request and
             the other signatures are collected in the dedicated Signatures
             step. */
          <>
            <MultisigContextBar
              threshold={effectiveMultisig?.threshold ?? 0}
              have={primaryWeight}
              signers={effectiveMultisig?.signers ?? []}
            />
            <p
              style={{
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.5,
                color: "var(--fg-3)",
              }}
            >
              You&apos;ll gather the other signatures after you review the close, no signer keys
              needed here.
            </p>
          </>
        ) : null}
        <ConfigurePanel
          form={choices.form}
          setForm={choices.setForm}
          cex={cex}
          viaMediator={useMediator}
          hasMemo={parseMemo(choices.form) !== undefined}
          formError={formError}
          onGeneratePlan={onStart}
          isDemo={isDemo}
          preflight={preflight}
          destinationInvalid={destinationGate.hint !== null}
          deterministic={multisigRequired}
          canStart={
            connected &&
            destinationGate.ready &&
            destExistsGate.ready &&
            memoGate.ready &&
            (!multisigRequired || configureGate.ok)
          }
          startHint={
            !connected
              ? "Connect a wallet to continue."
              : multisigRequired && !configureGate.ok
                ? (configureGate.reason ??
                  "This shared account's close can't be gathered into one signing request.")
                : (destinationGate.hint ?? destExistsGate.hint ?? memoGate.hint)
          }
        />
      </div>
    </>
  );
}
