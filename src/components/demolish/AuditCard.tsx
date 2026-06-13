// read-only summary of an AccountAudit. presentational only

import type { AccountAudit, AuditBalance } from "@/lib/types/account";
import { cn } from "@/lib/utils";

export interface AuditCardProps {
  readonly audit: AccountAudit;
  readonly className?: string;
}

export function AuditCard({ audit, className }: AuditCardProps): React.JSX.Element {
  const native = audit.balances.find((b) => b.asset.kind === "native");
  const xlm = native?.amount ?? "0";
  const nonNativeCount = audit.balances.filter((b) => b.asset.kind !== "native").length;

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4 text-sm",
        className,
      )}
      aria-labelledby="audit-card-heading"
    >
      <header className="flex items-baseline justify-between gap-4">
        <h2 id="audit-card-heading" className="text-base font-semibold">
          Audit
        </h2>
        <code className="font-mono text-xs text-slate-600" title={audit.accountId}>
          {truncate(audit.accountId)}
        </code>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Stat label="XLM balance" value={`${xlm} XLM`} />
        <Stat label="Subentries" value={String(audit.subentryCount)} />
        <Stat label="Signers" value={String(audit.signers.length)} />
        <Stat label="Trustlines" value={String(nonNativeCount)} />
        <Stat label="Open offers" value={String(audit.offers.length)} />
        <Stat label="Data entries" value={String(audit.data.length)} />
        <Stat label="Pool shares" value={String(audit.poolShares.length)} />
        <Stat label="Claimable balances" value={String(audit.claimableBalances.length)} />
        <Stat label="Sponsoring" value={String(audit.sponsorship.numSponsoring)} />
        <Stat label="Sponsored" value={String(audit.sponsorship.numSponsored)} />
      </dl>

      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-slate-500">Thresholds</p>
        <p className="font-mono text-xs">
          master = {audit.thresholds.masterWeight} / low = {audit.thresholds.low} / med ={" "}
          {audit.thresholds.medium} / high = {audit.thresholds.high}
        </p>
      </div>

      {audit.flags.authImmutable ? (
        <p
          role="alert"
          className="rounded-sm border border-red-400 bg-red-50 px-2 py-1 text-xs text-red-900"
        >
          AUTH_IMMUTABLE is set — this account is permanently unmergeable.
        </p>
      ) : null}

      {audit.requiresMultisig ? (
        <p
          role="alert"
          className="rounded-sm border border-amber-400 bg-amber-50 px-2 py-1 text-xs text-amber-900"
        >
          Account requires multisig coordination.
        </p>
      ) : null}

      <MergeabilityRow audit={audit} />

      {audit.balances.some(isResidual) ? (
        <details className="rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
          <summary className="cursor-pointer">Residual non-XLM balances</summary>
          <ul className="mt-1 space-y-0.5">
            {audit.balances.filter(isResidual).map((b, i) => (
              <li key={i} className="font-mono">
                {balanceLabel(b)}: {b.amount}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function MergeabilityRow({ audit }: { audit: AccountAudit }): React.JSX.Element {
  if (audit.mergeability.mergeable) {
    return (
      <p className="rounded-sm border border-emerald-400 bg-emerald-50 px-2 py-1 text-xs text-emerald-900">
        Mergeable.
      </p>
    );
  }
  const detail =
    "detail" in audit.mergeability && audit.mergeability.detail !== undefined
      ? ` — ${audit.mergeability.detail}`
      : "";
  return (
    <p
      role="alert"
      className="rounded-sm border border-red-400 bg-red-50 px-2 py-1 text-xs text-red-900"
    >
      Not mergeable ({audit.mergeability.reason}){detail}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}

function truncate(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function isResidual(b: AuditBalance): boolean {
  if (b.asset.kind === "native") return false;
  for (const ch of b.amount) {
    if (ch >= "1" && ch <= "9") return true;
  }
  return false;
}

function balanceLabel(b: AuditBalance): string {
  switch (b.asset.kind) {
    case "native":
      return "XLM";
    case "credit":
      return `${b.asset.code}:${b.asset.issuer.slice(0, 6)}…`;
    case "liquidity_pool_shares":
      return `LP:${b.asset.poolId.slice(0, 8)}…`;
  }
}
