"use client";

// landing page — ported from design/extracted/account demolisher.dc.html (lines 112–491)

import Link from "next/link";
import { useState } from "react";

import { AppShell } from "@/components/layout/AppShell";

type HeroRow = {
  readonly label: string;
  readonly statusText: string;
  readonly status: "done" | "active" | "queued";
};

type CapRow = {
  readonly n: string;
  readonly short: string;
  readonly desc: string;
  readonly exchange: boolean;
  readonly classic: boolean;
};

type Handle = {
  readonly num: string;
  readonly tag: string;
  readonly label: string;
  readonly desc: string;
};

type Step = {
  readonly num: string;
  readonly title: string;
  readonly body: string;
  readonly highlight: boolean;
};

type DryRow = {
  readonly label: string;
  readonly fee: string;
};

type SecurityRow = {
  readonly num: string;
  readonly title: string;
  readonly body: string;
  readonly icon: string;
};

type Protocol = {
  readonly initial: string;
  readonly name: string;
};

type Wallet = {
  readonly initial: string;
  readonly name: string;
};

type Faq = {
  readonly q: string;
  readonly a: string;
};

const HERO_ROWS: ReadonlyArray<HeroRow> = [
  { label: "Audit account state", statusText: "done", status: "done" },
  { label: "Withdraw Blend supplies", statusText: "done", status: "done" },
  { label: "Close Soroswap LP position", statusText: "signing", status: "active" },
  { label: "Sell trustline balances", statusText: "queued", status: "queued" },
  { label: "Remove trustlines", statusText: "queued", status: "queued" },
  { label: "Drop signers & data entries", statusText: "queued", status: "queued" },
  { label: "ACCOUNT_MERGE → destination", statusText: "queued", status: "queued" },
];

const HERO_PCT = 42;

const CAP_ROWS: ReadonlyArray<CapRow> = [
  {
    n: "01",
    short: "Move asset balances",
    desc: "Send tokens to a destination wallet or exchange.",
    exchange: true,
    classic: true,
  },
  {
    n: "02",
    short: "Remove trustlines",
    desc: "Zero balances and drop every issued-asset trustline.",
    exchange: false,
    classic: true,
  },
  {
    n: "03",
    short: "Cancel offers",
    desc: "Clear classic DEX offers blocking the merge.",
    exchange: false,
    classic: true,
  },
  {
    n: "04",
    short: "Unwind Soroban DeFi",
    desc: "Withdraw Blend, Aquarius, Soroswap, FxDAO positions.",
    exchange: false,
    classic: false,
  },
  {
    n: "05",
    short: "Revoke SEP-41 allowances",
    desc: "Set contract spend approvals back to zero.",
    exchange: false,
    classic: false,
  },
  {
    n: "06",
    short: "ACCOUNT_MERGE",
    desc: "Recover the base reserve and remove the ledger entry.",
    exchange: false,
    classic: false,
  },
];

const HANDLES: ReadonlyArray<Handle> = [
  {
    num: "01",
    tag: "CLASSIC",
    label: "DEX offers",
    desc: "Open buy and sell orders are cancelled so they stop reserving subentries.",
  },
  {
    num: "02",
    tag: "CLASSIC",
    label: "Trustlines",
    desc: "Issued-asset balances are routed out, then each trustline is removed.",
  },
  {
    num: "03",
    tag: "CLASSIC",
    label: "Data entries",
    desc: "Every account_data key is unset before the merge.",
  },
  {
    num: "04",
    tag: "CLASSIC",
    label: "Signers",
    desc: "Extra signers are stripped and thresholds reset to a clean single-signer state.",
  },
  {
    num: "05",
    tag: "CLASSIC",
    label: "Claimable balances",
    desc: "Pending claimable balances created or claimable by you are settled.",
  },
  {
    num: "06",
    tag: "SOROBAN",
    label: "Blend positions",
    desc: "Supplies and borrows on Blend pools are unwound before merge.",
  },
  {
    num: "07",
    tag: "SOROBAN",
    label: "Aquarius pools",
    desc: "AMM positions on Aquarius are exited back into the underlying assets.",
  },
  {
    num: "08",
    tag: "SOROBAN",
    label: "Soroswap LP",
    desc: "Liquidity is withdrawn from Soroswap pairs and routed back to you.",
  },
  {
    num: "09",
    tag: "SOROBAN",
    label: "FxDAO vaults",
    desc: "Open FxDAO vaults are closed so collateral can be merged out.",
  },
  {
    num: "10",
    tag: "SOROBAN",
    label: "SEP-41 allowances",
    desc: "Outstanding token allowances are zeroed before the account is dropped.",
  },
  {
    num: "11",
    tag: "RESERVE",
    label: "Subentry reserve",
    desc: "Every subentry is removed so the full base reserve is freed at merge.",
  },
  {
    num: "12",
    tag: "MERGE",
    label: "ACCOUNT_MERGE",
    desc: "What is left, native balance and base reserve, is merged to the destination.",
  },
];

