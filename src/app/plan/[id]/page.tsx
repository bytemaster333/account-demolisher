// refractor-linked plan view

import Link from "next/link";

import { AppShell } from "@/components/layout/AppShell";
import { RefractorError, getStatus, type RefractorTxStatus } from "@/lib/multisig/refractor";

import { CopyLinkButton } from "./CopyLinkButton";

interface PlanPageProps {
  readonly params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

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
      <section
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "40px 28px 96px",
        }}
      >
        <div
          style={{
            font: "600 12px/1 Geist,sans-serif",
            color: "var(--accent)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: 13,
          }}
          data-testid="plan-breadcrumb"
        >
          Multisig coordination · /plan/{shortId(id)}
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: "-0.03em",
          }}
        >
          Collect signatures to merge
        </h1>
        <p
          style={{
            margin: "13px 0 26px",
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--fg-2)",
            maxWidth: 560,
          }}
        >
          This account requires multiple signatures. Share this link with the other key holders,
          each opens it, reviews the transaction, and adds their signature. The merge submits
          automatically once the threshold is met.
        </p>

        {result.kind === "ok" ? (
          <PlanStatusView id={id} status={result.status} />
        ) : result.kind === "not-found" ? (
          <NotFoundState id={id} />
        ) : (
          <ErrorState id={id} message={result.message} />
        )}

        <p
          style={{
            margin: "16px 0 0",
            fontSize: 12,
            color: "var(--fg-3)",
            lineHeight: 1.5,
            display: "flex",
            gap: 8,
          }}
          data-testid="plan-disclaimer"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--fg-3)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: 1 }}
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          <span>
            Signature collection is coordinated through{" "}
            <strong style={{ color: "var(--fg-2)" }}>Refractor</strong>, a third-party service. The
            canonical transaction is verified against this network&apos;s passphrase before any
            signature is merged.
          </span>
        </p>
      </section>
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
  const threshold = status.signers.length;
  const collected = Math.max(0, threshold - status.signaturesNeeded);
  const pct = threshold > 0 ? Math.min(100, (collected / threshold) * 100) : 0;
  const submitted = status.submitted === true;
  const submitHash = status.submitResult?.hash ?? null;

  return (
    <>
      {submitted ? <SubmittedBanner txHash={submitHash} network={status.network} /> : null}

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "var(--shadow-sm)",
        }}
        data-testid="plan-card"
      >
        <LinkRow planId={id} />

        <div style={{ padding: "22px 20px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14 }}>Signature weight</span>
            <span
              style={{
                font: "600 13px/1 'Geist Mono', monospace",
                color: "var(--fg-2)",
              }}
              data-testid="plan-counts"
            >
              {collected} / {threshold}
            </span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={collected}
            aria-valuemin={0}
            aria-valuemax={threshold}
            style={{
              height: 8,
              borderRadius: 999,
              background: "var(--surface-3)",
              overflow: "hidden",
              marginBottom: 22,
            }}
          >
            <div
              data-testid="plan-progress-bar"
              style={{
                height: "100%",
                width: `${pct}%`,
                borderRadius: 999,
                background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
                transition: "width .4s ease",
              }}
            />
          </div>

          <div
            style={{
              font: "600 10px/1 Geist,sans-serif",
              color: "var(--fg-3)",
              letterSpacing: "0.06em",
              marginBottom: 11,
            }}
          >
            SIGNERS
          </div>
          <SignersList signers={status.signers} signaturesNeeded={status.signaturesNeeded} />

          <div
            style={{
              font: "600 10px/1 Geist,sans-serif",
              color: "var(--fg-3)",
              letterSpacing: "0.06em",
              marginBottom: 9,
              marginTop: 22,
            }}
          >
            CANONICAL TRANSACTION (XDR) · {status.network}
          </div>
          <div
            data-testid="plan-xdr"
            style={{
              padding: "12px 13px",
              borderRadius: 11,
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              font: "500 11px/1.6 'Geist Mono', monospace",
              color: "var(--fg-3)",
              wordBreak: "break-all",
              maxHeight: 140,
              overflow: "auto",
              marginBottom: submitted ? 0 : 20,
            }}
          >
            {status.xdr}
          </div>

          {!submitted ? <SignCta /> : null}
        </div>
      </div>
    </>
  );
}

function LinkRow({ planId }: { readonly planId: string }): React.JSX.Element {
  const displayUrl = `/plan/${shortId(planId)}`;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "16px 20px",
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
        title={displayUrl}
      >
        {displayUrl}
      </span>
      <CopyLinkButton />
    </div>
  );
}

