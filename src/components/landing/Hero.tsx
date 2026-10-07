"use client";

// the hero: what the app does, with a staged close as the preview

import Link from "next/link";

import { HERO_ROWS, HERO_PCT } from "./landing-data";

export function Hero(): React.JSX.Element {
  return (
    <section style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 28px" }}>
        <div
          className="resp-stack"
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
            <h1
              className="resp-hero-title"
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
              Unwind your DeFi positions, strip trustlines and signers, then merge what&apos;s left
              to a wallet or exchange, reserve and all.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, max-content)",
                gap: 12,
                marginTop: 36,
              }}
            >
              <Link
                href="/demolish"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gridColumn: "1 / -1",
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
              <a
                href="https://docs.demolisher.app"
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
              </a>
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
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.02c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
                </svg>
                View on GitHub
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
                  Non-custodial · keys stay local
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
              <span style={{ fontSize: 12, color: "var(--fg-3)" }}>example</span>
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
  );
}
