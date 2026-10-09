"use client";

import {
  AddressActions,
  Badge,
  Button,
  Card,
  CopyableAddress,
  InfoTip,
  SectionLabel,
  StatGrid,
} from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl } from "@/lib/explorer";
import { hasHiddenCharacters, safeDisplay } from "@/lib/safe-display";
import type { BundleabilityResult } from "@/lib/multisig/signing-request";
import type { PlanNode, PreparePlan } from "@/lib/plan/tree";
import { EVENT_RETENTION_WINDOW_LEDGERS } from "@/lib/soroban/event-retention";
import type { AccountAudit, AssetIdentifier } from "@/lib/types/account";
import { pathKey, type ClassicMemo } from "@/lib/types/plan";

import { stroopsToXlm } from "../_lib/fees";
import {
  countTrustlines,
  nodePlainLabel,
  phasePlainLabel,
  planStepNumbers,
  runnableSteps,
  type PlanGroup,
} from "../_lib/plan-copy";
import { computeReviewMoney, reserveReleasedStroops, type ReviewMoney } from "../_lib/review-money";
import type { ClaimAtRisk } from "../_lib/signing-bundle";
import { PlanRow } from "./PlanRow";

const MEMO_TYPE_LABEL: Record<ClassicMemo["type"], string> = {
  text: "Text",
  id: "ID",
  hash: "Hash",
  return: "Return",
};

export interface SharedReview {
  // whether this close can be published as one signing request
  readonly gate: BundleabilityResult;
  // claimable balances whose claim may fail before co-signers finish
  readonly claimRisks: readonly ClaimAtRisk[];
  // rebuilds the plan without the at-risk claims, so the bundle only claims
  // balances that stay claimable for the whole signing window
  readonly onLeaveOutRisky?: () => void;
  readonly onCreate: () => void;
  readonly creating: boolean;
  readonly error: string | null;
  // present when the plan was built as single-signer (the account check hadn't
  // finished): rebuilds it as a shared-account close
  readonly onRebuildShared?: () => void;
}

