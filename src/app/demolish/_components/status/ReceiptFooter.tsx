"use client";

import Link from "next/link";

import { useCopyToClipboard } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import type { PreparePlan } from "@/lib/plan/tree";

import { SR_ONLY } from "../../_lib/a11y";
import type { PlanGroup } from "../../_lib/plan-copy";
import { buildReceiptText } from "../../_lib/receipt";
import { FOOTER_STYLE } from "./StatusFrame";
import type { DeliveredAmount } from "./types";

const BUTTON_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 16px",
  borderRadius: 10,
  border: "1px solid var(--border-2)",
  background: "var(--surface)",
  color: "var(--fg)",
  fontWeight: 600,
  fontSize: 13.5,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const PRIMARY_STYLE: React.CSSProperties = {
  flex: 1,
  height: 40,
  padding: "0 16px",
  borderRadius: 10,
  border: "1px solid var(--accent-line)",
  background: "transparent",
  color: "var(--accent)",
  fontWeight: 600,
  fontSize: 13.5,
  cursor: "pointer",
};

// the footer of a run that ended (closed, or prepared and still open): a
// plain-text receipt of an irreversible action. A closed account can't be
// looked up later, so when the clipboard is missing or blocked the text is
// shown for manual copy, and a download is always offered.
export function ReceiptFooter({
  kind,
  closedAccount,
  destination,
  delivered,
  network,
  mergeHash,
  planGroups,
  prepared,
  onPreparedDone,
}: {
  readonly kind: "succeeded" | "prepared";
  readonly closedAccount: string;
  readonly destination: string;
  readonly delivered: DeliveredAmount;
  readonly network: NetworkConfig;
  readonly mergeHash: string | null;
  readonly planGroups: readonly PlanGroup[];
  readonly prepared: PreparePlan | null;
  readonly onPreparedDone: (() => void) | undefined;
}): React.JSX.Element {
  const receiptText = buildReceiptText({
    closedAccount,
    destination,
    deliveredXlm: delivered.status === "ok" ? delivered.xlm : null,
    network,
    mergeHash,
    ordered: planGroups.flatMap((g) => g.nodes),
    ...(kind === "prepared" && prepared !== null ? { preparedUntil: prepared.unlocksAt } : {}),
  });
  // a blocked copy (permissions, an in-app browser) shows the text instead
  const receiptCopy = useCopyToClipboard(1600);
  const copyState = receiptCopy.state;
  const copyReceipt = (): Promise<void> => receiptCopy.copy(receiptText);
  const downloadReceipt = (): void => {
    const url = URL.createObjectURL(new Blob([receiptText], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind === "prepared" ? "close-prepared" : "account-closed"}-${closedAccount.slice(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const copied = copyState === "copied";

  return (
    <>
      <div style={FOOTER_STYLE}>
        <button
          type="button"
          onClick={() => void copyReceipt()}
          data-testid="demolish-copy-receipt"
          title="Copies a text record of this closure and its transaction links, keep it for your records, since a closed account can't be looked up later."
          style={{ ...BUTTON_STYLE, color: copied ? "var(--success)" : "var(--fg)" }}
        >
          {copied ? "Copied ✓" : "Copy a receipt"}
        </button>
        <button
          type="button"
          onClick={downloadReceipt}
          data-testid="demolish-download-receipt"
          style={BUTTON_STYLE}
        >
          Download .txt
        </button>
        {kind === "prepared" ? (
          <button
            type="button"
            onClick={onPreparedDone}
            data-testid="demolish-prepared-done"
            style={PRIMARY_STYLE}
          >
            Done
          </button>
        ) : (
          <Link
            href="/"
            data-testid="demolish-reset"
            style={{
              ...PRIMARY_STYLE,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Back to landing
          </Link>
        )}
      </div>

      <div style={{ background: "var(--bg-2)" }}>
        <p role="status" aria-live="polite" data-testid="demolish-copy-status" style={SR_ONLY}>
          {copyState === "copied"
            ? "Receipt copied to the clipboard."
            : copyState === "failed"
              ? "Copying isn't available here. The receipt text is shown below."
              : ""}
        </p>
        {copyState === "failed" ? (
          <div style={{ padding: "0 18px 16px" }}>
            <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--fg-2)" }}>
              Copying isn&apos;t available in this browser. Select the text below to copy it, or use
              Download .txt.
            </p>
            <textarea
              readOnly
              value={receiptText}
              data-testid="demolish-receipt-text"
              aria-label="Receipt text"
              rows={Math.min(12, receiptText.split("\n").length + 1)}
              onFocus={(e) => e.currentTarget.select()}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: 10,
                borderRadius: 9,
                border: "1px solid var(--border-2)",
                background: "var(--surface)",
                color: "var(--fg)",
                font: "500 11.5px/1.5 'Geist Mono', monospace",
              }}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
