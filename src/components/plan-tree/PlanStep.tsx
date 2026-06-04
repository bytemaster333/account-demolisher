// per-node row for the plan tree: status icon + description + kind badge + expandable drawer

import { type ReactElement } from "react";

import type { PlanNode, PlanNodeStatus } from "@/lib/plan/tree";
import { cn } from "@/lib/utils";

import { SimulationPanel } from "./SimulationPanel";

const STATUS_ICON: Record<PlanNodeStatus, string> = {
  pending: "▸",
  simulated: "◇",
  signed: "✎",
  submitted: "▴",
  confirmed: "✓",
  failed: "✗",
  skipped: "◌",
};

const STATUS_TONE: Record<PlanNodeStatus, string> = {
  pending: "border-slate-200 bg-white text-slate-700",
  simulated: "border-sky-300 bg-sky-50 text-sky-900",
  signed: "border-indigo-300 bg-indigo-50 text-indigo-900",
  submitted: "border-amber-300 bg-amber-50 text-amber-900",
  confirmed: "border-emerald-400 bg-emerald-50 text-emerald-900",
  failed: "border-red-400 bg-red-50 text-red-900",
  skipped: "border-slate-200 bg-slate-100 text-slate-600",
};

export interface PlanStepProps {
  readonly node: PlanNode;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
}

export function PlanStep({ node, expanded, onToggle, className }: PlanStepProps): ReactElement {
  const tone = STATUS_TONE[node.status];
  const icon = STATUS_ICON[node.status];
  return (
    <li
      className={cn("rounded-md border p-3 transition-colors", tone, className)}
      data-testid={`plan-step-${node.id}`}
      data-status={node.status}
      data-kind={node.kind}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`plan-step-detail-${node.id}`}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="flex flex-1 items-start gap-3">
          <span aria-hidden="true" className="mt-0.5 font-mono text-base leading-none">
            {icon}
          </span>
          <div className="flex flex-1 flex-col">
            <span className="text-sm font-semibold leading-snug">{node.description}</span>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span className="rounded bg-slate-200 px-1.5 py-0.5 font-mono uppercase text-slate-800">
                {node.kind}
              </span>
              <span className="font-mono">{node.status}</span>
              {node.executed?.txHash ? (
                <span className="font-mono text-[10px]">
                  tx: {node.executed.txHash.slice(0, 8)}…{node.executed.txHash.slice(-4)}
                </span>
              ) : null}
              {node.dependencies.length > 0 ? (
                <span className="text-[10px] text-slate-500">deps: {node.dependencies.length}</span>
              ) : null}
            </div>
            {node.error ? (
              <p className="mt-1 break-words text-xs text-red-700">{node.error}</p>
            ) : null}
          </div>
        </div>
        <span aria-hidden="true" className="text-xs text-slate-500">
          {expanded ? "▾" : "▸"}
        </span>
      </button>

      {expanded ? (
        <div
          id={`plan-step-detail-${node.id}`}
          className="mt-3 flex flex-col gap-2 border-t border-slate-200 pt-2"
        >
          <SimulationPanel outcome={node.simulated} />
          <NodeMetadataView node={node} />
        </div>
      ) : null}
    </li>
  );
}

