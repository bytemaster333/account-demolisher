"use client";

// the standalone allowance viewer

import Link from "next/link";

export function AllowanceCallout(): React.JSX.Element {
  return (
    <section style={{ borderTop: "1px solid var(--border)" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "76px 28px" }}>
        <div
          className="resp-stack"
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
              Paste any G… or C… address and list the SEP-41 token allowances it set in the last 7
              days of on-chain events. Revoke them one by one or in a sweep from the wallet that
              owns the address. No closure required.
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
  );
}
