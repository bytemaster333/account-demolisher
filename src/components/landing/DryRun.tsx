"use client";

// the plan preview: everything is staged and simulated before any signature

import Link from "next/link";

import { DRY_STAGED } from "./landing-data";

export function DryRun(): React.JSX.Element {
  return (
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
            The full plan is built up front, with Soroban steps simulated. Nothing is submitted
            until you approve it.
          </p>
        </div>

        <div
          className="resp-stack"
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
                  5 TRANSACTIONS · DRY RUN
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
              Each transaction runs only after you approve it, in dependency order. Nothing runs
              before you do.
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
          className="resp-stack"
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
              <span style={{ fontWeight: 600, fontSize: 14 }}>Built up front</span>
              <span
                style={{
                  display: "block",
                  fontSize: 12.5,
                  color: "var(--fg-2)",
                  marginTop: 2,
                }}
              >
                Soroban fees from a live simulation, not estimates.
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
              <span style={{ fontWeight: 600, fontSize: 14 }}>No surprise signatures</span>
              <span
                style={{
                  display: "block",
                  fontSize: 12.5,
                  color: "var(--fg-2)",
                  marginTop: 2,
                }}
              >
                A wallet asks you for every transaction. A pasted key signs only after your typed
                confirmation.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
