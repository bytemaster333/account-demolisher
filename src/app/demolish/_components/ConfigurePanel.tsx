"use client";

import { Button, InfoTip, Select } from "@/components/ui";
import { cexMemoTypes, type CexInfo, type CexMemoType } from "@/lib/safety/cex-registry";

import { SR_ONLY } from "../_lib/a11y";
import type { FormState } from "../_lib/form";

// the names the memo type picker below uses
const MEMO_TYPE_NAME: Record<CexMemoType, string> = {
  text: "Text",
  id: "ID",
  hash: "Hash",
  return: "Return",
};

const WARNING_BOX: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  marginTop: 13,
  padding: "11px 13px",
  borderRadius: 11,
  background: "var(--surface-2)",
  border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
};

function WarningIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--warning)"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, marginTop: 1 }}
    >
      <path d="M12 9v4M12 17h.01" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

const DEMO_DESTINATION_ADDRESS = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";

// the read-only account check that tells Configure whether this is a shared
// account. Continue waits for it: a shared account must be planned without
// market sells, and planning it as single-signer produces a request that fails.
export type PreflightView =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "error"; readonly message: string; readonly retry: () => void };

export function ConfigurePanel({
  form,
  setForm,
  cex,
  viaMediator,
  hasMemo,
  formError,
  canStart,
  startHint,
  onGeneratePlan,
  isDemo,
  deterministic,
  preflight,
  destinationInvalid = false,
}: {
  readonly form: FormState;
  readonly setForm: React.Dispatch<React.SetStateAction<FormState>>;
  readonly cex: CexInfo | null;
  // the close goes through the helper account: a registry exchange, or a
  // destination that flags itself memo-required under SEP-29
  readonly viaMediator: boolean;
  readonly hasMemo: boolean;
  readonly formError: string | null;
  readonly canStart: boolean;
  // why the Build button is disabled (bad/self destination); null = no note
  readonly startHint: string | null;
  readonly onGeneratePlan: () => void;
  readonly isDemo: boolean;
  // shared account: nothing is sold on the market
  readonly deterministic: boolean;
  readonly preflight: PreflightView;
  // the destination itself is malformed or the account's own address
  readonly destinationInvalid?: boolean;
}): React.JSX.Element {
  const hint =
    preflight.status === "loading"
      ? "Checking this account…"
      : preflight.status === "error"
        ? `We couldn't check this account: ${preflight.message}`
        : startHint;
  const startEnabled = canStart && preflight.status === "ready";
  const describedBy = [
    "demolish-destination-help",
    ...(hint !== null ? ["demolish-start-hint"] : []),
    ...(formError ? ["demolish-form-error"] : []),
  ].join(" ");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 22,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h2
          style={{
            margin: "0 0 4px",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--fg)",
          }}
        >
          Where should the funds go?
        </h2>
        <p
          style={{
            margin: "0 0 20px",
            fontSize: 13.5,
            color: "var(--fg-2)",
            lineHeight: 1.5,
          }}
        >
          {deterministic
            ? "On a shared account nothing is sold on the market: each other asset is returned to its issuer or sent to the destination, as you choose in a later step."
            : "Assets that have a market are swapped to XLM; anything else follows the choices you make in the next steps."}{" "}
          Then your whole XLM balance, including the small amount Stellar keeps locked in every
          account, is sent to the address below and this account is permanently closed.
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <label
            htmlFor="demolish-destination"
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: "var(--fg)",
            }}
          >
            Destination address
          </label>
          {isDemo ? (
            <button
              type="button"
              onClick={() => setForm((f) => ({ ...f, destination: DEMO_DESTINATION_ADDRESS }))}
              data-testid="use-demo-destination"
              title={`Use demo destination ${DEMO_DESTINATION_ADDRESS}`}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                padding: "5px 9px",
                borderRadius: 7,
                border: "1px solid var(--accent-line)",
                background: "var(--surface-2)",
                color: "var(--accent)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Use demo address
            </button>
          ) : null}
        </div>
        <input
          id="demolish-destination"
          type="text"
          value={form.destination}
          onChange={(e) => {
            // an address never contains spaces, so pasted padding is dropped here
            const v = e.currentTarget.value.trim();
            setForm((f) => ({ ...f, destination: v }));
          }}
          placeholder="G… wallet or exchange address"
          spellCheck={false}
          autoComplete="off"
          data-testid="destination-input"
          aria-describedby={describedBy}
          aria-invalid={formError !== null || destinationInvalid ? true : undefined}
          style={{
            width: "100%",
            padding: "13px 14px",
            borderRadius: 11,
            border: "1px solid var(--border-2)",
            background: "var(--surface-2)",
            color: "var(--fg)",
            font: "500 13px/1.3 'Geist Mono', monospace",
            boxSizing: "border-box",
          }}
        />
        <p
          id="demolish-destination-help"
          style={{ margin: "7px 0 0", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}
        >
          Paste the Stellar address (it starts with{" "}
          <strong style={{ color: "var(--fg-2)" }}>G</strong>) of the wallet or exchange account
          that should receive everything. Double-check it. Funds sent to the wrong address cannot be
          recovered.
        </p>

        {cex ? (
          <div data-testid="cex-warning" role="status" style={WARNING_BOX}>
            <WarningIcon />
            <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--fg)" }}>Exchange detected: {cex.name}.</strong>{" "}
              We&apos;ll route the transfer so your deposit memo reaches {cex.name} correctly.{" "}
              {cex.requiresMemo
                ? `${cex.name} needs a memo/tag (${cexMemoTypes(cex)
                    .map((t) => MEMO_TYPE_NAME[t])
                    .join(" or ")}), paste yours below, or your deposit could be lost.`
                : ""}
            </span>
          </div>
        ) : viaMediator ? (
          <div data-testid="memo-required-warning" role="status" style={WARNING_BOX}>
            <WarningIcon />
            <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--fg)" }}>This destination asks for a memo.</strong> It
              flags itself as memo-required (SEP-29), so we deliver through a helper account as a
              normal payment that carries your memo. Paste the memo below, or your deposit could be
              lost.
            </span>
          </div>
        ) : null}

        <div
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            margin: "18px 0 8px",
            color: "var(--fg)",
          }}
        >
          {/* text-only name for the memo input; the tooltip trigger beside it
              would otherwise end up in the input's accessible name */}
          <span id="demolish-memo-label" style={SR_ONLY}>
            Memo value
          </span>
          <InfoTip tip="A tag exchanges use to know a deposit is yours. Exchanges share one deposit address across all customers, so the memo is how they credit it to you.">
            Memo
          </InfoTip>{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
            {cex?.requiresMemo
              ? "· required by your exchange"
              : cex === null && viaMediator
                ? "· required by this destination"
                : "· required by most exchanges"}
          </span>
        </div>
        <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--fg-3)", lineHeight: 1.5 }}>
          If your exchange gave you a deposit memo or tag, paste it here. Sending to an exchange
          without it usually means the funds are lost. Most exchanges use Text or ID.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ minWidth: 130 }}>
            <Select
              value={form.memoType}
              onChange={(v) => setForm((f) => ({ ...f, memoType: v as FormState["memoType"] }))}
              ariaLabel="Memo type"
              data-testid="memo-type-select"
              options={[
                { value: "none", label: "None" },
                { value: "text", label: "Text" },
                { value: "id", label: "ID" },
                { value: "hash", label: "Hash" },
                { value: "return", label: "Return" },
              ]}
            />
          </div>
          <input
            type="text"
            id="demolish-memo-value"
            value={form.memoValue}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setForm((f) => ({ ...f, memoValue: v }));
            }}
            disabled={form.memoType === "none"}
            placeholder={
              cex?.requiresMemo
                ? "Required, your exchange deposit memo"
                : cex === null && viaMediator
                  ? "Required, the memo this destination asked for"
                  : form.memoType === "id"
                    ? "12345"
                    : "Your exchange deposit memo or tag"
            }
            spellCheck={false}
            autoComplete="off"
            data-testid="memo-value-input"
            aria-labelledby="demolish-memo-label"
            style={{
              flex: 1,
              padding: "13px 14px",
              borderRadius: 11,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              color: "var(--fg)",
              font: "500 13px/1.3 'Geist Mono', monospace",
              boxSizing: "border-box",
              opacity: form.memoType === "none" ? 0.55 : 1,
            }}
          />
        </div>

        {hasMemo ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              marginTop: 13,
              padding: "11px 13px",
              borderRadius: 11,
              background: "var(--surface-2)",
              border: "1px solid var(--accent-line)",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 16v-4M12 8h.01" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--fg)" }}>Memo added.</strong>{" "}
              {/* the memo only rides the closing transaction on a direct close;
                  a mediated close carries it on the helper account's payment */}
              {!viaMediator
                ? "It's attached to the transaction that closes the account, so your destination receives it alongside the funds. Nothing extra for you to do."
                : cex
                  ? "Exchanges don't credit an account merge, so we deliver through a helper account as a normal payment carrying your memo. Nothing extra for you to do."
                  : "This destination is memo-required, so instead of merging into it we deliver through a helper account as a normal payment carrying your memo. Nothing extra for you to do."}
            </span>
          </div>
        ) : null}

        {formError ? (
          <p
            role="alert"
            id="demolish-form-error"
            data-testid="form-error"
            style={{
              margin: "12px 0 0",
              fontSize: 12.5,
              color: "var(--danger)",
              fontWeight: 500,
            }}
          >
            {formError}
          </p>
        ) : null}

        {hint !== null ? (
          <p
            role="status"
            id="demolish-start-hint"
            data-testid="demolish-start-hint"
            style={{
              margin: "12px 0 0",
              fontSize: 12.5,
              color: "var(--warning)",
              lineHeight: 1.5,
            }}
          >
            {hint}
          </p>
        ) : null}
        {preflight.status === "error" ? (
          <div style={{ marginTop: 8 }}>
            <Button
              variant="secondary"
              onClick={preflight.retry}
              data-testid="preflight-check-retry"
            >
              Check the account again
            </Button>
          </div>
        ) : null}

        <div style={{ marginTop: hint !== null ? 10 : 20 }}>
          <Button
            variant="primary"
            size="lg"
            onClick={onGeneratePlan}
            disabled={!startEnabled}
            disabledReason={hint ?? "Connect an account and meet any signing threshold first"}
            data-testid="demolish-start"
            style={{ width: "100%" }}
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
            Continue, preview the plan
          </Button>
        </div>
      </div>
    </div>
  );
}
