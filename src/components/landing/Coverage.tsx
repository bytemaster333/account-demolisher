"use client";

// everything attached to an account that a close handles

import { HANDLES } from "./landing-data";

export function Coverage(): React.JSX.Element {
  return (
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
          Every entry discovered and sequenced, every DeFi call checked against a hardcoded
          allow-list before you sign.
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
          <div
            key={h.num}
            className="cov-flip"
            tabIndex={0}
            role="group"
            aria-label={`${h.tag}: ${h.label}`}
            style={{ height: 158 }}
          >
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
  );
}