function SignersList({
  signers,
  signaturesNeeded,
}: {
  readonly signers: readonly string[];
  readonly signaturesNeeded: number;
}): React.JSX.Element {
  if (signers.length === 0) {
    return (
      <div
        style={{
          padding: "14px 16px",
          borderRadius: 12,
          border: "1px dashed var(--border-2)",
          color: "var(--fg-3)",
          fontSize: 13,
          fontStyle: "italic",
          marginBottom: 0,
        }}
      >
        Refractor has not reported a signer set for this transaction yet.
      </div>
    );
  }

  // refractor's GET /tx returns the signer keys that still need to sign — it
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="plan-signers">
      {signers.map((key) => (
        <div
          key={key}
          data-testid={`plan-signer-${key}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: "var(--surface)",
              border: "1px solid var(--border-2)",
              display: "grid",
              placeItems: "center",
              font: "600 13px/1 'Geist Mono', monospace",
              color: "var(--fg-2)",
            }}
          >
            {key.slice(0, 2)}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                font: "600 12.5px/1.4 'Geist Mono', monospace",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={key}
            >
              {key}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", marginTop: 3 }}>
              awaiting signature
            </div>
          </div>
          <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--fg-3)" }}>Pending</span>
        </div>
      ))}
      <div
        style={{
          fontSize: 11.5,
          color: "var(--fg-3)",
          marginTop: 2,
        }}
        data-testid="plan-signers-needed"
      >
        {signaturesNeeded > 0
          ? `${signaturesNeeded} more signature${signaturesNeeded === 1 ? "" : "s"} required.`
          : "All required signatures collected. Refractor will submit shortly."}
      </div>
    </div>
  );
}

function SignCta(): React.JSX.Element {
  return (
    <div data-testid="plan-sign-cta">
      <Link
        href="/demolish"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 9,
          padding: 14,
          borderRadius: 12,
          border: "none",
          background: "var(--accent)",
          color: "var(--accent-fg)",
          fontWeight: 600,
          fontSize: 15,
          cursor: "pointer",
          boxShadow: "0 6px 20px var(--accent-soft)",
          textDecoration: "none",
          boxSizing: "border-box",
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
        >
          <path d="M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.6 7.6" />
          <circle cx="11" cy="11" r="2" />
        </svg>
        Connect wallet &amp; sign
      </Link>
      <p
        style={{
          margin: "10px 0 0",
          fontSize: 12,
          color: "var(--fg-3)",
          lineHeight: 1.5,
        }}
      >
        Signing happens inside the Demolisher app: connect a wallet, review the canonical XDR, and
        the partial-signed envelope is pushed back to Refractor.
      </p>
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
    <div
      data-testid="plan-submitted-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 13,
        padding: "18px 20px",
        borderRadius: 15,
        background: "var(--success-soft)",
        border: "1px solid color-mix(in srgb, var(--success) 30%, transparent)",
        marginBottom: 18,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 38,
          height: 38,
          borderRadius: 11,
          background: "var(--surface)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <svg
          width="19"
          height="19"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--success)"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>Threshold met, transaction submitted</div>
        <div
          style={{
            fontSize: 13,
            color: "var(--fg-2)",
            marginTop: 2,
            fontFamily: "'Geist Mono', monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          data-testid="plan-stellar-hash"
          title={txHash ?? undefined}
        >
          {txHash ?? "Refractor confirmed submission; awaiting tx hash."}
        </div>
      </div>
      {horizonUrl !== null ? (
        <a
          href={horizonUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            font: "600 13px/1 'Geist Mono', monospace",
            color: "var(--accent)",
            textDecoration: "none",
          }}
        >
          View ↗
        </a>
      ) : null}
    </div>
  );
}

function NotFoundState({ id }: { readonly id: string }): React.JSX.Element {
  return (
    <div
      role="alert"
      data-testid="plan-not-found"
      style={{
        padding: "32px 24px",
        borderRadius: 16,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        textAlign: "center",
      }}
    >
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
        <code style={{ fontFamily: "'Geist Mono', monospace" }}>{shortId(id)}</code>. Either the
        envelope has already been submitted and Refractor has purged it, the link expired, or it was
        never uploaded. Demolisher does not cache plans locally — there is nothing to recover here.
      </p>
      <Link
        href="/plan"
        style={{
          display: "inline-block",
          marginTop: 18,
          font: "600 13px/1 Geist,sans-serif",
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        ← Open a different plan
      </Link>
    </div>
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
    <div
      role="alert"
      data-testid="plan-error"
      style={{
        padding: "24px",
        borderRadius: 16,
        border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
        background: "color-mix(in srgb, var(--danger) 8%, var(--surface))",
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 15, color: "var(--danger)" }}>
        Failed to load transaction from Refractor
      </div>
      <p
        style={{
          margin: "8px 0 0",
          fontSize: 13,
          color: "var(--fg-2)",
          lineHeight: 1.5,
        }}
      >
        Refractor returned an unexpected error while looking up hash{" "}
        <code style={{ fontFamily: "'Geist Mono', monospace" }}>{shortId(id)}</code>.
      </p>
      <code
        style={{
          display: "block",
          marginTop: 12,
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
      <p
        style={{
          margin: "12px 0 0",
          fontSize: 12,
          color: "var(--fg-3)",
          lineHeight: 1.5,
        }}
      >
        Try reloading in a moment. If the error persists, Refractor may be unavailable.
      </p>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function horizonTxUrl(network: string, hash: string): string | null {
  const net = network.toLowerCase();
  if (net === "public") return `https://stellar.expert/explorer/public/tx/${hash}`;
  if (net === "testnet") return `https://stellar.expert/explorer/testnet/tx/${hash}`;
  if (net === "futurenet") return `https://stellar.expert/explorer/futurenet/tx/${hash}`;
  return null;
}
