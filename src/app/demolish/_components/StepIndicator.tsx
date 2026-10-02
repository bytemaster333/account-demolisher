"use client";

import { SR_ONLY } from "../_lib/a11y";
import type { FlowStep } from "../_lib/flow-steps";

export function StepIndicator({
  steps,
}: {
  readonly steps: readonly FlowStep[];
}): React.JSX.Element {
  return (
    <nav aria-label="Progress">
      <ol
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          flexWrap: "wrap",
          listStyle: "none",
          padding: 0,
          margin: "0 0 26px",
        }}
      >
        {steps.map((st) => (
          <li
            key={st.num}
            aria-current={st.isActive ? "step" : undefined}
            style={{ display: "flex", alignItems: "center", gap: 10 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "7px 13px 7px 8px",
                borderRadius: 999,
                border: st.isActive ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: "transparent",
              }}
            >
              {st.isDone ? (
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    border: "1px solid var(--success)",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <svg
                    width="11"
                    height="11"
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
              ) : null}
              {st.isActive ? (
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    border: "1px solid var(--accent)",
                    color: "var(--accent)",
                    display: "grid",
                    placeItems: "center",
                    font: "600 10px/1 Geist, sans-serif",
                  }}
                >
                  {st.num}
                </span>
              ) : null}
              {st.isTodo ? (
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    border: "1.5px solid var(--border-2)",
                    color: "var(--fg-3)",
                    display: "grid",
                    placeItems: "center",
                    font: "600 10px/1 Geist, sans-serif",
                  }}
                >
                  {st.num}
                </span>
              ) : null}
              <span style={{ fontWeight: 600, fontSize: 13, color: "var(--fg)" }}>
                <span style={SR_ONLY}>
                  {st.isDone
                    ? "Completed step: "
                    : st.isActive
                      ? "Current step: "
                      : "Upcoming step: "}
                </span>
                {st.label}
              </span>
            </div>
            {st.notLast ? (
              <span aria-hidden style={{ width: 18, height: 1, background: "var(--border-2)" }} />
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
