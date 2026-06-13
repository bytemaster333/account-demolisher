"use client";

// reusable live-progress list used by the demo-account flow

export type DemoStepRowStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface DemoStepRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly status: DemoStepRowStatus;
  readonly txHash?: string;
  readonly explorerTxUrl?: string;
  readonly detail?: string;
  readonly error?: string;
}

export function DemoStepList({
  rows,
}: {
  readonly rows: readonly DemoStepRow[];
}): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 13,
        boxShadow: "var(--shadow-sm)",
        padding: "4px 8px",
        display: "flex",
        flexDirection: "column",
      }}
      data-testid="demo-step-list"
    >
      {rows.map((row, i) => (
        <Row key={row.id} row={row} isLast={i === rows.length - 1} />
      ))}
    </div>
  );
}

function Row({ row, isLast }: { readonly row: DemoStepRow; readonly isLast: boolean }) {
  const isCompact = row.status === "done";

  if (isCompact) {
    return (
      <div
        data-testid={`demo-step-row-${row.id}`}
        data-status={row.status}
        style={{
          display: "grid",
          gridTemplateColumns: "30px minmax(0, 1fr) auto",
          alignItems: "center",
          gap: 10,
          padding: "7px 9px",
          borderBottom: isLast ? "none" : "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <StatusIndicator status={row.status} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg)",
              letterSpacing: "-0.005em",
              whiteSpace: "nowrap",
            }}
          >
            {row.label}
          </span>
          {row.detail !== undefined ? (
            <span
              style={{
                fontSize: 11.5,
                color: "var(--fg-3)",
                fontFamily: "'Geist Mono', ui-monospace, monospace",
                wordBreak: "break-all",
              }}
            >
              {row.detail}
            </span>
          ) : null}
        </div>
        {row.txHash !== undefined && row.explorerTxUrl !== undefined ? (
          <a
            href={row.explorerTxUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              fontSize: 11,
              color: "var(--fg-3)",
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              whiteSpace: "nowrap",
            }}
            title="View on stellar.expert"
          >
            <span>
              {row.txHash.slice(0, 6)}…{row.txHash.slice(-4)}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        ) : null}
      </div>
    );
  }

  // full layout for pending / active / failed / skipped — keeps the educational
  // description visible while the user is still watching steps run
  return (
    <div
      data-testid={`demo-step-row-${row.id}`}
      data-status={row.status}
      style={{
        display: "grid",
        gridTemplateColumns: "30px 1fr",
        gap: 12,
        padding: "10px 9px",
        borderBottom: isLast ? "none" : "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 1 }}>
        <StatusIndicator status={row.status} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color:
              row.status === "pending"
                ? "var(--fg-2)"
                : row.status === "failed"
                  ? "var(--danger)"
                  : "var(--fg)",
            letterSpacing: "-0.005em",
          }}
        >
          {row.label}
        </div>
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.45,
            color: "var(--fg-3)",
          }}
        >
          {row.description}
        </div>

        {row.detail !== undefined ? (
          <div
            style={{
              marginTop: 3,
              fontSize: 11.5,
              color: "var(--fg-2)",
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              wordBreak: "break-all",
            }}
          >
            {row.detail}
          </div>
        ) : null}

        {row.txHash !== undefined && row.explorerTxUrl !== undefined ? (
          <a
            href={row.explorerTxUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              marginTop: 2,
              alignSelf: "flex-start",
              fontSize: 11.5,
              color: "var(--fg-3)",
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span>
              tx {row.txHash.slice(0, 8)}…{row.txHash.slice(-6)}
            </span>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </a>
        ) : null}

        {row.error !== undefined ? (
          <div
            style={{
              marginTop: 3,
              fontSize: 11.5,
              color: row.status === "skipped" ? "var(--warning)" : "var(--danger)",
              fontFamily: "'Geist Mono', ui-monospace, monospace",
              wordBreak: "break-word",
            }}
          >
            {row.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { readonly status: DemoStepRowStatus }) {
  const baseStyle: React.CSSProperties = {
    width: 22,
    height: 22,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  };

  if (status === "active") {
    return (
      <span
        aria-label="In progress"
        style={{
          ...baseStyle,
          border: "2px solid var(--accent-soft)",
          borderTopColor: "var(--accent)",
          animation: "spin .8s linear infinite",
        }}
      />
    );
  }
  if (status === "done") {
    return (
      <span
        aria-label="Done"
        style={{
          ...baseStyle,
          background: "var(--success-soft)",
          color: "var(--success)",
          animation: "pop .35s ease-out",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12.5l4.5 4.5L19 7" />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-label="Failed"
        style={{
          ...baseStyle,
          background: "var(--danger-soft)",
          color: "var(--danger)",
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span
        aria-label="Skipped"
        style={{
          ...baseStyle,
          background: "var(--warning-soft)",
          color: "var(--warning)",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
    );
  }
  // pending
  return (
    <span
      aria-label="Pending"
      style={{
        ...baseStyle,
        border: "2px solid var(--border-2)",
      }}
    />
  );
}
