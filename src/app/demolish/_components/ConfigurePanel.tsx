"use client";

import { Button, Checkbox, InfoTip, Select } from "@/components/ui";
import type { CexInfo } from "@/lib/safety/cex-registry";
import type { AccountAudit } from "@/lib/types/account";

import type { FormState } from "../_lib/form";

const DEMO_DESTINATION_ADDRESS = "GCAWLISZMTHWMMHJE7BRYYNNKR4OL2PR4COXKH2MKGVDOH4BP6DMAHPE";

export function ConfigurePanel({
  form,
  setForm,
  cex,
  hasMemo,
  formError,
  isBusy,
  canStart,
  startHint,
  onGeneratePlan,
  audit,
  isDemo,
}: {
  readonly form: FormState;
  readonly setForm: React.Dispatch<React.SetStateAction<FormState>>;
  readonly cex: CexInfo | null;
  readonly hasMemo: boolean;
  readonly formError: string | null;
  readonly isBusy: boolean;
  readonly canStart: boolean;
  // why the Build button is disabled (bad/self destination); null = no note
  readonly startHint: string | null;
  readonly onGeneratePlan: () => void;
  readonly audit: AccountAudit | null;
  readonly isDemo: boolean;
}): React.JSX.Element {
  const claimables = audit?.claimableBalances ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {claimables.length > 0 ? (
        <div
          data-testid="claimable-balance-list"
          style={{
            border: "1px solid var(--border)",
            background: "var(--surface)",
            borderRadius: 14,
            padding: "18px 20px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: "var(--surface-2)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--warning)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                </svg>
              </span>
              <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--fg)" }}>
                Payments waiting to be collected
              </span>
            </div>
            <span
              style={{
                font: "600 9.5px/1 Geist, sans-serif",
                color: "var(--fg-3)",
                letterSpacing: "0.07em",
                padding: "5px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                whiteSpace: "nowrap",
              }}
            >
              AUTO-COLLECTED
            </span>
          </div>
          <p
            style={{
              margin: "0 0 6px",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            These are payments set aside for this account that you haven&apos;t collected yet. We
            collect all of them into your balance automatically before closing.{" "}
            <strong style={{ color: "var(--fg)" }}>You don&apos;t need to do anything.</strong>{" "}
            Untick any you&apos;d rather leave behind; unticked ones are lost when the account
            closes.
          </p>
          {claimables.map((cb) => {
            const checked = form.selectedCbIds.includes(cb.id);
            return (
              <div
                key={cb.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 0",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <Checkbox
                  checked={checked}
                  onChange={(c) => {
                    setForm((f) =>
                      c
                        ? { ...f, selectedCbIds: [...f.selectedCbIds, cb.id] }
                        : {
                            ...f,
                            selectedCbIds: f.selectedCbIds.filter((id) => id !== cb.id),
                          },
                    );
                  }}
                  data-testid={`cb-checkbox-${cb.id}`}
                  label={
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 13,
                        fontFamily: "'Geist Mono', monospace",
                        color: "var(--fg)",
                      }}
                    >
                      {cb.amount}
                    </span>
                  }
                />
                <span
                  style={{
                    fontSize: 11.5,
                    color: "var(--fg-3)",
                    fontFamily: "'Geist Mono', monospace",
                  }}
                >
                  {cb.id.slice(0, 16)}…
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

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
          Every other asset in this account is swapped to XLM, then your whole XLM balance,
          including the small amount Stellar keeps locked in every account, is sent to the address
          below and this account is permanently closed.
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
            const v = e.currentTarget.value;
            setForm((f) => ({ ...f, destination: v }));
          }}
          placeholder="G… wallet or exchange address"
          spellCheck={false}
          autoComplete="off"
          data-testid="destination-input"
          aria-describedby="demolish-destination-help"
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
          <div
            data-testid="cex-warning"
            role="status"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 9,
              marginTop: 13,
              padding: "11px 13px",
              borderRadius: 11,
              background: "var(--surface-2)",
              border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
            }}
          >
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
            <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.45 }}>
              <strong style={{ color: "var(--fg)" }}>Exchange detected: {cex.name}.</strong>{" "}
              We&apos;ll route the transfer so your deposit memo reaches {cex.name} correctly.{" "}
              {cex.requiresMemo
                ? `${cex.name} needs a ${cex.memoType ?? "text"} memo/tag, paste yours below, or your deposit could be lost.`
                : ""}
            </span>
          </div>
        ) : null}

        <div
          id="demolish-memo-label"
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            margin: "18px 0 8px",
            color: "var(--fg)",
          }}
        >
          <InfoTip tip="A tag exchanges use to know a deposit is yours. Exchanges share one deposit address across all customers, so the memo is how they credit it to you.">
            Memo
          </InfoTip>{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>
            {cex?.requiresMemo ? "· required by your exchange" : "· required by most exchanges"}
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
              {cex
                ? "Because a plain account close-out can't carry a memo, we hop the funds through a temporary helper account so your exchange still sees the memo and credits your deposit. Nothing extra for you to do."
                : "It's attached directly to the closing transaction, so your destination receives it alongside the funds. Nothing extra for you to do."}
            </span>
          </div>
        ) : null}

        <label
          htmlFor="demolish-fallback"
          style={{
            display: "block",
            fontWeight: 600,
            fontSize: 13,
            margin: "18px 0 8px",
            color: "var(--fg)",
          }}
        >
          <InfoTip tip="A safety net: in the rare case an exchange transfer can't be delivered, your funds go here instead of getting stuck. Leave blank to use the destination above. If you're sending to an exchange, consider your own personal wallet here.">
            Backup address
          </InfoTip>{" "}
          <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>· optional</span>
        </label>
        <input
          id="demolish-fallback"
          type="text"
          value={form.fallback}
          onChange={(e) => {
            const v = e.currentTarget.value;
            setForm((f) => ({ ...f, fallback: v }));
          }}
          placeholder="G… (defaults to the destination above)"
          spellCheck={false}
          autoComplete="off"
          data-testid="fallback-input"
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

        {formError ? (
          <p
            role="alert"
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

        {startHint !== null && !isBusy ? (
          <p
            role="status"
            data-testid="demolish-start-hint"
            style={{
              margin: "12px 0 0",
              fontSize: 12.5,
              color: "var(--warning)",
              lineHeight: 1.5,
            }}
          >
            {startHint}
          </p>
        ) : null}

        <div style={{ marginTop: startHint !== null && !isBusy ? 10 : 20 }}>
          <Button
            variant="primary"
            size="lg"
            onClick={onGeneratePlan}
            disabled={!canStart || isBusy}
            loading={isBusy}
            disabledReason={startHint ?? "Connect an account and meet any signing threshold first"}
            data-testid="demolish-start"
            style={{ width: "100%" }}
            iconRight={
              isBusy ? undefined : (
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
              )
            }
          >
            {isBusy ? "Checking your account…" : "Continue, preview the plan"}
          </Button>
        </div>
      </div>
    </div>
  );
}