// the Review step, the clean "here is what will happen": every step in the
// order it runs, the destination and memo, and the money figures. Cautions are
// acknowledged in the earlier steps; the final gate is the typed confirmation.
export function ReviewPanel({
  planGroups,
  audit,
  baseReserveStroops,
  destination,
  memo,
  useMediator,
  deterministic,
  network,
  blockers = [],
  prepareOnly,
  onBack,
  onDemolish,
  shared,
}: {
  readonly planGroups: readonly PlanGroup[];
  readonly audit: AccountAudit;
  // the network's base reserve from the latest ledger; null when it couldn't be read
  readonly baseReserveStroops: number | null;
  readonly destination: string;
  readonly memo: ClassicMemo | null;
  readonly useMediator: boolean;
  readonly deterministic: boolean;
  readonly network: NetworkConfig;
  // what keeps the close from starting; while any is listed nothing can be
  // confirmed or published
  readonly blockers?: readonly string[];
  // set when the plan can't merge yet: it only runs the steps that prepare it
  readonly prepareOnly?: PreparePlan;
  readonly onBack: () => void;
  readonly onDemolish: () => void;
  // present for a shared account: the close is published as a signing request
  // for the other signers instead of being run here
  readonly shared?: SharedReview;
}): React.JSX.Element {
  const required = destination.length >= 4 ? destination.slice(-4) : destination;
  const destHead = destination.length > 4 ? destination.slice(0, -4) : "";

  const ordered = planGroups.flatMap((g) => g.nodes);
  const numbers = planStepNumbers(planGroups);
  const { runnable, skipped } = runnableSteps(ordered);
  // a fee the page can't read leaves no honest floor to show, so the figures say
  // so and nothing can be confirmed
  let money: ReviewMoney | null = null;
  let moneyError: string | null = null;
  try {
    money = computeReviewMoney({ audit, ordered });
  } catch (err) {
    moneyError = errorMessage(err);
  }
  const reserve = reserveReleasedStroops(audit, baseReserveStroops);
  const atLeast =
    money === null
      ? "an amount that can't be worked out"
      : `at least ${stroopsToXlm(money.atLeastStroops)} XLM`;
  const labels = new Map(ordered.map((n) => [n.id, nodePlainLabel(n)]));
  const conversions = conversionsOf(ordered);
  const allBlockers =
    moneyError === null
      ? blockers
      : [
          ...blockers,
          `The network fees of this plan can't be read (${moneyError}). Rebuild the plan.`,
        ];
  const blocked = allBlockers.length > 0;
  const unlockDate = prepareOnly?.unlocksAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={{ marginBottom: 12 }}>
          <Badge tone="success" dot>
            PLAN READY
          </Badge>
        </div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          {prepareOnly ? "Review the preparation" : "Review before closing"}
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          {runnable} {runnable === 1 ? "step runs" : "steps run"} in order, numbered as they run.
          {prepareOnly
            ? " Each step is final once it lands on Stellar. This run does not close the account."
            : " Each step is final once it lands on Stellar; the account stays open until the last one deletes it."}{" "}
          Nothing happens until you confirm below.
        </p>
      </div>

      {prepareOnly ? (
        <div role="note" data-testid="review-prepare-only" style={noteStyle("warning")}>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            This run prepares the close; it doesn&apos;t delete the account.
          </strong>{" "}
          {prepareOnly.reason} Come back on or after {unlockDate} to finish.
        </div>
      ) : null}

      {blocked ? (
        <div role="alert" data-testid="review-blockers" style={noteStyle("danger")}>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            This close can&apos;t start yet.
          </strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {allBlockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <StatGrid
        stats={[
          {
            label: money?.spendsBalance
              ? "Destination receives, before repayments"
              : "Destination receives",
            value: money === null ? "can't be worked out" : atLeast,
            tone: "accent",
          },
          {
            label: "Network fees",
            value:
              money === null
                ? "can't be read"
                : money.unbuiltFeeSteps > 0
                  ? `about ${stroopsToXlm(money.typicalFeeStroops)} XLM plus ${
                      money.unbuiltFeeSteps === 1
                        ? "1 step priced when it is built"
                        : `${money.unbuiltFeeSteps} steps priced when they are built`
                    }, at most ${stroopsToXlm(money.maxFeeStroops)} XLM`
                  : `about ${stroopsToXlm(money.typicalFeeStroops)} XLM, at most ${stroopsToXlm(money.maxFeeStroops)} XLM`,
          },
          {
            label: "Reserve released (included)",
            value: reserve === null ? "couldn't load" : `${stroopsToXlm(reserve)} XLM`,
          },
        ]}
      />
      <div style={{ margin: "-6px 0 0", fontSize: 12, lineHeight: 1.55, color: "var(--fg-3)" }}>
        <p style={{ margin: 0 }}>
          The floor counts your XLM balance, the minimum each signed XLM conversion must return, and
          XLM pending payments, less the most the{" "}
          <InfoTip tip="A charge the Stellar network takes to process each step. It is not paid to us. The close bids more when the network is busy, up to the maximum shown.">
            network fees
          </InfoTip>{" "}
          can reach. The{" "}
          <InfoTip tip="XLM the network keeps locked in every account while it is open. It is released when the account closes, and is already part of your balance, not extra.">
            reserve
          </InfoTip>{" "}
          is already part of that balance.
        </p>
        {money !== null && money.notCounted.length > 0 ? (
          <div data-testid="review-not-counted" style={{ marginTop: 6 }}>
            Not counted in that figure:
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {money.notCounted.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {skipped.length > 0 ? (
        <div
          data-testid="review-skipped"
          role="note"
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--warning) 40%, transparent)",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--fg-2)",
          }}
        >
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            {skipped.length === 1 ? "1 step won't run" : `${skipped.length} steps won't run`}
          </strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {skipped.map((n) => (
              <li key={n.id}>
                {nodePlainLabel(n)}
                {n.error ? `: ${n.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* every step, in the order it runs */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden" }}>
        {planGroups.map((g, gi) => {
          // only the merge (and the delivery out of the helper account) delete or
          // empty the account for good; earlier steps are final on chain too, but
          // they leave the account open
          const irreversible = g.phase === "Merge" || g.phase === "Mediator forward";
          return (
            <div
              key={`${g.phase}-${gi}`}
              style={{ borderTop: gi > 0 ? "1px solid var(--border)" : undefined }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 14px 5px",
                }}
              >
                <SectionLabel>{phasePlainLabel(g.phase)}</SectionLabel>
                {irreversible ? (
                  <Badge tone="danger">Irreversible</Badge>
                ) : (
                  <Badge tone="neutral">Final on chain</Badge>
                )}
              </div>
              <div style={{ padding: "0 6px 6px" }}>
                {g.nodes.map((n) => (
                  <PlanRow
                    key={n.id}
                    node={n}
                    network={network}
                    mode="plan"
                    index={numbers.get(n.id) ?? 0}
                    deterministic={deterministic}
                    {...(n.deferred
                      ? {
                          deferredAfter: n.deferred.after.map((id) => labels.get(id) ?? id),
                        }
                      : {})}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {conversions.length > 0 ? (
        <div data-testid="review-conversions" style={noteStyle("neutral")}>
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>Conversions to XLM</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {conversions.map((c) => (
              <li key={c.key}>
                Sells {c.sendAmount} {c.code} for about{" "}
                {c.expected === null ? "an unknown amount of" : c.expected} XLM; the signed
                transaction refuses less than {c.destMin} XLM.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--fg-3)" }}>
        Token spending permissions are found from the network&apos;s recent approve events, about
        the last 7 days ({EVENT_RETENTION_WINDOW_LEDGERS.toLocaleString("en-US")} ledgers). A
        permission granted before that isn&apos;t seen, so it isn&apos;t revoked here.
      </p>

      {/* destination + memo + amount + account snapshot */}
      <div
        style={{
          borderRadius: 12,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--fg-3)", marginBottom: 6 }}>
            SENDING EVERYTHING TO
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={{ font: "600 13.5px/1.5 'Geist Mono', monospace", wordBreak: "break-all" }}>
              <span style={{ color: "var(--fg-2)" }}>{destHead}</span>
              <span
                style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "underline" }}
              >
                {required}
              </span>
            </div>
            <AddressActions
              value={destination}
              href={explorerAccountUrl(network, destination)}
              label="destination"
            />
          </div>
          <div
            data-testid="review-memo"
            style={{ marginTop: 9, fontSize: 13, color: "var(--fg-2)", wordBreak: "break-all" }}
          >
            {memo ? (
              <>
                Memo ({MEMO_TYPE_LABEL[memo.type]}):{" "}
                <span style={{ font: "600 13px 'Geist Mono', monospace", color: "var(--fg)" }}>
                  {safeDisplay(memo.value)}
                </span>
                {hasHiddenCharacters(memo.value) ? " (contains hidden characters)" : null}
                {useMediator ? ", applied on the delivery payment from the helper account" : ""}
              </>
            ) : (
              "No memo"
            )}
          </div>
          {prepareOnly ? (
            <div style={{ marginTop: 9, fontSize: 13, color: "var(--fg-2)" }}>
              Nothing is sent to this address in this run. The close that finishes later sends the
              balance here.
            </div>
          ) : (
            <div style={{ marginTop: 9, fontSize: 13, color: "var(--fg-2)" }}>
              Your balance is sent to this address and the account is permanently closed. The
              destination receives{" "}
              <span style={{ font: "600 13px 'Geist Mono', monospace", color: "var(--fg)" }}>
                {atLeast}
              </span>
              {money?.spendsBalance ? " before loan repayments" : ""} after network fees.
            </div>
          )}
          {useMediator && !prepareOnly ? (
            <div
              data-testid="review-merge-leg"
              style={{ marginTop: 9, fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5 }}
            >
              About 1 XLM (the temporary account&apos;s minimum balance, plus any unused part of the
              forward fee) reaches the exchange as an account merge, which most exchanges do not
              credit. The rest arrives as a payment with your deposit memo.
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 22,
            flexWrap: "wrap",
            alignItems: "flex-start",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span
              style={{
                fontSize: 10,
                color: "var(--fg-3)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              Account
            </span>
            <CopyableAddress
              value={audit.accountId}
              label="account"
              size={13}
              href={explorerAccountUrl(network, audit.accountId)}
            />
          </div>
          <SnapStat
            label="Subentries"
            value={audit.subentryCount}
            tip="Extra things attached to the account (trustlines, offers, saved data, signers). Each one locks a little XLM as a reserve; all of it is freed when the account closes."
          />
          <SnapStat
            label="Trustlines"
            value={countTrustlines(audit)}
            tip="Tokens the account is set up to hold, besides XLM. Each is emptied and removed as part of closing."
          />
          <SnapStat
            label="Offers"
            value={audit.offers.length}
            tip="Open buy/sell orders on Stellar's built-in exchange. They're cancelled before the account closes."
          />
          <SnapStat
            label="Data"
            value={audit.data.length}
            tip="Small key-value notes stored on the account. They're deleted as part of closing."
          />
          <SnapStat
            label="Claimable"
            value={audit.claimableBalances.length}
            tip="Payments set aside for this account that haven't been collected yet. The ones that can be collected now are claimed before closing; the Warnings step lists any that can't."
          />
        </div>
      </div>

      {shared ? (
        <SharedFooter shared={shared} onBack={onBack} blocked={blocked} />
      ) : (
        <>
          <div
            role="note"
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--danger)"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginTop: 1 }}
              aria-hidden
            >
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
            <span>
              This permanently deletes your Stellar account and sends all its XLM to the address
              above.{" "}
              <strong style={{ color: "var(--fg)", fontWeight: 600 }}>It cannot be undone.</strong>{" "}
              Double-check the address and memo before continuing.
            </span>
          </div>

          <div style={{ display: "flex", gap: 11 }}>
            <Button variant="secondary" onClick={onBack} data-testid="review-back">
              Back
            </Button>
            <Button
              variant="danger"
              onClick={onDemolish}
              disabled={blocked}
              disabledReason={blocked ? "Resolve what's listed above first" : undefined}
              data-testid="demolish-confirm"
              style={{ flex: 1 }}
              iconRight={
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              }
            >
              {prepareOnly
                ? "Continue to confirm the preparation"
                : "Continue to final confirmation"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function SharedFooter({
  shared,
  onBack,
  blocked,
}: {
  readonly shared: SharedReview;
  readonly onBack: () => void;
  readonly blocked: boolean;
}): React.JSX.Element {
  // a claim that expires inside the signing window, or one the bundle can't make
  // without a trustline, sinks the whole signed bundle on submit
  const sinking = shared.claimRisks.filter((r) => r.reason !== "reclaimable");
  if (!shared.gate.ok) {
    // a shared close that can't be one signing request can't be run here either:
    // this browser holds a single key, below the account's threshold
    return (
      <>
        <div
          role="note"
          data-testid="review-shared-blocked"
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
            fontSize: 13,
            lineHeight: 1.5,
            color: "var(--fg-2)",
          }}
        >
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            This shared account can&apos;t be closed with a signing request yet.
          </strong>{" "}
          {shared.gate.reason}
        </div>
        <div style={{ display: "flex", gap: 11 }}>
          <Button variant="secondary" onClick={onBack} data-testid="review-back">
            Back
          </Button>
          {shared.onRebuildShared ? (
            <Button
              onClick={shared.onRebuildShared}
              data-testid="review-rebuild-shared"
              style={{ flex: 1 }}
            >
              Rebuild as a shared-account close
            </Button>
          ) : null}
        </div>
      </>
    );
  }
  return (
    <>
      <div
        role="note"
        style={{
          display: "flex",
          gap: 10,
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid var(--border-2)",
          background: "var(--surface-2)",
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--fg-2)",
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-3)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginTop: 1 }}
          aria-hidden
        >
          <path d="M12 16v-4M12 8h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        <span>
          This packages the exact close above into one transaction and signs it with your key.
          Nothing is submitted yet, and{" "}
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            the account stays open until enough signers sign.
          </strong>{" "}
          You&apos;ll get a link to share, and collect the rest here.
        </span>
      </div>

      {shared.claimRisks.length > 0 ? (
        <div
          role="note"
          data-testid="review-claim-risks"
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
            fontSize: 12.5,
            lineHeight: 1.5,
            color: "var(--fg-2)",
          }}
        >
          Some pending payments in this close may fail to be collected when it is submitted, after
          every signer signed. If one fails, the whole close fails and a new request is needed:
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {shared.claimRisks.map((r) => (
              <li key={r.id}>
                {r.amount} {r.asset.kind === "credit" ? r.asset.code : "XLM"}:{" "}
                {r.reason === "expires"
                  ? "its claim window closes within the signing window"
                  : r.reason === "untrusted"
                    ? "this account doesn't trust that asset, so the claim is rejected"
                    : "the sender (or another claimant) can take it back first"}
              </li>
            ))}
          </ul>
          {shared.onLeaveOutRisky ? (
            <div style={{ marginTop: 8 }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={shared.onLeaveOutRisky}
                data-testid="review-leave-out-risky"
              >
                Leave these out and rebuild
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {shared.error !== null ? (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
          {shared.error}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: 11 }}>
        <Button variant="secondary" onClick={onBack} data-testid="review-back">
          Back
        </Button>
        <Button
          onClick={shared.onCreate}
          loading={shared.creating}
          disabled={shared.creating || blocked || sinking.length > 0}
          disabledReason={
            blocked
              ? "Resolve what's listed above first"
              : sinking.length > 0
                ? "Leave out the payments that can't be collected within the signing window first"
                : undefined
          }
          data-testid="review-create-request"
          style={{ flex: 1 }}
        >
          {shared.creating ? "Creating request…" : "Create signing request"}
        </Button>
      </div>
    </>
  );
}

function SnapStat({
  label,
  value,
  tip,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly tip?: string;
}): React.JSX.Element {
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: "var(--fg-3)",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontWeight: 600,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {tip ? (
        <InfoTip tip={tip}>
          <span style={labelStyle}>{label}</span>
        </InfoTip>
      ) : (
        <span style={labelStyle}>{label}</span>
      )}
      <span style={{ font: "600 14px/1 'Geist Mono', monospace", color: "var(--fg)" }}>
        {value}
      </span>
    </div>
  );
}

function noteStyle(tone: "warning" | "danger" | "neutral"): React.CSSProperties {
  return {
    padding: "12px 14px",
    borderRadius: 12,
    border:
      tone === "neutral"
        ? "1px solid var(--border)"
        : `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: "var(--fg-2)",
  };
}

interface Conversion {
  readonly key: string;
  readonly code: string;
  readonly sendAmount: string;
  // the full-size quote shown at review, null when the plan carries none
  readonly expected: string | null;
  // the floor the signed path payment enforces
  readonly destMin: string;
}

// the classic path payments the close signs, with the quote each was reviewed at
function conversionsOf(ordered: readonly PlanNode[]): readonly Conversion[] {
  const out: Conversion[] = [];
  for (const node of ordered) {
    if (node.kind !== "FinalClassicTx") continue;
    const quotes = node.metadata.reviewedConversionQuotes ?? {};
    for (const op of node.metadata.batches.flatMap((b) => b.operations)) {
      if (op.kind !== "path_payment_strict_send") continue;
      const asset = op.metadata["sendAsset"] as AssetIdentifier | undefined;
      if (asset?.kind !== "credit") continue;
      const key = pathKey(asset);
      out.push({
        key,
        code: asset.code,
        sendAmount: String(op.metadata["sendAmount"]),
        expected: quotes[key]?.destinationAmount ?? null,
        destMin: String(op.metadata["destMin"]),
      });
    }
  }
  return out;
}