// per-kind metadata so the user sees pool ids etc. without decoding xdr
function NodeMetadataView({ node }: { node: PlanNode }): ReactElement {
  switch (node.kind) {
    case "RevokeAllowance":
      return (
        <KeyValue
          entries={[
            { k: "contract", v: node.metadata.contractId },
            { k: "spender", v: node.metadata.spender },
          ]}
        />
      );
    case "RepayBlend":
      return (
        <KeyValue
          entries={[
            { k: "pool", v: node.metadata.poolId },
            { k: "asset", v: node.metadata.asset },
            { k: "amount", v: node.metadata.amount.toString() },
          ]}
        />
      );
    case "PayFxDAODebt":
      return (
        <KeyValue
          entries={[
            { k: "denomination", v: node.metadata.vaultDenomination },
            { k: "debt", v: node.metadata.debt.toString() },
          ]}
        />
      );
    case "WithdrawBlend":
      return (
        <KeyValue
          entries={[
            { k: "pool", v: node.metadata.poolId },
            { k: "asset", v: node.metadata.asset },
            { k: "bucket", v: node.metadata.bucket },
          ]}
        />
      );
    case "WithdrawAquarius":
      return (
        <KeyValue
          entries={[
            { k: "pool", v: node.metadata.poolIndex },
            { k: "shares", v: node.metadata.shareAmount.toString() },
          ]}
        />
      );
    case "WithdrawSoroswapLp":
      return (
        <KeyValue
          entries={[
            { k: "tokenA", v: node.metadata.tokenA },
            { k: "tokenB", v: node.metadata.tokenB },
            { k: "shares", v: node.metadata.shareBalance.toString() },
          ]}
        />
      );
    case "RedeemFxDAO":
      return (
        <KeyValue
          entries={[
            { k: "denomination", v: node.metadata.vaultDenomination },
            { k: "collateral", v: node.metadata.collateral.toString() },
          ]}
        />
      );
    case "ClaimBlendEmissions":
      return (
        <KeyValue
          entries={[
            { k: "pool", v: node.metadata.poolId },
            {
              k: "reserves",
              v: node.metadata.reserveTokenIds.join(", ") || "(all touched)",
            },
          ]}
        />
      );
    case "ClaimAquariusRewards":
      return <KeyValue entries={[{ k: "pool", v: node.metadata.poolIndex }]} />;
    case "ConvertSorobanToXLM":
      return (
        <KeyValue
          entries={[
            { k: "asset", v: describeAsset(node.metadata.asset) },
            { k: "amount", v: node.metadata.amount.toString() },
          ]}
        />
      );
    case "TransferAsIs":
      return (
        <KeyValue
          entries={[
            { k: "asset", v: describeAsset(node.metadata.asset) },
            { k: "amount", v: node.metadata.amount.toString() },
            { k: "destination", v: node.metadata.destination },
          ]}
        />
      );
    case "BackstopQueue":
      return (
        <KeyValue
          entries={[
            { k: "pool", v: node.metadata.poolId },
            { k: "shares", v: node.metadata.shares.toString() },
            { k: "queue ends", v: node.metadata.queueEndsAt.toISOString() },
          ]}
        />
      );
    case "FinalClassicTx":
      return (
        <KeyValue
          entries={[
            { k: "destination", v: node.metadata.destination },
            { k: "mediator", v: node.metadata.useMediator ? "yes" : "no" },
            { k: "batches", v: node.metadata.batches.length.toString() },
            {
              k: "ops",
              v: node.metadata.batches.reduce((acc, b) => acc + b.operations.length, 0).toString(),
            },
          ]}
        />
      );
    case "MediatorForward":
      return (
        <KeyValue
          entries={[
            { k: "mediator", v: node.metadata.mediatorPublicKey },
            { k: "destination", v: node.metadata.ultimateDestination },
          ]}
        />
      );
  }
}

function KeyValue({
  entries,
}: {
  readonly entries: ReadonlyArray<{ k: string; v: string }>;
}): ReactElement {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(({ k, v }) => (
        <div key={k} className="contents">
          <dt className="text-slate-600">{k}</dt>
          <dd className="break-all font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function describeAsset(asset: unknown): string {
  if (typeof asset !== "object" || asset === null) return String(asset);
  const a = asset as { kind?: string; code?: string; issuer?: string; poolId?: string };
  switch (a.kind) {
    case "native":
      return "XLM";
    case "credit":
      return `${a.code ?? "?"}:${a.issuer ?? "?"}`;
    case "liquidity_pool_shares":
      return `pool:${a.poolId ?? "?"}`;
    default:
      return JSON.stringify(asset);
  }
}
