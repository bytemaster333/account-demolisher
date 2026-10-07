"use client";

// the security guarantees, each one checked against the code

import { SECURITY } from "./landing-data";

export function Security(): React.JSX.Element {
  return (
    <section style={{ maxWidth: 1180, margin: "0 auto", padding: "84px 28px" }}>
      <div
        className="resp-stack"
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
            A tool that drains accounts is a target by definition. These guarantees are enforced in
            code, not policy. It has not yet completed an independent security audit, so treat
            mainnet use accordingly.
          </p>
        </div>

        <div>
          {SECURITY.map((row) => (
            <div
              key={row.num}
              className="never-row"
              tabIndex={0}
              role="group"
              aria-label={row.title}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr",
                gap: 26,
                alignItems: "start",
                padding: "24px 8px 24px 18px",
                borderTop: "1px solid var(--border)",
                transition: "box-shadow .2s",
                cursor: "default",
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
                The mediator account is the only server-held signing secret. It signs a strict
                two-operation forward envelope (a payment, then a merge) for exchange merges, and
                can never touch your account directly or see your key.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