const STEPS: ReadonlyArray<Step> = [
  {
    num: "01",
    title: "Connect",
    body: "Connect through Freighter, xBull, Albedo, Rabet, Lobstr, Hana, or WalletConnect. No keys leave your device.",
    highlight: false,
  },
  {
    num: "02",
    title: "Audit",
    body: "Every offer, trustline, data entry, signer, claimable balance, and Soroban position attached to the account is discovered.",
    highlight: false,
  },
  {
    num: "03",
    title: "Review & sign",
    body: "The full plan is simulated up front. You see real fees and real ops, then approve the whole envelope once.",
    highlight: true,
  },
  {
    num: "04",
    title: "Merge",
    body: "Transactions are submitted in dependency order. The account is merged and its base reserve is recovered.",
    highlight: false,
  },
];

const DRY_STAGED: ReadonlyArray<DryRow> = [
  { label: "Withdraw Blend USDC supply", fee: "0.00010" },
  { label: "Close Soroswap XLM/USDC LP", fee: "0.00012" },
  { label: "Sell trustline balances to XLM", fee: "0.00008" },
  { label: "Remove 3 trustlines and 2 signers", fee: "0.00006" },
  { label: "ACCOUNT_MERGE to destination", fee: "0.00005" },
];

const SECURITY: ReadonlyArray<SecurityRow> = [
  {
    num: "01",
    title: "Your keys never reach a server",
    body: "All signing happens in your wallet. The app code is open source and you can verify it before connecting.",
    icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  {
    num: "02",
    title: "Every contract is on a hardcoded allow-list",
    body: "Only known Blend, Aquarius, Soroswap, and FxDAO contracts are ever invoked, re-verified before each signature.",
    icon: "M9 11l3 3L22 4",
  },
  {
    num: "03",
    title: "Nothing is auto-signed",
    body: "The full plan is built and simulated up front. You approve the entire envelope once, with real fees displayed, never by surprise.",
    icon: "M7 11V7a5 5 0 0 1 10 0v4",
  },
  {
    num: "04",
    title: "No tracking, no telemetry",
    body: "The app does not phone home, does not log addresses, does not embed analytics. Apache-2.0, audit the source.",
    icon: "M1 1l22 22M9.9 9.9a3 3 0 0 0 4.2 4.2",
  },
];

const PROTOCOLS: ReadonlyArray<Protocol> = [
  { initial: "B", name: "Blend" },
  { initial: "A", name: "Aquarius" },
  { initial: "S", name: "Soroswap" },
  { initial: "F", name: "FxDAO" },
];

const WALLETS: ReadonlyArray<Wallet> = [
  { initial: "F", name: "Freighter" },
  { initial: "X", name: "xBull" },
  { initial: "A", name: "Albedo" },
  { initial: "R", name: "Rabet" },
  { initial: "L", name: "Lobstr" },
  { initial: "H", name: "Hana" },
  { initial: "W", name: "WalletConnect" },
];

const FAQS: ReadonlyArray<Faq> = [
  {
    q: "Why can't I just send my balances to an exchange and walk away?",
    a: "Exchanges accept the transfer, but they do not run ACCOUNT_MERGE. Your trustlines, signers, data entries, and the base reserve stay locked in a stranded account forever. Demolisher actually closes the account.",
  },
  {
    q: "Does the app ever see my secret key?",
    a: "No. The wallet integrations (Freighter, xBull, Albedo, Rabet, Lobstr, Hana, WalletConnect via stellar-wallets-kit) keep the key on your device. The secret-key fallback is a last-resort option, entered locally in your browser, never sent to a server.",
  },
  {
    q: "What is the mediator account and why does it exist?",
    a: "When merging to an exchange address that requires a memo, the mediator co-signs a strict two-operation forward envelope (payment, then merge) so funds arrive with the right memo. It never sees your key and cannot touch your account directly.",
  },
  {
    q: "Which Soroban DeFi protocols are supported?",
    a: "Blend, Aquarius, Soroswap, and FxDAO. Each integration calls only the hardcoded official contract addresses, re-verified before every signature.",
  },
  {
    q: "What is the allowance viewer?",
    a: "A standalone tool, at /allowances, that lists active SEP-41 token allowances for any account and lets you revoke them. Think of it as the Stellar analog of revoke.cash.",
  },
  {
    q: "Is it really open source?",
    a: "Yes. Apache-2.0 licensed, source on GitHub. No telemetry, no analytics, no remote configuration. Read the code and run it yourself.",
  },
];

export default function HomePage(): React.JSX.Element {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <AppShell>
      <main>
        {/* hero */}
        <section style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 28px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 0.82fr",
                gap: 64,
                alignItems: "center",
                minHeight: 580,
                padding: "84px 0",
              }}
            >
              <div>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 9,
                    marginBottom: 30,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "var(--accent)",
                    }}
                  />
                  <span style={{ fontSize: 13.5, color: "var(--fg-2)" }}>
                    Classic + Soroban DeFi, client-side signed
                  </span>
                </div>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 64,
                    lineHeight: 1.03,
                    fontWeight: 600,
                    letterSpacing: "-0.038em",
                    color: "var(--fg)",
                  }}
                >
                  Close a Stellar account, <span style={{ color: "var(--accent)" }}>cleanly.</span>
                </h1>
                <p
                  style={{
                    margin: "28px 0 0",
                    maxWidth: 440,
                    fontSize: 18,
                    lineHeight: 1.62,
                    color: "var(--fg-2)",
                  }}
                >
                  Unwind every DeFi position, strip trustlines and signers, then merge what&apos;s
                  left to a wallet or exchange, reserve and all.
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 12,
                    marginTop: 36,
                  }}
                >
                  <Link
                    href="/demolish"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "14px 22px",
                      background: "var(--accent)",
                      color: "var(--accent-fg)",
                      border: "none",
                      borderRadius: 11,
                      fontWeight: 600,
                      fontSize: 15,
                      cursor: "pointer",
                      textDecoration: "none",
                    }}
                  >
                    Demolish an account
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </Link>
                  <Link
                    href="/allowances"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "14px 20px",
                      background: "var(--surface)",
                      color: "var(--fg)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 11,
                      fontWeight: 600,
                      fontSize: 15,
                      cursor: "pointer",
                      textDecoration: "none",
                    }}
                  >
                    View allowances
                  </Link>
                  <a
                    href="https://github.com/bytemaster333/account-demolisher"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "14px 20px",
                      background: "var(--surface)",
                      color: "var(--fg)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 11,
                      fontWeight: 600,
                      fontSize: 15,
                      cursor: "pointer",
                      textDecoration: "none",
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.02c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
                    </svg>
                    View on GitHub
                  </a>
                </div>
                <div
                  style={{
                    display: "flex",
                    marginTop: 14,
                  }}
                >
                  <a
                    href="https://docs.demolisher.saliht.xyz"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "16px 24px",
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      border: "1px solid var(--accent-line)",
                      borderRadius: 12,
                      fontWeight: 600,
                      fontSize: 15.5,
                      cursor: "pointer",
                      textDecoration: "none",
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    </svg>
                    Read the docs
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
                  </a>
                </div>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "stretch",
                    flexWrap: "wrap",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    background: "var(--surface)",
                    marginTop: 40,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "12px 17px",
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--success)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
                    </svg>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                      Open source
                    </span>
                  </div>
                  <div style={{ width: 1, background: "var(--border)" }} />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "12px 17px",
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--success)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <path d="M9 12l2 2 4-4" />
                    </svg>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                      Client-side signing
                    </span>
                  </div>
                  <div style={{ width: 1, background: "var(--border)" }} />
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "12px 17px",
                    }}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--success)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M9.9 4.2A9 9 0 0 1 21 12a9.3 9.3 0 0 1-1.3 2.6M6.6 6.6A9 9 0 0 0 3 12c1.7 3.5 5 6 9 6a8.8 8.8 0 0 0 3.4-.7M1 1l22 22M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                    </svg>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                      No custody · no telemetry
                    </span>
                  </div>
                </div>
              </div>

              {/* RIGHT: plan preview */}
              <div
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 18,
                  boxShadow: "var(--shadow)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "18px 20px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 14, color: "var(--fg)" }}>
                    Demolition plan
                  </span>
                  <span style={{ fontSize: 12, color: "var(--fg-3)" }}>live preview</span>
                </div>
                <div style={{ padding: "10px 14px" }}>
                  {HERO_ROWS.map((r) => {
                    const labelColor = r.status === "queued" ? "var(--fg-3)" : "var(--fg)";
                    const statusColor =
                      r.status === "done"
                        ? "var(--success)"
                        : r.status === "active"
                          ? "var(--accent)"
                          : "var(--fg-3)";
                    return (
                      <div
                        key={r.label}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 13,
                          padding: "11px 6px",
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            width: 22,
                            height: 22,
                            display: "grid",
                            placeItems: "center",
                          }}
                        >
                          {r.status === "done" && (
                            <span
                              style={{
                                width: 22,
                                height: 22,
                                borderRadius: "50%",
                                background: "var(--success-soft)",
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
                                strokeWidth={3}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M20 6L9 17l-5-5" />
                              </svg>
                            </span>
                          )}
                          {r.status === "active" && (
                            <span
                              style={{
                                width: 22,
                                height: 22,
                                borderRadius: "50%",
                                border: "2px solid var(--accent-soft)",
                                borderTopColor: "var(--accent)",
                                animation: "spin .9s linear infinite",
                              }}
                            />
                          )}
                          {r.status === "queued" && (
                            <span
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: "50%",
                                border: "1.5px solid var(--border-2)",
                              }}
                            />
                          )}
                        </span>
                        <span
                          style={{
                            flex: 1,
                            fontSize: 13.5,
                            fontWeight: 500,
                            color: labelColor,
                          }}
                        >
                          {r.label}
                        </span>
                        <span style={{ fontSize: 12, color: statusColor }}>{r.statusText}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{ padding: "16px 20px 18px", borderTop: "1px solid var(--border)" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 9,
                    }}
                  >
                    <span style={{ fontSize: 12.5, color: "var(--fg-2)" }}>Reserve recovered</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--fg)" }}>
                      +1.0 XLM
                    </span>
                  </div>
                  <div
                    style={{
                      height: 5,
                      borderRadius: 999,
                      background: "var(--surface-3)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${HERO_PCT}%`,
                        borderRadius: 999,
                        background: "var(--accent)",
                        transition: "width .5s ease",
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* empty vs close framing */}
        <section
          style={{
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-2)",
          }}
        >
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "84px 28px" }}>
            <div style={{ maxWidth: 680, marginBottom: 44 }}>
              <div
                style={{
                  font: "600 12px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 13,
                }}
              >
                Why it&apos;s needed
              </div>
              <h2
                style={{
                  margin: "0 0 14px",
                  fontSize: 36,
                  fontWeight: 600,
                  letterSpacing: "-0.028em",
                  textWrap: "pretty",
                  lineHeight: 1.08,
                }}
              >
                Emptying an account isn&apos;t closing it
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 15.5,
                  lineHeight: 1.6,
                  color: "var(--fg-2)",
                }}
              >
                Other paths move your balances out, but can&apos;t run{" "}
                <span style={{ fontFamily: '"Geist Mono", monospace', fontSize: 13 }}>
                  ACCOUNT_MERGE
                </span>
                , so the account, and its reserve, stay frozen forever. Each gets a little further.
                Only one finishes.
              </p>
            </div>

            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 20,
                overflow: "hidden",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 116px 116px 140px",
                  alignItems: "stretch",
                }}
              >
                <div
                  style={{
                    padding: "20px 26px",
                    display: "flex",
                    alignItems: "flex-end",
                  }}
                >
                  <span
                    style={{
                      font: "600 11px/1 Geist, sans-serif",
                      color: "var(--fg-3)",
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                    }}
                  >
                    What closing an account takes
                  </span>
                </div>
                <div
                  style={{
                    padding: "18px 8px 14px",
                    textAlign: "center",
                    borderLeft: "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Exchange</div>
                  <div
                    style={{
                      font: '600 11px/1 "Geist Mono", monospace',
                      color: "var(--fg-3)",
                      marginTop: 4,
                    }}
                  >
                    1/6
                  </div>
                </div>
                <div
                  style={{
                    padding: "18px 8px 14px",
                    textAlign: "center",
                    borderLeft: "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Classic tools</div>
                  <div
                    style={{
                      font: '600 11px/1 "Geist Mono", monospace',
                      color: "var(--fg-3)",
                      marginTop: 4,
                    }}
                  >
                    3/6
                  </div>
                </div>
                <div
                  style={{
                    padding: "18px 8px 14px",
                    textAlign: "center",
                    borderLeft: "1px solid var(--border)",
                    background: "var(--surface-2)",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13, color: "var(--accent)" }}>
                    Demolisher
                  </div>
                  <div
                    style={{
                      font: '600 11px/1 "Geist Mono", monospace',
                      color: "var(--accent)",
                      marginTop: 4,
                    }}
                  >
                    6/6
                  </div>
                </div>
              </div>
              {CAP_ROWS.map((c) => (
                <div
                  key={c.n}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 116px 116px 140px",
                    alignItems: "center",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      padding: "14px 26px",
                      display: "flex",
                      gap: 14,
                      alignItems: "flex-start",
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border-2)",
                        display: "grid",
                        placeItems: "center",
                        font: '600 11px/1 "Geist Mono", monospace',
                        color: "var(--fg-3)",
                        marginTop: 1,
                      }}
                    >
                      {c.n}
                    </span>
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 14.5,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {c.short}
                      </div>
                      <div
                        style={{
                          fontSize: 12.5,
                          lineHeight: 1.45,
                          color: "var(--fg-2)",
                          marginTop: 3,
                        }}
                      >
                        {c.desc}
                      </div>
                    </div>
                  </div>
                  <CapCell on={c.exchange} />
                  <CapCell on={c.classic} />
                  <div
                    style={{
                      padding: "14px 8px",
                      display: "grid",
                      placeItems: "center",
                      borderLeft: "1px solid var(--border)",
                      background: "var(--surface-2)",
                      alignSelf: "stretch",
                    }}
                  >
                    <span
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        background: "var(--accent-soft)",
                        display: "grid",
                        placeItems: "center",
                      }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth={3}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* what it handles */}
        <section style={{ maxWidth: 1180, margin: "0 auto", padding: "76px 28px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 20,
              flexWrap: "wrap",
              marginBottom: 38,
            }}
          >
            <div>
              <div
                style={{
                  font: "600 12px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 13,
                }}
              >
                Coverage
              </div>
              <h2
                style={{
                  margin: 0,
                  fontSize: 34,
                  fontWeight: 600,
                  letterSpacing: "-0.025em",
                }}
              >
                Everything attached to an account
              </h2>
            </div>
            <p
              style={{
                margin: 0,
                maxWidth: 320,
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--fg-2)",
              }}
            >
              Every entry discovered, sequenced, and checked against a hardcoded allow-list before
              you sign.
            </p>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))",
              gap: 14,
            }}
          >
            {HANDLES.map((h) => (
              <div key={h.num} className="cov-flip" style={{ height: 158 }}>
                <div
                  className="cov-inner"
                  style={{
                    position: "relative",
                    width: "100%",
                    height: "100%",
                    willChange: "transform",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 16,
                      padding: 22,
                      display: "flex",
                      flexDirection: "column",
                      transform: "translateZ(0.01px)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span
                        style={{
                          font: '500 11px/1 "Geist Mono", monospace',
                          color: "var(--fg-3)",
                        }}
                      >
                        {h.num}
                      </span>
                      <span
                        style={{
                          font: "600 9.5px/1 Geist, sans-serif",
                          color: "var(--fg-3)",
                          letterSpacing: "0.07em",
                        }}
                      >
                        {h.tag}
                      </span>
                    </div>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 16.5,
                        letterSpacing: "-0.01em",
                        marginTop: "auto",
                      }}
                    >
                      {h.label}
                    </div>
                  </div>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                      transform: "rotateY(180deg)",
                      background: "var(--surface-2)",
                      border: "1px solid var(--border-2)",
                      borderRadius: 16,
                      padding: 22,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      style={{
                        font: "600 9.5px/1 Geist, sans-serif",
                        color: "var(--accent)",
                        letterSpacing: "0.07em",
                        marginBottom: 10,
                      }}
                    >
                      {h.label}
                    </div>
                    <div
                      style={{
                        fontSize: 13.5,
                        lineHeight: 1.55,
                        color: "var(--fg)",
                      }}
                    >
                      {h.desc}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* how it works */}
        <section
          style={{
            borderTop: "1px solid var(--border)",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-2)",
          }}
        >
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "76px 28px" }}>
            <div
              style={{
                font: "600 12px/1 Geist, sans-serif",
                color: "var(--accent)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: 13,
              }}
            >
              How it works
            </div>
            <h2
              style={{
                margin: "0 0 12px",
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: "-0.025em",
                maxWidth: 560,
              }}
            >
              You see every step before anything happens
            </h2>
            <p
              style={{
                margin: "0 0 60px",
                maxWidth: 460,
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--fg-2)",
              }}
            >
              Nothing is auto-signed. You review the full simulated plan, then approve, the step
              that separates this from a scam.
            </p>

            <div
              style={{
                position: "relative",
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 24,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 25,
                  height: 2,
                  background: "linear-gradient(90deg, var(--accent-line), var(--accent-line))",
                }}
              />
              {STEPS.map((s) => (
                <div
                  key={s.num}
                  style={{
                    position: "relative",
                    paddingRight: 18,
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      marginBottom: 24,
                    }}
                  >
                    {s.highlight ? (
                      <span
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          display: "grid",
                          placeItems: "center",
                          font: '600 19px/1 "Geist Mono", monospace',
                          color: "var(--accent-fg)",
                          boxShadow: "0 0 0 6px var(--accent-soft)",
                        }}
                      >
                        {s.num}
                      </span>
                    ) : (
                      <span
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: "50%",
                          background: "var(--surface)",
                          border: "2px solid var(--border-2)",
                          display: "grid",
                          placeItems: "center",
                          font: '600 19px/1 "Geist Mono", monospace',
                          color: "var(--fg-2)",
                        }}
                      >
                        {s.num}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 9,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 18,
                        letterSpacing: "-0.02em",
                      }}
                    >
                      {s.title}
                    </span>
                    {s.highlight && (
                      <span
                        style={{
                          font: '600 9px/1 "Geist Mono", monospace',
                          color: "var(--accent)",
                          letterSpacing: "0.07em",
                          padding: "4px 7px",
                          borderRadius: 5,
                          background: "var(--accent-soft)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        YOU APPROVE
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.55,
                      color: "var(--fg-2)",
                    }}
                  >
                    {s.body}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* dry-run showcase */}
        <section style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "84px 28px" }}>
            <div style={{ maxWidth: 640, marginBottom: 46 }}>
              <div
                style={{
                  font: "600 12px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 13,
                }}
              >
                The dry-run
              </div>
              <h2
                style={{
                  margin: "0 0 14px",
                  fontSize: 36,
                  fontWeight: 600,
                  letterSpacing: "-0.028em",
                  lineHeight: 1.08,
                  textWrap: "pretty",
                }}
              >
                Everything is staged behind your signature
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 15.5,
                  lineHeight: 1.6,
                  color: "var(--fg-2)",
                }}
              >
                The full plan is built and simulated up front. Nothing crosses the line until you
                sign, once.
              </p>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.3fr 0.9fr",
                alignItems: "stretch",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 18,
                overflow: "hidden",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "16px 22px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 14.5,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    Demolition plan
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "5px 11px",
                      borderRadius: 999,
                      background: "var(--accent-soft)",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--accent)",
                      }}
                    />
                    <span
                      style={{
                        font: '600 10px/1 "Geist Mono", monospace',
                        color: "var(--accent)",
                        letterSpacing: "0.05em",
                      }}
                    >
                      5 OPS · SIMULATED
                    </span>
                  </span>
                </div>
                <div style={{ padding: "10px 14px" }}>
                  {DRY_STAGED.map((d) => (
                    <div
                      key={d.label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 13,
                        padding: "11px 8px",
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 6,
                          background: "var(--accent-soft)",
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth={3}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </span>
                      <span style={{ flex: 1, fontWeight: 500, fontSize: 14 }}>{d.label}</span>
                      <span
                        style={{
                          font: '500 12px/1 "Geist Mono", monospace',
                          color: "var(--fg-3)",
                        }}
                      >
                        {d.fee} XLM
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  position: "relative",
                  borderLeft: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  padding: "32px 28px",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    width: 128,
                    height: 128,
                    display: "grid",
                    placeItems: "center",
                    marginBottom: 20,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      width: 116,
                      height: 116,
                      borderRadius: "50%",
                      border: "1.5px solid var(--accent-line)",
                      animation: "ringPulse 2.6s ease-out infinite",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      width: 116,
                      height: 116,
                      borderRadius: "50%",
                      border: "1.5px solid var(--accent-line)",
                      animation: "ringPulse 2.6s ease-out infinite 1.3s",
                    }}
                  />
                  <span
                    style={{
                      position: "relative",
                      width: 78,
                      height: 78,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      display: "grid",
                      placeItems: "center",
                      boxShadow: "0 10px 30px var(--accent-soft)",
                      animation: "keyFloat 3.2s ease-in-out infinite",
                    }}
                  >
                    <svg
                      width="35"
                      height="35"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--accent-fg)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{
                        animation: "keyTurn 3.4s ease-in-out infinite",
                        transformOrigin: "center",
                      }}
                    >
                      <circle cx="8" cy="8" r="5" />
                      <path d="M11.5 11.5 19 19M15 15l2-2M18 18l2-2" />
                    </svg>
                  </span>
                </div>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 22,
                    letterSpacing: "-0.02em",
                    color: "var(--fg)",
                    marginBottom: 9,
                  }}
                >
                  Held until you sign
                </div>
                <div
                  style={{
                    fontSize: 13.5,
                    lineHeight: 1.6,
                    color: "var(--fg-2)",
                    maxWidth: 240,
                  }}
                >
                  One approval releases all five transactions, in order. Nothing runs before you do.
                </div>
                <Link
                  href="/demolish"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    marginTop: 22,
                    padding: "12px 20px",
                    borderRadius: 11,
                    border: "none",
                    background: "var(--accent)",
                    color: "var(--accent-fg)",
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: "pointer",
                    boxShadow: "0 6px 18px var(--accent-soft)",
                    textDecoration: "none",
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                  Review &amp; sign
                </Link>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 24,
                marginTop: 26,
              }}
            >
              <div style={{ display: "flex", gap: 11 }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: 1 }}
                >
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Simulated up front</span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 12.5,
                      color: "var(--fg-2)",
                      marginTop: 2,
                    }}
                  >
                    Real fees and auth counts, not estimates.
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 11 }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: 1 }}
                >
                  <path d="M3 6h18M7 12h10M11 18h2" />
                </svg>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Dependency-ordered</span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 12.5,
                      color: "var(--fg-2)",
                      marginTop: 2,
                    }}
                  >
                    The exact sequence that will run, nothing hidden.
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 11 }}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: 1 }}
                >
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                </svg>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>Never auto-signs</span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 12.5,
                      color: "var(--fg-2)",
                      marginTop: 2,
                    }}
                  >
                    You approve the whole plan once, never by surprise.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* security guarantees */}
        <section style={{ maxWidth: 1180, margin: "0 auto", padding: "84px 28px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "0.82fr 1.18fr",
              gap: 56,
              alignItems: "start",
            }}
          >
            <div style={{ position: "sticky", top: 90 }}>
              <div
                style={{
                  font: "600 12px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 18,
                }}
              >
                Security
              </div>
              <div
                style={{
                  fontSize: 96,
                  lineHeight: 0.86,
                  fontWeight: 700,
                  letterSpacing: "-0.04em",
                  color: "transparent",
                  WebkitTextStroke: "1.5px var(--border-2)",
                  marginBottom: 22,
                }}
              >
                NEVER
              </div>
              <h2
                style={{
                  margin: "0 0 14px",
                  fontSize: 26,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.15,
                  maxWidth: 340,
                }}
              >
                Four hard promises a phishing site can&apos;t make
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  color: "var(--fg-2)",
                  maxWidth: 360,
                }}
              >
                A tool that drains accounts is a target by definition. These guarantees are enforced
                in code, not policy.
              </p>
            </div>

            <div>
              {SECURITY.map((row) => (
                <div
                  key={row.num}
                  className="never-row"
                  tabIndex={0}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr",
                    gap: 26,
                    alignItems: "start",
                    padding: "24px 8px 24px 18px",
                    borderTop: "1px solid var(--border)",
                    transition: "box-shadow .2s",
                    cursor: "default",
                    outline: "none",
                  }}
                >
                  <div
                    style={{
                      font: '700 40px/1 "Geist Mono", monospace',
                      color: "var(--border-2)",
                      letterSpacing: "-0.03em",
                    }}
                  >
                    {row.num}
                  </div>
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                      }}
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ flexShrink: 0 }}
                      >
                        <path d={row.icon} />
                      </svg>
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 19,
                          letterSpacing: "-0.015em",
                        }}
                      >
                        {row.title}
                      </span>
                    </div>
                    <div className="never-body">
                      <div>
                        <div
                          style={{
                            fontSize: 13.5,
                            lineHeight: 1.6,
                            color: "var(--fg-2)",
                            maxWidth: 560,
                            paddingTop: 9,
                          }}
                        >
                          {row.body}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: 26,
                  alignItems: "start",
                  padding: "28px 8px 4px 0",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <div
                  style={{
                    font: '700 40px/1 "Geist Mono", monospace',
                    color: "var(--accent)",
                    letterSpacing: "-0.03em",
                  }}
                >
                  *
                </div>
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      marginBottom: 8,
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 19,
                        letterSpacing: "-0.015em",
                      }}
                    >
                      One exception, by design
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 13.5,
                      lineHeight: 1.6,
                      color: "var(--fg-2)",
                      maxWidth: 560,
                    }}
                  >
                    The mediator account is the only server-held secret. It co-signs a strict
                    two-operation merge-payment envelope for exchange merges, and can never touch
                    your account directly or see your key.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* integrations */}
        <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "76px 28px" }}>
            <div style={{ maxWidth: 620, marginBottom: 36 }}>
              <div
                style={{
                  font: "600 12px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 13,
                }}
              >
                Coverage
              </div>
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: 34,
                  fontWeight: 600,
                  letterSpacing: "-0.025em",
                }}
              >
                Protocols and wallets it speaks to
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 15,
                  lineHeight: 1.55,
                  color: "var(--fg-2)",
                }}
              >
                Full Soroban parity with classic assets, every integration on a hardcoded
                allow-list.
              </p>
            </div>

            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 18,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "200px 1fr",
                  gap: 0,
                  alignItems: "center",
                  padding: "24px 28px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div>
                  <div
                    style={{
                      font: "600 11px/1 Geist, sans-serif",
                      color: "var(--fg-3)",
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      marginBottom: 5,
                    }}
                  >
                    Works with
                  </div>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 16,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    DeFi protocols
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {PROTOCOLS.map((p) => (
                    <div
                      key={p.name}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 11,
                        padding: "9px 16px 9px 9px",
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        background: "var(--surface-2)",
                      }}
                    >
                      <span
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          background: "var(--surface)",
                          border: "1px solid var(--accent-line)",
                          color: "var(--accent)",
                          display: "grid",
                          placeItems: "center",
                          fontWeight: 700,
                          fontSize: 14,
                        }}
                      >
                        {p.initial}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "200px 1fr",
                  gap: 0,
                  alignItems: "center",
                  padding: "24px 28px",
                }}
              >
                <div>
                  <div
                    style={{
                      font: "600 11px/1 Geist, sans-serif",
                      color: "var(--fg-3)",
                      letterSpacing: "0.07em",
                      textTransform: "uppercase",
                      marginBottom: 5,
                    }}
                  >
                    Connect via
                  </div>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 16,
                      letterSpacing: "-0.01em",
                    }}
                  >
                    Wallets
                  </div>
                </div>
                <div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
                    {WALLETS.map((w) => (
                      <div
                        key={w.name}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 9,
                          padding: "8px 14px 8px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 11,
                          background: "var(--surface-2)",
                        }}
                      >
                        <span
                          style={{
                            width: 27,
                            height: 27,
                            borderRadius: 7,
                            background: "var(--surface)",
                            border: "1px solid var(--border-2)",
                            color: "var(--fg)",
                            display: "grid",
                            placeItems: "center",
                            fontWeight: 700,
                            fontSize: 12,
                          }}
                        >
                          {w.initial}
                        </span>
                        <span
                          style={{
                            fontWeight: 500,
                            fontSize: 13,
                            color: "var(--fg)",
                          }}
                        >
                          {w.name}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div
                    style={{
                      marginTop: 14,
                      fontSize: 12.5,
                      color: "var(--fg-3)",
                      lineHeight: 1.5,
                    }}
                  >
                    + raw secret key as a last-resort fallback, entered locally, never persisted.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* allowance viewer call-out */}
        <section style={{ borderTop: "1px solid var(--border)" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "76px 28px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 56,
                alignItems: "center",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 18,
                padding: "44px 44px",
              }}
            >
              <div>
                <div
                  style={{
                    font: "600 12px/1 Geist, sans-serif",
                    color: "var(--accent)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    marginBottom: 13,
                  }}
                >
                  Allowance viewer
                </div>
                <h2
                  style={{
                    margin: "0 0 12px",
                    fontSize: 28,
                    fontWeight: 600,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.15,
                  }}
                >
                  Stellar&apos;s answer to revoke.cash
                </h2>
                <p
                  style={{
                    margin: "0 0 22px",
                    fontSize: 15,
                    lineHeight: 1.6,
                    color: "var(--fg-2)",
                    maxWidth: 440,
                  }}
                >
                  Paste any G… or C… address and list active SEP-41 token allowances. Revoke any of
                  them with a single signed call. No closure required.
                </p>
                <Link
                  href="/allowances"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "12px 18px",
                    background: "var(--surface-2)",
                    color: "var(--fg)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 10,
                    fontWeight: 600,
                    fontSize: 14,
                    textDecoration: "none",
                  }}
                >
                  Open allowance viewer
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
              </div>
              <div
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: 18,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {[
                  { spender: "soroswap router", asset: "USDC", amount: "unlimited" },
                  { spender: "blend pool v2", asset: "XLM", amount: "12,450.00" },
                  { spender: "aquarius amm", asset: "yXLM", amount: "unlimited" },
                ].map((r) => (
                  <div
                    key={r.spender}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                    }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        background: "var(--accent-soft)",
                        color: "var(--accent)",
                        display: "grid",
                        placeItems: "center",
                        fontWeight: 700,
                        fontSize: 12,
                      }}
                    >
                      {r.asset.slice(0, 1)}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{r.spender}</div>
                      <div
                        style={{
                          font: '500 11.5px/1 "Geist Mono", monospace',
                          color: "var(--fg-3)",
                          marginTop: 3,
                        }}
                      >
                        {r.asset} · {r.amount}
                      </div>
                    </div>
                    <span
                      style={{
                        font: '600 10px/1 "Geist Mono", monospace',
                        color: "var(--danger)",
                        letterSpacing: "0.05em",
                        padding: "5px 9px",
                        borderRadius: 6,
                        background: "var(--danger-soft)",
                      }}
                    >
                      REVOKE
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
          <div
            style={{
              maxWidth: 1180,
              margin: "0 auto",
              padding: "76px 28px",
              display: "grid",
              gridTemplateColumns: "0.78fr 1fr",
              gap: 56,
              alignItems: "start",
            }}
          >
            <div style={{ position: "sticky", top: 90 }}>
              <div
                style={{
                  font: "600 12px/1 Geist, sans-serif",
                  color: "var(--accent)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 13,
                }}
              >
                Questions &amp; objections
              </div>
              <h2
                style={{
                  margin: "0 0 14px",
                  fontSize: 34,
                  fontWeight: 600,
                  letterSpacing: "-0.025em",
                  textWrap: "pretty",
                }}
              >
                The honest answers, before you connect
              </h2>
              <p
                style={{
                  margin: "0 0 22px",
                  fontSize: 15,
                  lineHeight: 1.6,
                  color: "var(--fg-2)",
                }}
              >
                A tool that drains accounts should expect skepticism. Here&apos;s exactly how it
                works, and what it can&apos;t do.
              </p>
              <a
                href="https://github.com/bytemaster333/account-demolisher#readme"
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontWeight: 600,
                  fontSize: 14,
                  color: "var(--accent)",
                  textDecoration: "none",
                }}
              >
                Read the security docs
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </a>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {FAQS.map((f, i) => {
                const isOpen = openFaq === i;
                return (
                  <div
                    key={f.q}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 14,
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaq(isOpen ? null : i)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                        padding: "19px 22px",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                        color: "var(--fg)",
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 15.5,
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {f.q}
                      </span>
                      <span
                        style={{
                          flexShrink: 0,
                          width: 26,
                          height: 26,
                          borderRadius: 7,
                          border: "1px solid var(--border)",
                          display: "grid",
                          placeItems: "center",
                          color: "var(--fg-3)",
                          transition:
                            "transform .3s cubic-bezier(.4,0,.2,1), color .2s, border-color .2s",
                          transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.4}
                          strokeLinecap="round"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                      </span>
                    </button>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateRows: isOpen ? "1fr" : "0fr",
                        transition: "grid-template-rows .3s cubic-bezier(.4,0,.2,1)",
                      }}
                    >
                      <div style={{ overflow: "hidden", minHeight: 0 }}>
                        <div
                          style={{
                            padding: "0 22px 21px",
                            fontSize: 14,
                            lineHeight: 1.65,
                            color: "var(--fg-2)",
                            maxWidth: 620,
                          }}
                        >
                          {f.a}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function CapCell({ on }: { readonly on: boolean }): React.JSX.Element {
  return (
    <div
      style={{
        padding: "14px 8px",
        display: "grid",
        placeItems: "center",
        borderLeft: "1px solid var(--border)",
        alignSelf: "stretch",
      }}
    >
      {on ? (
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "var(--surface-2)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </span>
      ) : (
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--border-2)"
          strokeWidth={2.4}
          strokeLinecap="round"
        >
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      )}
    </div>
  );
}
