// refractor-linked plan view. server component that fetches live status and renders it.

import Link from "next/link";

import { getStatus, type RefractorTxStatus } from "@/lib/multisig/refractor";

interface PlanPageProps {
  readonly params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export default async function PlanPage({ params }: PlanPageProps): Promise<React.JSX.Element> {
  const { id } = await params;

  let status: RefractorTxStatus | null = null;
  let error: string | null = null;
  try {
    status = await getStatus(id);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-slate-900">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          Refractor pending transaction
        </p>
        <h1 className="mt-1 text-2xl font-bold">{id.length > 12 ? `${id.slice(0, 12)}…` : id}</h1>
        <p className="mt-1 font-mono text-xs text-slate-600 break-all">{id}</p>
      </header>

      {error !== null ? (
        <section
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900"
          role="alert"
          data-testid="plan-error"
        >
          <p className="font-semibold">Failed to load transaction from Refractor.</p>
          <p className="mt-1 font-mono text-xs">{error}</p>
        </section>
      ) : status !== null ? (
        <StatusBlock status={status} />
      ) : null}

      <footer>
        <Link
          href="/demolish"
          className="text-sm font-medium text-indigo-700 underline hover:no-underline"
        >
          ← Back to demolish
        </Link>
      </footer>
    </main>
  );
}

function StatusBlock({ status }: { status: RefractorTxStatus }): React.JSX.Element {
  const collected = Math.max(
    0,
    status.signers.length - status.signaturesNeeded > 0
      ? status.signers.length - status.signaturesNeeded
      : 0,
  );
  const total = status.signers.length;
  const pendingPct = total > 0 ? Math.min(100, (collected / total) * 100) : 0;

  return (
    <>
      <section
        className="rounded-lg border border-slate-300 bg-white p-4"
        data-testid="plan-summary"
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <dt className="text-slate-600">Network</dt>
          <dd className="font-mono">{status.network}</dd>

          <dt className="text-slate-600">Submission status</dt>
          <dd className="font-mono" data-testid="plan-submission-state">
            {status.submitted === true
              ? "submitted"
              : status.signaturesNeeded <= 0
                ? "ready"
                : "awaiting signatures"}
          </dd>

          <dt className="text-slate-600">Signatures collected</dt>
          <dd className="font-mono" data-testid="plan-counts">
            {collected} / {total} (need {status.signaturesNeeded} more)
          </dd>

          {status.expiresAt ? (
            <>
              <dt className="text-slate-600">Expires</dt>
              <dd className="font-mono">{new Date(status.expiresAt * 1_000).toISOString()}</dd>
            </>
          ) : null}

          {status.submitResult?.hash ? (
            <>
              <dt className="text-slate-600">Stellar tx hash</dt>
              <dd className="font-mono break-all" data-testid="plan-stellar-hash">
                {status.submitResult.hash}
              </dd>
            </>
          ) : null}
        </dl>

        {total > 0 ? (
          <div
            className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuenow={collected}
            aria-valuemin={0}
            aria-valuemax={total}
          >
            <div
              className="h-full rounded-full bg-indigo-600 transition-all"
              style={{ width: `${pendingPct}%` }}
              data-testid="plan-progress-bar"
            />
          </div>
        ) : null}
      </section>

      <section
        className="rounded-lg border border-slate-300 bg-white p-4"
        data-testid="plan-signers"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
          Signers still required
        </h2>
        {status.signers.length === 0 ? (
          <p className="mt-2 text-sm italic text-slate-500">
            None reported — Refractor either has every signature or has not yet enumerated the
            signer set.
          </p>
        ) : (
          <ul className="mt-3 space-y-1 text-xs">
            {status.signers.map((signer) => (
              <li
                key={signer}
                className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono"
                data-testid={`plan-signer-${signer}`}
              >
                <span className="break-all">{signer}</span>
                <span className="ml-2 font-mono text-[10px] uppercase text-amber-700">pending</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* canonical xdr — show what's being signed */}
      <section className="rounded-lg border border-slate-300 bg-white p-4" data-testid="plan-xdr">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
          Transaction envelope (XDR)
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          The base64-encoded transaction Refractor is gathering signatures against.
        </p>
        <code className="mt-2 block max-h-48 overflow-y-auto break-all rounded bg-slate-50 p-2 font-mono text-[10px] text-slate-800">
          {status.xdr}
        </code>
      </section>
    </>
  );
}
