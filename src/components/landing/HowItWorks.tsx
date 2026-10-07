"use client";

// the four steps of a close

import { type Step } from "./landing-data";

export function HowItWorks({ steps }: { readonly steps: ReadonlyArray<Step> }): React.JSX.Element {
  return (
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
          No surprise signatures. You review the full plan, then approve, the step that separates
          this from a scam.
        </p>

        <div
          className="resp-stack"
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
          {steps.map((s) => (
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
  );
}
