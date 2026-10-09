"use client";

import { EVENT_RETENTION_WINDOW_LEDGERS } from "@/lib/soroban/event-retention";

// what the header says once a run is over, whether it ended or failed: the
// best-effort steps that fell short, and how far back allowances were looked for
export function RunNotes({
  executionNotes,
}: {
  readonly executionNotes: readonly string[];
}): React.JSX.Element {
  return (
    <>
      {executionNotes.length > 0 ? (
        <div
          role="note"
          data-testid="execution-notes"
          style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-2)" }}
        >
          <strong style={{ color: "var(--fg)", fontWeight: 600 }}>
            Not everything went as planned:
          </strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {executionNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-3)" }}>
        Token spending permissions were looked for in about the last 7 days of approve events (
        {EVENT_RETENTION_WINDOW_LEDGERS.toLocaleString("en-US")} ledgers); an older one was not
        seen.
      </p>
    </>
  );
}
