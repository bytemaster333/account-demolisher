"use client";

// why emptying an account is not closing it, and what each path covers

import { CAP_ROWS } from "./landing-data";

export function Framing(): React.JSX.Element {
  return (
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
            , so the account and its reserve stay locked until it is merged. Each gets a little
            further. Only one finishes.
          </p>
        </div>

        {/* on mobile this fixed-width table scrolls inside its own box
            instead of overflowing the page (see .resp-scroll-x) */}
        <div className="resp-scroll-x">
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 20,
              overflow: "hidden",
              boxShadow: "var(--shadow-sm)",
              minWidth: 460,
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
      </div>
    </section>
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
