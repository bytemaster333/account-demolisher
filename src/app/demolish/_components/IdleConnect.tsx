"use client";

import { useState } from "react";

import { ConnectButton } from "@/components/wallet/ConnectButton";
import { CreateTestAccountButton } from "@/components/wallet/CreateTestAccountButton";
import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import type { NetworkConfig } from "@/lib/config/networks";
import type { WalletKitConnector } from "@/lib/wallet/connector";
import { isDemoNetwork } from "@/lib/wallet/demo-account";
import type { SecretKeyConnector } from "@/lib/wallet/secret-key";

export function IdleConnect({
  advancedOpen,
  onToggleAdvanced,
  network,
  onKitConnector,
  onSecretConnector,
}: {
  readonly advancedOpen: boolean;
  readonly onToggleAdvanced: () => void;
  readonly network: NetworkConfig;
  readonly onKitConnector: (c: WalletKitConnector | null) => void;
  readonly onSecretConnector: (c: SecretKeyConnector) => void;
}): React.JSX.Element {
  const isDemoNet = isDemoNetwork(network);
  const netLabel = network.id === "mainnet" ? "Mainnet" : "Testnet";
  // once demo setup starts it takes over the screen as a dedicated step. The
  // practice account exists only on testnet, so on any other network the connect
  // options show regardless (the demo card isn't there to take over).
  const [demoActive, setDemoActive] = useState(false);
  const demoTakesOver = demoActive && isDemoNet;
  return (
    <div style={{ maxWidth: 1080, margin: "8px auto 0" }}>
      {!demoTakesOver ? (
        <>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 11px",
              borderRadius: 999,
              border: "1px solid var(--border-2)",
              background: "transparent",
              marginBottom: 22,
            }}
          >
            <span
              style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }}
            />
            <span
              style={{
                font: "600 11px/1 Geist, sans-serif",
                color: "var(--fg-2)",
                letterSpacing: "0.04em",
                whiteSpace: "nowrap",
              }}
            >
              STEP 1 · CONNECT
            </span>
          </div>
          <h1
            style={{
              margin: 0,
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: "-0.03em",
              color: "var(--fg)",
            }}
          >
            Close a Stellar account
          </h1>
          <p
            style={{
              margin: "13px 0 30px",
              fontSize: 16,
              lineHeight: 1.55,
              color: "var(--fg-2)",
            }}
          >
            Connect the account you want to close. Closing it permanently removes the account from
            Stellar and sends all its XLM to an address you choose.{" "}
            <strong style={{ color: "var(--fg)", fontWeight: 600 }}>This cannot be undone.</strong>{" "}
            First we safely undo everything attached to it (trusted assets, open trades, saved data,
            extra signers, and DeFi positions). You review the whole plan first, and nothing is sent
            until you confirm it.
            {isDemoNet
              ? " New here? Create a free practice account below to try the whole thing first."
              : ""}
          </p>

          {/* primary: connect a real wallet */}
          <div
            style={{
              padding: 18,
              borderRadius: 13,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 420 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>
                Connect a wallet
              </span>
              <span style={{ fontSize: 12.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
                Works with Freighter, xBull, Albedo, Rabet, Lobstr, Hana, Ledger, WalletConnect, and
                more. Connecting only shares your public address, you approve each step in your
                wallet, and we never see your secret key.
              </span>
            </div>
            <ConnectButton network={network} onConnector={onKitConnector} />
          </div>

          {/* collapsed: legacy/advanced seed paste */}
          <div
            style={{
              marginTop: 14,
              border: "1px solid var(--border)",
              borderRadius: 13,
              overflow: "hidden",
              background: "var(--surface)",
            }}
          >
            <button
              type="button"
              onClick={onToggleAdvanced}
              aria-expanded={advancedOpen}
              aria-controls="advanced-secret-panel"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "15px 17px",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--fg)",
                textAlign: "left",
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                  Advanced: paste a secret key
                </span>
                <span style={{ fontSize: 11.5, color: "var(--fg-3)", fontWeight: 400 }}>
                  For advanced users without a wallet extension. Less safe.
                </span>
              </span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fg-3)"
                strokeWidth={2.2}
                strokeLinecap="round"
                style={{ transform: advancedOpen ? "rotate(180deg)" : "none" }}
                aria-hidden
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {advancedOpen ? (
              <div id="advanced-secret-panel" style={{ padding: "0 17px 17px" }}>
                <SecretKeyFallback onConnector={onSecretConnector} />
              </div>
            ) : null}
          </div>

          {/* testnet-only divider before the demo step */}
          {isDemoNet ? (
            <div
              style={{
                margin: "30px 0 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: "var(--fg-3)",
                fontSize: 11.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span>or explore on {netLabel} first</span>
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
          ) : null}
        </>
      ) : null}

      {/* demo setup, takes over as a dedicated step once it starts */}
      {isDemoNet ? (
        <CreateTestAccountButton
          network={network}
          onConnector={onSecretConnector}
          onActiveChange={setDemoActive}
        />
      ) : null}
    </div>
  );
}
