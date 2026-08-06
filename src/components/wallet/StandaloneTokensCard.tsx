"use client";

import { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";

import { Button, Checkbox, Notice } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import type { HeldToken } from "@/lib/soroban/held-tokens";
import { getRpc } from "@/lib/soroban/rpc-client";
import { balance } from "@/lib/soroban/sep41";

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 5)}…${id.slice(-5)}` : id;
}

// Standalone SEP-41 tokens the account holds directly (custom tokens someone
// transferred to it). These live in each token contract's own storage, so unlike
// classic balances they DON'T block the merge — they'd be silently left behind on
// the deleted account. This card makes that explicit: it discloses the scan's
// horizon, lists what was found, and lets the user OPT IN (nothing is swept
// automatically) or add a token by contract id that the ~7-day scan couldn't see.
export function StandaloneTokensCard({
  discovered,
  unreadable,
  selected,
  onChange,
  network,
  userPublicKey,
  isCex,
  onRebuild,
  convertToXLM = false,
  onConvertToXLMChange,
}: {
  readonly discovered: readonly HeldToken[];
  readonly unreadable: readonly string[];
  readonly selected: readonly HeldToken[];
  readonly onChange: (next: readonly HeldToken[]) => void;
  readonly network: NetworkConfig;
  readonly userPublicKey: string | null;
  // a CEX/mediator close can't receive a raw contract token; selection is
  // disabled and the user is told to move them out manually instead.
  readonly isCex: boolean;
  readonly onRebuild: () => void;
  // opt-in: convert the selected tokens to XLM (Soroswap-router swap) instead of
  // transferring them as-is. Absent → the toggle is not shown.
  readonly convertToXLM?: boolean;
  readonly onConvertToXLMChange?: (value: boolean) => void;
}): React.JSX.Element {
  const [manualId, setManualId] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const isSelected = (id: string): boolean => selected.some((t) => t.contractId === id);
  // tokens the user added by contract id (selected but not in the scan results)
  const manual = selected.filter((t) => !discovered.some((d) => d.contractId === t.contractId));

  const toggle = (token: HeldToken, checked: boolean): void => {
    onChange(
      checked
        ? [...selected.filter((t) => t.contractId !== token.contractId), token]
        : selected.filter((t) => t.contractId !== token.contractId),
    );
  };

  const addManual = async (): Promise<void> => {
    const id = manualId.trim();
    setManualError(null);
    if (!StrKey.isValidContract(id)) {
      setManualError("That isn't a valid contract address (should start with C…).");
      return;
    }
    if (userPublicKey === null) {
      setManualError("Connect a wallet first.");
      return;
    }
    if (isSelected(id)) {
      setManualError("That token is already in the list.");
      return;
    }
    setProbing(true);
    try {
      const bal = await balance(getRpc(network), id, userPublicKey, userPublicKey, network);
      if (bal <= 0n) {
        setManualError("This account holds no balance of that token.");
        return;
      }
      onChange([...selected, { contractId: id, balance: bal }]);
      setManualId("");
    } catch {
      setManualError("Couldn't read a balance from that contract (it may be hostile or broken).");
    } finally {
      setProbing(false);
    }
  };

  const idLabel = (token: HeldToken, manualTag: boolean): React.JSX.Element => (
    <span style={{ fontFamily: "'Geist Mono', monospace", fontSize: 12.5, color: "var(--fg)" }}>
      {shortId(token.contractId)}
      {manualTag ? (
        <span style={{ color: "var(--fg-3)", marginLeft: 8, fontSize: 11 }}>added</span>
      ) : null}
    </span>
  );

  const row = (token: HeldToken, manualTag: boolean): React.JSX.Element => (
    <div
      key={token.contractId}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "10px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      {isCex ? (
        // read-only on a CEX close: selection is disabled (can't forward raw tokens)
        idLabel(token, manualTag)
      ) : (
        <Checkbox
          checked={isSelected(token.contractId)}
          onChange={(c) => toggle(token, c)}
          data-testid={`held-token-${token.contractId}`}
          label={idLabel(token, manualTag)}
        />
      )}
      <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontFamily: "'Geist Mono', monospace" }}>
        {token.balance.toString()} raw
      </span>
    </div>
  );

  const nothingFound = discovered.length === 0 && manual.length === 0 && unreadable.length === 0;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 22,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600, fontSize: 14.5, color: "var(--fg)" }}>
          Standalone tokens
        </span>
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
          OPT-IN
        </span>
      </div>

      <p style={{ margin: "8px 0 6px", fontSize: 13, lineHeight: 1.5, color: "var(--fg-2)" }}>
        Custom tokens someone sent to this account live inside each token&apos;s own contract, so —
        unlike normal balances — they don&apos;t block the close and would be{" "}
        <strong style={{ color: "var(--fg)" }}>left behind on the deleted account</strong> unless
        you move them. Nothing here is swept unless you tick it.
      </p>
      <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.5, color: "var(--fg-3)" }}>
        This scan only sees about the last 7 days of activity. If someone sent you a token before
        that, it won&apos;t appear — add it by contract address below.
      </p>

      {isCex ? (
        <Notice tone="warning" title="Closing to an exchange">
          An exchange can&apos;t receive these raw tokens, so they can&apos;t be swept as part of
          this close. Move any you want to keep to a personal wallet first.
        </Notice>
      ) : null}

      {discovered.map((t) => row(t, false))}
      {manual.map((t) => row(t, true))}

      {!isCex && onConvertToXLMChange && selected.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <Checkbox
            checked={convertToXLM}
            onChange={onConvertToXLMChange}
            data-testid="held-token-convert-toggle"
            label={
              <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
                Convert the selected token{selected.length === 1 ? "" : "s"} to XLM (Soroswap swap)
                instead of sending {selected.length === 1 ? "it" : "them"} as-is. Best-effort: a
                token with no Soroswap market is left as-is. Leave off to keep the exact token.
              </span>
            }
          />
        </div>
      ) : null}

      {unreadable.length > 0 ? (
        <p style={{ margin: "10px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--fg-3)" }}>
          {unreadable.length} token contract{unreadable.length === 1 ? "" : "s"} credited this
          account but couldn&apos;t be read (possibly hostile or broken).{" "}
          {unreadable.length === 1 ? "It" : "They"} can&apos;t be swept automatically.
        </p>
      ) : null}

      {nothingFound ? (
        <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--fg-3)" }}>
          No standalone tokens found in the scanned window.
        </p>
      ) : null}

      {!isCex ? (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <label
            style={{ fontSize: 12.5, color: "var(--fg-2)", display: "block", marginBottom: 6 }}
          >
            Add a token by contract address
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="C…"
              spellCheck={false}
              data-testid="held-token-manual-input"
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: "'Geist Mono', monospace",
                fontSize: 12.5,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--fg)",
              }}
            />
            <Button
              variant="secondary"
              onClick={() => void addManual()}
              loading={probing}
              disabled={probing || manualId.trim().length === 0}
            >
              Check &amp; add
            </Button>
          </div>
          {manualError ? (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--danger)" }}>{manualError}</div>
          ) : null}
        </div>
      ) : null}

      {!isCex && (discovered.length > 0 || manual.length > 0) ? (
        <div style={{ marginTop: 14 }}>
          <Button variant="secondary" onClick={onRebuild} data-testid="held-token-rebuild">
            {selected.length > 0
              ? `Rebuild plan to sweep ${selected.length} token${selected.length === 1 ? "" : "s"}`
              : "Rebuild plan (sweep none)"}
          </Button>
          <p style={{ margin: "8px 0 0", fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
            Ticked tokens are sent to your destination before the account closes. Rebuild to apply
            your choices; any left unticked stay behind.
          </p>
        </div>
      ) : null}
    </div>
  );
}
