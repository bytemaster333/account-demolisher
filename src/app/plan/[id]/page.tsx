// refractor-linked plan view

import Link from "next/link";

import { AppShell } from "@/components/layout/AppShell";
import {
  Badge,
  Card,
  CopyableAddress,
  Notice,
  PageContainer,
  PageHeader,
  Progress,
  SectionLabel,
} from "@/components/ui";
import { RefractorError, getStatus, type RefractorTxStatus } from "@/lib/multisig/refractor";

import { CopyLinkButton } from "./CopyLinkButton";

interface PlanPageProps {
  readonly params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

const REFRACTOR_FRONTEND = "https://refractor.space";

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

export default async function PlanPage({ params }: PlanPageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  const result = await load(id);

  return (
    <AppShell>
      <PageContainer width={1080}>
        <PageHeader
          kicker={`Multisig · /plan/${shortId(id)}`}
          title="Collect signatures to merge"
          subtitle="This account needs multiple signatures. Share this link with the other key holders — each opens it, reviews the transaction, and adds their signature. The merge submits automatically once the threshold is met."
        />

        {result.kind === "ok" ? (
          <PlanStatusView id={id} status={result.status} />
        ) : result.kind === "not-found" ? (
          <NotFoundState id={id} />
        ) : (
          <ErrorState id={id} message={result.message} />
        )}

        <div style={{ marginTop: 16 }} data-testid="plan-disclaimer">
          <Notice tone="neutral">
            Signature collection is coordinated through{" "}
            <strong style={{ color: "var(--fg-2)" }}>Refractor</strong>, a third-party service. The
            canonical transaction is verified against the network passphrase before any signature is
            merged.
          </Notice>
        </div>
      </PageContainer>
    </AppShell>
  );
}

function PlanStatusView({
  id,
  status,
}: {
  readonly id: string;
  readonly status: RefractorTxStatus;
}): React.JSX.Element {
  const knownSigners = status.signers.length > 0;
  const threshold = status.signers.length;
  const collected = Math.max(0, threshold - status.signaturesNeeded);
  const submitted = status.submitted === true;
  const submitHash = status.submitResult?.hash ?? null;
  const refractorSignUrl = `${REFRACTOR_FRONTEND}/tx/${id}`;

  return (
    <>
      {submitted ? <SubmittedBanner txHash={submitHash} network={status.network} /> : null}

      <Card padding={0} data-testid="plan-card" style={{ overflow: "hidden" }}>
        {/* shareable link row */}
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

        <div style={{ padding: "22px 20px" }}>
          {/* progress — or indeterminate state when Refractor hasn't inspected yet */}
          {knownSigners ? (
            <Progress
              value={collected}
              max={threshold}
              label="Signature weight"
              valueLabel={`${collected} / ${threshold}`}
              data-testid="plan-counts"
            />
          ) : (
            <Notice tone="neutral" role="status" data-testid="plan-counts">
              Refractor hasn&apos;t computed the required signer set for this transaction yet.
              Reload in a moment, or sign directly on Refractor below.
            </Notice>
          )}

          {/* signers */}
          {knownSigners ? (
            <div style={{ marginTop: 22 }}>
              <SectionLabel>Signers</SectionLabel>
              <SignersList
                signers={status.signers}
                signaturesNeeded={status.signaturesNeeded}
                network={status.network}
              />
            </div>
          ) : null}

          {/* primary action — sign on Refractor (its frontend collects signatures) */}
          {!submitted ? (
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
                Add your signature on Refractor ↗
              </a>
              <p
                style={{ margin: "10px 0 0", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}
              >
                Opens Refractor&apos;s signing page for this exact transaction. Connect your wallet
                there, review the operations, and sign — your partial signature is added to the plan
                above.
              </p>
            </div>
          ) : null}

          {/* canonical XDR — collapsed by default; signers rarely need to read it */}
          <details style={{ marginTop: 20 }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--fg-2)",
                listStyle: "none",
              }}
            >
              Show canonical transaction (XDR) · {status.network}
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
              {status.xdr}
            </div>
          </details>
        </div>
      </Card>
    </>
  );
}

