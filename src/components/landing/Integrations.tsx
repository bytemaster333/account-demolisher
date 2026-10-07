"use client";

// the protocols and wallets the app works with

import { PROTOCOLS, type Wallet } from "./landing-data";

export function Integrations({
  wallets,
}: {
  readonly wallets: ReadonlyArray<Wallet>;
}): React.JSX.Element {
  return (
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
            Soroban DeFi positions unwound alongside classic assets, every DeFi protocol call on a
            hardcoded allow-list.
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
            className="resp-stack"
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
            className="resp-stack"
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
                {wallets.map((w) => (
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
  );
}
