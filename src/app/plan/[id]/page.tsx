// refractor-linked plan view

import { TransactionBuilder } from "@stellar/stellar-sdk";
import Link from "next/link";

import { AppShell } from "@/components/layout/AppShell";
import {
  Badge,
  Button,
  Card,
  CopyableAddress,
  InfoTip,
  Notice,
  PageContainer,
  PageHeader,
  Progress,
  SectionLabel,
} from "@/components/ui";
import { getPublicEnv } from "@/lib/config/env";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import { RefractorError, getStatus, type RefractorTxStatus } from "@/lib/multisig/refractor";
import { getHorizon } from "@/lib/stellar/horizon-client";

import { CopyLinkButton } from "./CopyLinkButton";
import { PlanLiveRefresh } from "./PlanLiveRefresh";

interface PlanPageProps {
  readonly params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

const REFRACTOR_FRONTEND = "https://refractor.space";
const REFRACTOR_TIP =
  "Refractor is a third-party service that collects each key holder's signature and submits the transaction once enough have signed. Demolisher never stores your transaction.";

type LoadResult =
  | { kind: "ok"; status: RefractorTxStatus }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

async function load(id: string): Promise<LoadResult> {
  try {
    const status = await getStatus(id);
    return { kind: "ok", status };
  } catch (err) {
    if (err instanceof RefractorError && err.status === 404) {
      return { kind: "not-found" };
    }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// result of binding a Refractor-returned envelope to the requested link + network.
// hashOk: status.xdr actually hashes (under the app's passphrase) to the id in
// the URL; networkOk: status.network is the network this deployment is on.
// verified is the conjunction: the gate for showing the sign action.
export interface EnvelopeVerification {
  readonly hashOk: boolean;
  readonly networkOk: boolean;
  readonly verified: boolean;
}

// short network token Refractor reports ("public"/"testnet"/"futurenet"),
// derived from a passphrase. mirrors refractor.ts's networkTokenFor so the
// network compare uses Refractor's vocabulary rather than the raw passphrase
function networkTokenFor(passphrase: string): string {
  if (passphrase === "Public Global Stellar Network ; September 2015") return "public";
  if (passphrase === "Test SDF Network ; September 2015") return "testnet";
  if (passphrase === "Test SDF Future Network ; October 2022") return "futurenet";
  return passphrase;
}

// cryptographically bind the returned envelope to the URL id and the app
// network. Refractor is a third-party service; a malicious/MITM'd response
// could hand back a benign-looking XDR that isn't what the signer commits to,
// so we never trust status.xdr/status.network without checking them here
export function verifyEnvelope(
  id: string,
  status: Pick<RefractorTxStatus, "xdr" | "network">,
  passphrase: string,
): EnvelopeVerification {
  const hashOk = (() => {
    try {
      // fee-bump / malformed envelopes throw here; that's a verification failure
      return (
        Buffer.from(TransactionBuilder.fromXDR(status.xdr, passphrase).hash()).toString("hex") ===
        id
      );
    } catch {
      return false;
    }
  })();
  const networkOk = networkTokenFor(passphrase) === status.network;
  return { hashOk, networkOk, verified: hashOk && networkOk };
}

// ── envelope inspection (only ever run on a VERIFIED envelope) ───────────────
// A signer is being asked to authorize permanently closing an account and moving
// its funds. Showing only opaque base64 XDR is blind signing: an accountMerge to
// an attacker's destination looks identical to a benign closure. We decode the
// verified transaction and surface, in plain language, what it actually does.

interface OperationSummary {
  readonly type: string;
  readonly detail?: string;
  readonly destination?: string;
  readonly danger?: boolean;
}

interface EnvelopeDetails {
  readonly operations: readonly OperationSummary[];
  readonly timeBounds: { readonly minTime: number; readonly maxTime: number } | null;
}

// minimal structural view of a decoded operation, to read fields without `any`
interface RawOp {
  readonly type: string;
  readonly destination?: string;
  readonly amount?: string;
  readonly asset?: { isNative(): boolean; getCode(): string };
  readonly line?: { isNative(): boolean; getCode(): string };
  readonly signer?: { readonly ed25519PublicKey?: string; readonly weight?: number };
  readonly masterWeight?: number;
  readonly lowThreshold?: number;
  readonly medThreshold?: number;
  readonly highThreshold?: number;
}

function assetLabel(asset: { isNative(): boolean; getCode(): string }): string {
  try {
    return asset.isNative() ? "XLM" : asset.getCode();
  } catch {
    return "an asset";
  }
}

function humanizeOpType(type: string): string {
  const spaced = type.replace(/([A-Z])/g, " $1").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describeSetOptions(op: RawOp): string {
  const parts: string[] = [];
  const signerKey = op.signer?.ed25519PublicKey;
  if (typeof signerKey === "string") {
    parts.push(
      op.signer?.weight === 0
        ? `removes signer ${shortId(signerKey)}`
        : `sets signer ${shortId(signerKey)} to weight ${op.signer?.weight}`,
    );
  }
  if (op.masterWeight !== undefined) parts.push(`master key weight to ${op.masterWeight}`);
  if (
    op.lowThreshold !== undefined ||
    op.medThreshold !== undefined ||
    op.highThreshold !== undefined
  ) {
    parts.push("adjusts signing thresholds");
  }
  if (parts.length === 0) return "Adjusts this account's options.";
  const joined = parts.join("; ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function summarizeOp(op: RawOp): OperationSummary {
  switch (op.type) {
    case "accountMerge":
      return {
        type: "Close this account",
        detail:
          "Sends any remaining XLM to the destination below and permanently deletes this account.",
        danger: true,
        ...(op.destination ? { destination: op.destination } : {}),
      };
    case "payment":
      return {
        type: "Send a payment",
        detail:
          op.amount && op.asset
            ? `Sends ${op.amount} ${assetLabel(op.asset)} to the destination below.`
            : "Moves funds to the destination below.",
        danger: true,
        ...(op.destination ? { destination: op.destination } : {}),
      };
    case "setOptions":
      return { type: "Change account settings", detail: describeSetOptions(op) };
    case "changeTrust":
      return {
        type: "Change a trustline",
        ...(op.line ? { detail: `For ${assetLabel(op.line)}.` } : {}),
      };
    default:
      return { type: humanizeOpType(op.type) };
  }
}

function inspectEnvelope(xdr: string, passphrase: string): EnvelopeDetails | null {
  try {
    const decoded = TransactionBuilder.fromXDR(xdr, passphrase);
    const candidate = decoded as unknown as {
      operations?: readonly RawOp[];
      timeBounds?: { minTime?: string | number; maxTime?: string | number };
    };
    // fee-bumps have no operations; verifyEnvelope already rejects them, but guard
    if (!Array.isArray(candidate.operations)) return null;
    const operations = candidate.operations.map(summarizeOp);
    const tb = candidate.timeBounds;
    const timeBounds =
      tb && (tb.minTime !== undefined || tb.maxTime !== undefined)
        ? { minTime: Number(tb.minTime ?? 0), maxTime: Number(tb.maxTime ?? 0) }
        : null;
    return { operations, timeBounds };
  } catch {
    return null;
  }
}

// ── on-chain outcome resolution ──────────────────────────────────────────────
// Refractor reports "submitted"/"failed" unreliably (it returns status "failed"
// even for transactions that actually landed). The plan id IS the classic tx
// hash, so Horizon is the source of truth for whether the closure happened.

type Outcome =
  | { kind: "collecting" }
  | { kind: "submitted"; txHash: string | null }
  | { kind: "failed"; reason: string };

async function fetchHorizonTx(
  id: string,
  net: NetworkConfig,
): Promise<{ successful: boolean } | null> {
  try {
    const record = (await getHorizon(net).transactions().transaction(id).call()) as {
      successful?: boolean;
    };
    return { successful: record.successful === true };
  } catch {
    // 404 (not submitted / not yet indexed) or a transient Horizon error: unknown
    return null;
  }
}

// time-bound evaluation is done here (a plain server-side helper), not inside a
// component, so the wall-clock read stays out of render.
interface Timing {
  readonly expired: boolean;
  readonly notYetValid: boolean;
  readonly validFrom: number;
  readonly validUntil: number;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function evaluateTiming(details: EnvelopeDetails | null): Timing {
  const tb = details?.timeBounds ?? null;
  if (tb === null) return { expired: false, notYetValid: false, validFrom: 0, validUntil: 0 };
  const now = nowUnix();
  return {
    // maxTime 0 means "no upper bound"; only a real, past deadline is expired
    expired: tb.maxTime !== 0 && tb.maxTime < now,
    notYetValid: tb.minTime > now,
    validFrom: tb.minTime,
    validUntil: tb.maxTime,
  };
}

async function resolveOutcome(
  id: string,
  status: RefractorTxStatus,
  net: NetworkConfig,
): Promise<Outcome> {
  const refractorSubmitted = status.submitted === true;
  const refractorFailed =
    (status.status ?? "").toLowerCase() === "failed" ||
    (typeof status.error === "string" && status.error.length > 0);

  // still gathering signatures: no need to touch Horizon
  if (!refractorSubmitted && !refractorFailed) return { kind: "collecting" };

  const onChain = await fetchHorizonTx(id, net);
  if (onChain?.successful === true) return { kind: "submitted", txHash: id };
  if (onChain !== null && onChain.successful === false) {
    return { kind: "failed", reason: "The transaction was submitted but failed on the network." };
  }
  // not found on Horizon (or Horizon unreachable): trust refractor's own hint
  if (refractorSubmitted) return { kind: "submitted", txHash: null };
  return {
    kind: "failed",
    reason:
      typeof status.error === "string" && status.error.length > 0
        ? status.error
        : "Refractor reported that this transaction could not be submitted.",
  };
}

export default async function PlanPage({ params }: PlanPageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  const net = resolveNetwork(getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK);
  const result = await load(id);

  let body: React.JSX.Element;
  if (result.kind === "ok") {
    const verification = verifyEnvelope(id, result.status, net.passphrase);
    // only decode when the bytes are provably the tx bound to this link
    const details = verification.verified
      ? inspectEnvelope(result.status.xdr, net.passphrase)
      : null;
    const outcome = await resolveOutcome(id, result.status, net);
    const timing = evaluateTiming(details);
    body = (
      <PlanStatusView
        id={id}
        net={net}
        status={result.status}
        verification={verification}
        details={details}
        outcome={outcome}
        timing={timing}
      />
    );
  } else if (result.kind === "not-found") {
    body = <NotFoundState />;
  } else {
    body = <ErrorState id={id} message={result.message} />;
  }

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          kicker={`Multisig · /plan/${shortId(id)}`}
          title="Collect signatures to close this account"
          subtitle={
            <>
              This account is shared, so closing it needs a signature from every required key
              holder. Closing sends any remaining XLM to a destination account and permanently
              deletes this account. Share this link so each key holder can review the exact
              transaction and add their signature; once enough have signed,{" "}
              <InfoTip tip={REFRACTOR_TIP}>Refractor</InfoTip> submits it automatically. Opening
              this page is safe, nothing happens until the required signatures are collected.
            </>
          }
        />

        {body}

        <div style={{ marginTop: 16 }} data-testid="plan-disclaimer">
          <Notice tone="neutral">
            Signature collection is coordinated through{" "}
            <InfoTip tip={REFRACTOR_TIP}>
              <strong style={{ color: "var(--fg-2)" }}>Refractor</strong>
            </InfoTip>
            , a third-party service. Demolisher verifies the returned transaction hashes to this
            link and matches the configured network before showing the sign action, and never stores
            any transaction itself.
          </Notice>
        </div>
      </PageContainer>
    </AppShell>
  );
}

function PlanStatusView({
  id,
  net,
  status,
  verification,
  details,
  outcome,
  timing,
}: {
  readonly id: string;
  readonly net: NetworkConfig;
  readonly status: RefractorTxStatus;
  readonly verification: EnvelopeVerification;
  readonly details: EnvelopeDetails | null;
  readonly outcome: Outcome;
  readonly timing: Timing;
}): React.JSX.Element {
  const unverified = !verification.verified;

  // when verification fails this is a hard stop: show only the warning and the
  // raw envelope for inspection. Nothing that implies the plan is trustworthy
  // (progress, signer list, submitted/closed banner, sign action) is rendered.
  if (unverified) {
    return (
      <>
        <UnverifiedBanner verification={verification} />
        <Card padding={0} data-testid="plan-card" style={{ overflow: "hidden" }}>
          <LinkRow id={id} />
          <div style={{ padding: "22px 20px" }}>
            <XdrDetails xdr={status.xdr} network={status.network} />
          </div>
        </Card>
      </>
    );
  }

  const { expired, notYetValid } = timing;

  const knownSigners = status.signers.length > 0;
  const signerCount = status.signers.length;
  const collected = Math.max(0, signerCount - status.signaturesNeeded);
  const allCollected = knownSigners && status.signaturesNeeded === 0;

  // "collecting" is the only state where signing / progress / polling belong.
  // A met threshold that hasn't submitted yet, a submitted/failed outcome, or an
  // expired time bound all suppress the sign action and stop the poller.
  const collecting = outcome.kind === "collecting" && !expired;

  return (
    <>
      {outcome.kind === "submitted" ? (
        <SubmittedBanner id={id} txHash={outcome.txHash} net={net} />
      ) : outcome.kind === "failed" ? (
        <FailedBanner reason={outcome.reason} />
      ) : expired ? (
        <ExpiredBanner validUntil={timing.validUntil} />
      ) : null}

      <Card padding={0} data-testid="plan-card" style={{ overflow: "hidden" }}>
        <LinkRow id={id} />

        <div style={{ padding: "22px 20px" }}>
          {/* live refresh: polls Refractor via router.refresh(); only while we're
              still collecting signatures (not once the plan reaches a terminal
              state, or the poll would run forever) */}
          {collecting ? <PlanLiveRefresh /> : null}

          {/* what the transaction actually does (decoded from the verified XDR) */}
          {details !== null && outcome.kind !== "submitted" ? (
            <OperationsView
              details={details}
              net={net}
              notYetValid={notYetValid}
              validFrom={timing.validFrom}
            />
          ) : null}

          {collecting ? (
            <>
              {knownSigners ? (
                <div style={{ marginTop: 22 }}>
                  <Progress
                    value={collected}
                    max={signerCount}
                    tone="accent"
                    label={
                      <span>
                        Signatures collected{" "}
                        <InfoTip tip="Each signer's key can carry a different weight. This account is closed once the collected signatures meet its required threshold, which may be reached before every listed signer has signed.">
                          <span style={{ fontWeight: 500, color: "var(--fg-3)" }}>
                            (of known signers)
                          </span>
                        </InfoTip>
                      </span>
                    }
                    valueLabel={`${collected} of ${signerCount}`}
                    data-testid="plan-counts"
                  />

                  <div style={{ marginTop: 22 }}>
                    <SectionLabel>Signers</SectionLabel>
                    <SignersList
                      signers={status.signers}
                      signedBy={status.signedBy}
                      signaturesNeeded={status.signaturesNeeded}
                      net={net}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 22 }} data-testid="plan-counts">
                  <Notice tone="neutral" role="status">
                    We don&apos;t yet know which signers this account requires, Refractor is still
                    working it out
                    {status.collectedCount > 0
                      ? ` (${status.collectedCount} signature${
                          status.collectedCount === 1 ? "" : "s"
                        } collected so far)`
                      : ""}
                    . Refresh in a moment, or sign directly on Refractor below.
                  </Notice>
                </div>
              )}

              {/* primary action. Once every listed signature is in, there's
                  nothing left to sign, so we demote the big CTA to a success
                  notice instead of inviting a redundant signature (UI). */}
              {allCollected ? (
                <div style={{ marginTop: 22 }}>
                  <Notice tone="success" role="status">
                    All required signatures are in. Refractor will submit the transaction to close
                    the account automatically, no further action needed.
                  </Notice>
                </div>
              ) : (
                <SignCta id={id} />
              )}
            </>
          ) : null}

          <XdrDetails xdr={status.xdr} network={status.network} />
        </div>
      </Card>
    </>
  );
}

// shareable /plan/<hash> link row with copy button
function LinkRow({ id }: { readonly id: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "15px 20px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface-2)",
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--fg-3)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
        aria-hidden
      >
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
      </svg>
      <span
        style={{
          flex: 1,
          font: "500 12.5px/1 'Geist Mono', monospace",
          color: "var(--fg-2)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={`/plan/${id}`}
      >
        /plan/{shortId(id)}
      </span>
      <CopyLinkButton />
    </div>
  );
}

// decoded, human-readable list of what the transaction does. the merge/payment
// destination is shown prominently, since that's what a signer most needs to
// check before authorizing a fund-moving close.
function OperationsView({
  details,
  net,
  notYetValid,
  validFrom,
}: {
  readonly details: EnvelopeDetails;
  readonly net: NetworkConfig;
  readonly notYetValid: boolean;
  readonly validFrom: number;
}): React.JSX.Element {
  return (
    <div style={{ marginTop: 2 }} data-testid="plan-operations">
      <SectionLabel>What this transaction does</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}>
        {details.operations.map((op, i) => (
          <div
            key={i}
            style={{
              padding: "12px 14px",
              borderRadius: 12,
              border: op.danger
                ? "1px solid color-mix(in srgb, var(--warning) 32%, transparent)"
                : "1px solid var(--border)",
              background: "var(--surface-2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontWeight: 600,
                fontSize: 13.5,
              }}
            >
              {op.danger ? <Badge tone="warning">moves funds</Badge> : null}
              {op.type}
            </div>
            {op.detail ? (
              <div style={{ marginTop: 5, fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5 }}>
                {op.detail}
              </div>
            ) : null}
            {op.destination ? (
              <div style={{ marginTop: 9 }}>
                <div
                  style={{
                    fontSize: 10.5,
                    color: "var(--fg-3)",
                    letterSpacing: "0.05em",
                    marginBottom: 4,
                  }}
                >
                  DESTINATION
                </div>
                <CopyableAddress
                  value={op.destination}
                  label="Destination"
                  head={8}
                  tail={6}
                  size={12.5}
                  href={explorerAccountUrl(net, op.destination)}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {notYetValid ? (
        <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--fg-3)" }}>
          This transaction is not valid until {new Date(validFrom * 1000).toUTCString()}.
        </p>
      ) : null}
    </div>
  );
}

function SignCta({ id }: { readonly id: string }): React.JSX.Element {
  const refractorSignUrl = `${REFRACTOR_FRONTEND}/tx/${id}`;
  return (
    <div style={{ marginTop: 22 }} data-testid="plan-sign-cta">
      <a
        href={refractorSignUrl}
        target="_blank"
        rel="noreferrer noopener"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          height: 48,
          borderRadius: 12,
          background: "transparent",
          border: "1px solid var(--accent-line)",
          color: "var(--accent)",
          fontWeight: 600,
          fontSize: 15,
          textDecoration: "none",
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.6 7.6" />
          <circle cx="11" cy="11" r="2" />
        </svg>
        Review &amp; sign on Refractor ↗
      </a>
      <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
        Opens Refractor&apos;s signing page for this exact transaction. Connect your wallet there,
        check what the transaction does, and sign. Your signature is added to the plan above.
      </p>
    </div>
  );
}

function XdrDetails({
  xdr,
  network,
}: {
  readonly xdr: string;
  readonly network: string;
}): React.JSX.Element {
  return (
    <details style={{ marginTop: 20 }}>
      <summary
        style={{
          cursor: "pointer",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--fg-2)",
          // keep the native disclosure triangle so it's obviously expandable
          // and rotates on open (matches the demolish raw-error collapsible)
          listStyle: "revert",
        }}
      >
        Show the exact transaction (advanced,{" "}
        <InfoTip tip="XDR is Stellar's binary encoding for a transaction. This is the exact, canonical transaction every signer commits to; its hash is what this plan link is bound to.">
          XDR
        </InfoTip>
        ) · {network}
      </summary>
      <div
        data-testid="plan-xdr"
        style={{
          marginTop: 10,
          padding: "12px 13px",
          borderRadius: 11,
          background: "var(--bg-2)",
          border: "1px solid var(--border)",
          font: "500 11px/1.6 'Geist Mono', monospace",
          color: "var(--fg-3)",
          wordBreak: "break-all",
          maxHeight: 160,
          overflow: "auto",
        }}
      >
        {xdr}
      </div>
    </details>
  );
}

function SignersList({
  signers,
  signedBy,
  signaturesNeeded,
  net,
}: {
  readonly signers: readonly string[];
  readonly signedBy: readonly string[];
  readonly signaturesNeeded: number;
  readonly net: NetworkConfig;
}): React.JSX.Element {
  const signedSet = new Set(signedBy);
  // whether refractor has resolved any collected signature to a known signer.
  // when it hasn't (empty), we can't attribute signatures, so every row stays
  // Pending rather than implying nobody has signed
  const attributable = signedBy.length > 0;
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}
      data-testid="plan-signers"
    >
      {signers.map((key) => {
        const signed = signedSet.has(key);
        return (
          <div
            key={key}
            data-testid={`plan-signer-${key}`}
            data-signed={signed ? "true" : "false"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 14px",
              borderRadius: 12,
              border: signed
                ? "1px solid color-mix(in srgb, var(--success) 30%, transparent)"
                : "1px solid var(--border)",
              background: "var(--surface-2)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: "var(--surface)",
                border: signed ? "1px solid var(--success)" : "1px solid var(--border-2)",
                display: "grid",
                placeItems: "center",
                font: "600 12px/1 'Geist Mono', monospace",
                color: signed ? "var(--success)" : "var(--fg-2)",
                flexShrink: 0,
              }}
            >
              {signed ? (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                key.slice(0, 2)
              )}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <CopyableAddress
                value={key}
                label="Signer"
                head={8}
                tail={6}
                size={12.5}
                href={explorerAccountUrl(net, key)}
              />
            </div>
            {signed ? (
              <Badge tone="success">Signed</Badge>
            ) : (
              <Badge tone={attributable ? "warning" : "neutral"}>Pending</Badge>
            )}
          </div>
        );
      })}
      <div
        style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}
        data-testid="plan-signers-needed"
      >
        {signaturesNeeded > 0
          ? `Waiting on ${signaturesNeeded} more of the listed signer${
              signaturesNeeded === 1 ? "" : "s"
            }. The account's own threshold may be met before every signer signs.`
          : "Every listed signer has signed."}
      </div>
    </div>
  );
}

function SubmittedBanner({
  id,
  txHash,
  net,
}: {
  readonly id: string;
  readonly txHash: string | null;
  readonly net: NetworkConfig;
}): React.JSX.Element {
  // id IS the classic tx hash of the signed (verified) transaction, so the
  // authoritative explorer link is always id. We never link a Refractor-reported
  // submitResult.hash: a fabricated one would poison the link, and a genuine one
  // necessarily equals id anyway (signatures don't change a tx hash).
  const linkHash = txHash ?? id;
  const url = explorerTxUrl(net, linkHash);
  const awaiting = txHash === null;
  return (
    <div style={{ marginBottom: 16 }} data-testid="plan-submitted-banner">
      <Notice
        tone="success"
        title={
          awaiting
            ? "Enough signatures collected, the account is being closed"
            : "Enough signatures collected, the account has been closed"
        }
        icon={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--success)"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        }
      >
        {awaiting
          ? "Refractor submitted the transaction to the network. Once it confirms, this account is closed and any remaining XLM has been sent to the destination. "
          : "The transaction was submitted and confirmed. This account is now closed and any remaining XLM has been sent to the destination. "}
        <span
          data-testid="plan-stellar-hash"
          style={{ fontFamily: '"Geist Mono", monospace' }}
          title={linkHash}
        >
          Transaction {shortId(linkHash)}
        </span>
        {" · "}
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
        >
          View ↗
        </a>
      </Notice>
    </div>
  );
}

function FailedBanner({ reason }: { readonly reason: string }): React.JSX.Element {
  return (
    <div style={{ marginBottom: 16 }} data-testid="plan-failed-banner">
      <Notice tone="danger" title="This plan could not be submitted" role="alert">
        {reason} The account was not closed. Nothing is stored on our end to retry, ask whoever set
        up this plan to create a new one if you still want to close the account.
      </Notice>
    </div>
  );
}

function ExpiredBanner({ validUntil }: { readonly validUntil: number }): React.JSX.Element {
  return (
    <div style={{ marginBottom: 16 }} data-testid="plan-expired-banner">
      <Notice tone="warning" title="This plan has expired" role="status">
        This transaction included a deadline that has now passed
        {validUntil > 0 ? ` (${new Date(validUntil * 1000).toUTCString()})` : ""}, so the network
        can no longer accept it. Signing would have no effect. Ask whoever set up this plan to
        create a fresh one.
      </Notice>
    </div>
  );
}

// shown when the returned envelope can't be bound to the requested link and/or
// the configured network. this is a hard stop: the sign action is suppressed
// above so the user is never invited to sign a transaction we couldn't verify
function UnverifiedBanner({
  verification,
}: {
  readonly verification: EnvelopeVerification;
}): React.JSX.Element {
  const reason = !verification.hashOk
    ? "The transaction Refractor returned is not the one this link points to, its contents don't match."
    : "The transaction is for a different network than this app is configured for.";
  return (
    <div style={{ marginBottom: 16 }} data-testid="plan-unverified-banner">
      <Notice
        tone="danger"
        title="This transaction doesn't match the link, do not sign it"
        role="alert"
      >
        For your safety we checked that this is exactly the transaction this link points to, and it
        isn&apos;t. {reason} That can happen if the link was altered or points to a transaction for
        another network. We&apos;ve turned off signing, don&apos;t approve anything. Go back to
        whoever sent you the link and ask them to re-share it.
      </Notice>
    </div>
  );
}

function NotFoundState(): React.JSX.Element {
  return (
    <Card padding="28px 24px" style={{ textAlign: "center" }} data-testid="plan-not-found">
      <div
        aria-hidden
        style={{
          width: 46,
          height: 46,
          margin: "0 auto 16px",
          borderRadius: 12,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          display: "grid",
          placeItems: "center",
          color: "var(--fg-3)",
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      </div>
      <div style={{ fontWeight: 600, fontSize: 17 }}>We couldn&apos;t find this plan</div>
      <p
        style={{
          margin: "10px auto 0",
          maxWidth: 480,
          fontSize: 13,
          color: "var(--fg-2)",
          lineHeight: 1.55,
        }}
      >
        This signing plan is no longer available. Usually that means it was already completed and
        submitted, the link expired, or the link is wrong. Nothing is stored on our end to recover,
        ask whoever shared the link to send a current one.
      </p>
      <div style={{ marginTop: 18 }}>
        <Link href="/plan" style={{ textDecoration: "none" }}>
          <Button
            variant="secondary"
            size="sm"
            iconLeft={
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M19 12H5M11 18l-6-6 6-6" />
              </svg>
            }
          >
            Open a different plan
          </Button>
        </Link>
      </div>
    </Card>
  );
}

function ErrorState({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string;
}): React.JSX.Element {
  return (
    <div data-testid="plan-error">
      <Notice tone="danger" title="We couldn't reach Refractor to load this plan" role="alert">
        This is usually temporary, wait a moment and refresh. If it keeps happening, ask whoever
        shared the link to check that it&apos;s still valid.
        <details style={{ marginTop: 10 }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: 12,
              color: "var(--fg-3)",
              listStyle: "revert",
            }}
          >
            Technical details
          </summary>
          <code
            style={{
              display: "block",
              marginTop: 8,
              padding: "10px 12px",
              borderRadius: 10,
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              font: "500 11.5px/1.5 'Geist Mono', monospace",
              color: "var(--fg-3)",
              wordBreak: "break-all",
            }}
          >
            {shortId(id)}: {message}
          </code>
        </details>
      </Notice>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