function SignersList({
  signers,
  signaturesNeeded,
  network,
}: {
  readonly signers: readonly string[];
  readonly signaturesNeeded: number;
  readonly network: string;
}): React.JSX.Element {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 11 }}
      data-testid="plan-signers"
    >
      {signers.map((key) => {
        const href = accountExplorerUrl(network, key);
        return (
          <div
            key={key}
            data-testid={`plan-signer-${key}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 14px",
              borderRadius: 12,
              border: "1px solid var(--border)",
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
                border: "1px solid var(--border-2)",
                display: "grid",
                placeItems: "center",
                font: "600 12px/1 'Geist Mono', monospace",
                color: "var(--fg-2)",
                flexShrink: 0,
              }}
            >
              {key.slice(0, 2)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <CopyableAddress
                value={key}
                label="Signer"
                head={8}
                tail={6}
                size={12.5}
                {...(href !== undefined ? { href } : {})}
              />
            </div>
            <Badge tone="warning">Pending</Badge>
          </div>
        );
      })}
      <div
        style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 2 }}
        data-testid="plan-signers-needed"
      >
        {signaturesNeeded > 0
          ? `${signaturesNeeded} more signature${signaturesNeeded === 1 ? "" : "s"} required.`
          : "All required signatures collected. Refractor will submit shortly."}
      </div>
    </div>
  );
}

function SubmittedBanner({
  txHash,
  network,
}: {
  readonly txHash: string | null;
  readonly network: string;
}): React.JSX.Element {
  const horizonUrl = txHash !== null ? horizonTxUrl(network, txHash) : null;
  return (
    <div style={{ marginBottom: 16 }} data-testid="plan-submitted-banner">
      <Notice
        tone="success"
        title="Threshold met — transaction submitted"
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
        <span
          data-testid="plan-stellar-hash"
          style={{ fontFamily: '"Geist Mono", monospace' }}
          title={txHash ?? undefined}
        >
          {txHash !== null ? shortId(txHash) : "Refractor confirmed submission; awaiting tx hash."}
        </span>
        {horizonUrl !== null ? (
          <>
            {" · "}
            <a
              href={horizonUrl}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
            >
              View ↗
            </a>
          </>
        ) : null}
      </Notice>
    </div>
  );
}

function NotFoundState({ id }: { readonly id: string }): React.JSX.Element {
  return (
    <Card padding="28px 24px" style={{ textAlign: "center" }} data-testid="plan-not-found">
      <div style={{ fontWeight: 600, fontSize: 17 }}>No such plan on Refractor</div>
      <p
        style={{
          margin: "10px auto 0",
          maxWidth: 480,
          fontSize: 13,
          color: "var(--fg-2)",
          lineHeight: 1.55,
        }}
      >
        Refractor returned 404 for hash{" "}
        <code style={{ fontFamily: '"Geist Mono", monospace' }}>{shortId(id)}</code>. Either the
        envelope was already submitted and purged, the link expired, or it was never uploaded.
        Demolisher does not cache plans locally — there is nothing to recover here.
      </p>
      <Link
        href="/plan"
        style={{
          display: "inline-block",
          marginTop: 18,
          font: "600 13px/1 Geist, sans-serif",
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        ← Open a different plan
      </Link>
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
      <Notice tone="danger" title="Failed to load transaction from Refractor">
        Refractor returned an unexpected error while looking up hash{" "}
        <code style={{ fontFamily: '"Geist Mono", monospace' }}>{shortId(id)}</code>.
        <code
          style={{
            display: "block",
            marginTop: 10,
            padding: "10px 12px",
            borderRadius: 10,
            background: "var(--bg-2)",
            border: "1px solid var(--border)",
            font: "500 11.5px/1.5 'Geist Mono', monospace",
            color: "var(--fg-3)",
            wordBreak: "break-all",
          }}
        >
          {message}
        </code>
      </Notice>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function horizonTxUrl(network: string, hash: string): string | null {
  const slug = explorerSlug(network);
  return slug === null ? null : `https://stellar.expert/explorer/${slug}/tx/${hash}`;
}

// account explorer link from Refractor's network string ("public"/"testnet"/…)
function accountExplorerUrl(network: string, key: string): string | undefined {
  const slug = explorerSlug(network);
  return slug === null ? undefined : `https://stellar.expert/explorer/${slug}/account/${key}`;
}

function explorerSlug(network: string): string | null {
  const net = network.toLowerCase();
  if (net === "public") return "public";
  if (net === "testnet") return "testnet";
  if (net === "futurenet") return "futurenet";
  return null;
}
