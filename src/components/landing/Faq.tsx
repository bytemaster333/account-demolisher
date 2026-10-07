"use client";

// frequently asked questions, one open at a time

import { useState } from "react";

import { type FaqEntry } from "./landing-data";

export function Faq({ faqs }: { readonly faqs: ReadonlyArray<FaqEntry> }): React.JSX.Element {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  return (
    <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
      <div
        className="resp-stack"
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
            A tool that drains accounts should expect skepticism. Here&apos;s exactly how it works,
            and what it can&apos;t do.
          </p>
          <a
            href="https://docs.demolisher.app/docs/developers/security/model"
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
          {faqs.map((f, i) => {
            const isOpen = openFaq === i;
            const answerId = `faq-${i}`;
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
                  aria-expanded={isOpen}
                  aria-controls={answerId}
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
                  id={answerId}
                  inert={!isOpen}
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
  );
}
