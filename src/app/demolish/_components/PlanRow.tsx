"use client";

import { InfoTip } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { explorerTxUrl } from "@/lib/explorer";
import type { PlanNode } from "@/lib/plan/tree";

import { SR_ONLY } from "../_lib/a11y";
import { errorMessage } from "@/lib/errors";

import { feeIsUnbuilt, nodeFeeStroops, nodeMaxFeeStroops, stroopsToXlm } from "../_lib/fees";
import { nodeExplainer, nodeLabel, nodePlainLabel, simulatedBadgeLabel } from "../_lib/plan-copy";
import { shortAddress } from "@/lib/safe-display";

export function PlanRow({
  node,
  network,
  mode = "live",
  index,
  deterministic = false,
  deferredAfter,
}: {
  readonly node: PlanNode;
  readonly network: NetworkConfig;
  // "plan" = pre-execution review (numbered, shows the XLM fee, no status);
  // "live" = during/after execution (status indicator, tx link, no fee)
  readonly mode?: "plan" | "live";
  // the step number in the review; a skipped step has none
  readonly index?: number;
  // shared-account plan: nothing is sold on the market (changes the explainer)
  readonly deterministic?: boolean;
  // plain labels of the steps a deferred step is built after
  readonly deferredAfter?: readonly string[];
}): React.JSX.Element {
  // a landed receipt is the truth: a later failure event may overwrite a step's
  // status, but never undo what reached the chain
  const landed = node.executed !== undefined;
  const isDone = node.status === "confirmed" || landed;
  const isRunning = !landed && (node.status === "signed" || node.status === "submitted");
  const isSkipped = !landed && node.status === "skipped";
  const isFailed = !landed && node.status === "failed";
  // a step whose preview check passed, distinct from a step not yet checked. In the plan/review this is the central output of the dry run, so
  // it must read differently from a plain "pending" step. But during LIVE
  // execution a not-yet-run step is still "simulated", and its accent-check badge
  // reads as "done": there it must render as pending (waiting) so only a real
  // "confirmed" step shows the green check.
  const isSimulated = mode !== "live" && node.status === "simulated";
  const isPending = !isDone && !isRunning && !isSkipped && !isFailed && !isSimulated;

  // plan mode surfaces the network fee up-front so cost is visible before
  // signing; live mode drops it (once submitted the fee is spent and the tx
  // link is what matters). A step built only after earlier ones land shows the
  // most it can be signed for, and a fee the page can't read is shown on this
  // row rather than taking the whole Review down.
  const deferred = node.deferred !== undefined && node.status === "pending";
  const fee = mode === "plan" ? stepFee(node) : null;
  // a swap shows what it expects and the floor it signs (XLM has 7 decimals)
  const quote =
    mode === "plan" && node.kind === "ConvertSorobanToXLM"
      ? (node.metadata.reviewedQuote ?? node.metadata.quote ?? null)
      : null;

  // live mode highlights the step that's currently signing/submitting
  const highlight = mode === "live" && isRunning;

  return (
    <div data-testid="plan-row" style={{ borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{
          width: "100%",
          display: "flex",
          alignItems: "flex-start",
          gap: 11,
          padding: "9px 10px",
          background: highlight ? "var(--surface-2)" : "none",
          border: "none",
          borderRadius: 10,
          color: "var(--fg)",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            flexShrink: 0,
            position: "relative",
            width: 24,
            height: 24,
            marginTop: 1,
          }}
        >
          {mode === "live" ? (
            <span style={SR_ONLY}>
              {isDone
                ? "Done: "
                : isRunning
                  ? "In progress: "
                  : isFailed
                    ? "Failed: "
                    : isSkipped
                      ? "Skipped: "
                      : isSimulated
                        ? "Simulated: "
                        : "Pending: "}
            </span>
          ) : (
            // the plan view shows status only as color and a badge, so say it
            <span style={SR_ONLY}>
              {index === undefined ? "" : `Step ${index}, `}
              {isSimulated
                ? `${simulatedBadgeLabel(node)}: `
                : isFailed
                  ? "Dry run failed: "
                  : isSkipped
                    ? "Skipped: "
                    : "Not checked: "}
            </span>
          )}
          {mode === "plan" ? (
            <span
              aria-hidden
              // a simulated step gets an accent ring + a small check badge so the
              // check result reads at a glance; an unchecked step stays neutral
              title={isSimulated ? `${simulatedBadgeLabel(node)} for this step` : undefined}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: isSimulated
                  ? "1.5px solid var(--accent-line)"
                  : "1.5px solid var(--border-2)",
                display: "grid",
                placeItems: "center",
                font: "600 11px/1 'Geist Mono', monospace",
                color: isSimulated ? "var(--accent)" : "var(--fg-3)",
              }}
            >
              {index ?? ""}
              {isSimulated ? (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    right: -2,
                    bottom: -2,
                    width: 11,
                    height: 11,
                    borderRadius: "50%",
                    background: "var(--surface)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--success)"
                    strokeWidth={4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              ) : null}
            </span>
          ) : (
            <>
              {isDone ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--success)"
                    strokeWidth={3.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              ) : null}
              {isRunning ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    border: "2px solid var(--accent-soft)",
                    borderTopColor: "var(--accent)",
                    animation: "spin .8s linear infinite",
                  }}
                />
              ) : null}
              {isPending ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 3,
                    borderRadius: "50%",
                    border: "1.5px solid var(--border-2)",
                  }}
                />
              ) : null}
              {isSimulated ? (
                // dry-run passed, not yet executing: a faint accent ring with a
                // small check, distinct from the empty "pending" circle
                <span
                  title={`${simulatedBadgeLabel(node)} for this step`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    border: "1.5px solid var(--accent-line)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
              ) : null}
              {isSkipped ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--warning)"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4l3 2" />
                  </svg>
                </span>
              ) : null}
              {isFailed ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: "50%",
                    background: "var(--surface-2)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--danger)"
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </span>
              ) : null}
            </>
          )}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            {mode === "plan" ? (
              <InfoTip tip={nodeExplainer(node, { deterministic })}>
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    color: isFailed ? "var(--danger)" : "var(--fg)",
                  }}
                >
                  {nodePlainLabel(node)}
                </span>
              </InfoTip>
            ) : (
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 13,
                  color: isFailed ? "var(--danger)" : "var(--fg)",
                }}
              >
                {nodePlainLabel(node)}
              </span>
            )}
            <span
              style={{
                font: "500 10.5px/1.2 'Geist Mono', monospace",
                color: "var(--fg-3)",
              }}
            >
              {nodeLabel(node)}
            </span>
            {isSkipped ? (
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 5,
                  background: "var(--surface-2)",
                  font: "600 9.5px/1.2 Geist, sans-serif",
                  color: "var(--warning)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                skipped
              </span>
            ) : null}
            {fee !== null && fee.kind !== "error" && (fee.kind === "unbuilt" || fee.typical > 0) ? (
              <span
                data-testid="plan-row-fee"
                style={{
                  marginLeft: "auto",
                  font: "500 11px/1 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                  whiteSpace: "nowrap",
                }}
              >
                {fee.kind === "unbuilt"
                  ? `fee up to ${stroopsToXlm(fee.max)} XLM`
                  : fee.kind === "capped"
                    ? `fee up to ${stroopsToXlm(fee.typical)} XLM`
                    : `fee about ${stroopsToXlm(fee.typical)} XLM, up to ${stroopsToXlm(fee.max)} XLM`}
              </span>
            ) : null}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-3)",
              marginTop: 3,
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={node.description}
            >
              {node.description}
            </span>
            {node.executed?.txHash ? (
              <a
                href={explorerTxUrl(network, node.executed.txHash)}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  font: "500 11px/1 'Geist Mono', monospace",
                  color: "var(--fg-3)",
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  whiteSpace: "nowrap",
                }}
                title={`Open the public record of this step on a block explorer (${node.executed.txHash})`}
                onClick={(e) => e.stopPropagation()}
              >
                <span>proof {shortAddress(node.executed.txHash, 8, 6)}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 17 17 7M9 7h8v8" />
                </svg>
              </a>
            ) : null}
          </div>
          {quote !== null ? (
            <div
              data-testid="swap-quote"
              style={{ marginTop: 4, fontSize: 11.5, color: "var(--fg-3)" }}
            >
              Expects about {stroopsToXlm(quote.expectedOut)} XLM, signs for at least{" "}
              {stroopsToXlm(quote.minOut)} XLM
              {quote.priceImpactBps !== null
                ? `, price impact ${(quote.priceImpactBps / 100).toFixed(2)}%`
                : ", price impact unknown"}
            </div>
          ) : null}
          {fee?.kind === "error" ? (
            <div
              data-testid="plan-row-fee-error"
              role="alert"
              style={{
                marginTop: 5,
                font: "500 11px/1.45 'Geist Mono', monospace",
                color: "var(--danger)",
                wordBreak: "break-word",
              }}
            >
              The fee for this step can&apos;t be read: {fee.message}
            </div>
          ) : null}
          {deferred ? (
            <div
              data-testid="deferred-note"
              style={{ marginTop: 5, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.45 }}
            >
              Built after{" "}
              {deferredAfter !== undefined && deferredAfter.length > 0
                ? deferredAfter.join(", ")
                : "the steps before it"}{" "}
              confirm{deferredAfter !== undefined && deferredAfter.length === 1 ? "s" : ""}, since
              it depends on what they leave behind. Its exact fee is known once it is built, and it
              is never signed above the fee shown.
            </div>
          ) : null}
          {node.error && !landed ? (
            <div
              data-testid="plan-row-error"
              style={{
                marginTop: 5,
                font: "500 11px/1.45 'Geist Mono', monospace",
                color: isSkipped ? "var(--warning)" : "var(--danger)",
                wordBreak: "break-word",
              }}
            >
              {node.error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type StepFee =
  // the figure is what the signed transaction authorizes: a real maximum
  | { readonly kind: "capped"; readonly typical: number }
  // nothing is built yet: only the most it can be signed for is known
  | { readonly kind: "unbuilt"; readonly max: number }
  // the usual fee, and the most the executor's surge bidding can reach
  | { readonly kind: "estimate"; readonly typical: number; readonly max: number }
  | { readonly kind: "error"; readonly message: string };

// a classic step and the forward are bid at the preview's fee and may be re-bid
// up to the executor's ceiling; a soroban step is re-simulated before signing and
// is never signed above its class's cap, which is all a step built at execute
// time has
function stepFee(node: PlanNode): StepFee {
  try {
    const max = nodeMaxFeeStroops(node);
    if (feeIsUnbuilt(node)) return { kind: "unbuilt", max };
    const typical = nodeFeeStroops(node);
    return max > typical ? { kind: "estimate", typical, max } : { kind: "capped", typical };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}
