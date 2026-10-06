"use client";

// links into the documentation

export function Docs(): React.JSX.Element {
  return (
    <section
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "84px 28px",
        }}
      >
        <div style={{ maxWidth: 720, marginBottom: 44 }}>
          <div
            style={{
              font: "600 12px/1 Geist, sans-serif",
              color: "var(--accent)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              marginBottom: 13,
            }}
          >
            Documentation
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
            Everything is documented
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 15,
              lineHeight: 1.6,
              color: "var(--fg-2)",
            }}
          >
            The closure plan, the mediator path, the allowance viewer, the multisig coordination,
            the security model. Every claim in the docs traces back to a specific file in the
            source.
          </p>
        </div>

        <div
          className="resp-stack"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 14,
            marginBottom: 32,
          }}
        >
          <DocCard
            title="Getting started"
            body="Open the live app, run the demo flow, connect a real wallet, or paste a secret key."
            href="https://docs.demolisher.app/docs/users"
          />
          <DocCard
            title="How it works"
            body="The audit, the plan tree, the 9-phase classical batch, the simulator, the executor."
            href="https://docs.demolisher.app/docs/developers/concepts/closure-lifecycle"
          />
          <DocCard
            title="Destinations &amp; mediator"
            body="Sending recovered XLM to a wallet, and how the mediator path reaches an exchange."
            href="https://docs.demolisher.app/docs/users/send-to-an-exchange"
          />
          <DocCard
            title="Security"
            body="What the deployment can do, the contract allow-list, the safety gates, the CSP."
            href="https://docs.demolisher.app/docs/developers/security/model"
          />
          <DocCard
            title="Allowance viewer"
            body="Audit and revoke SEP-41 token approvals on any address."
            href="https://docs.demolisher.app/docs/users/revoke-token-allowances"
          />
          <DocCard
            title="Self host"
            body="Install, configure environment variables, run under your own domain."
            href="https://docs.demolisher.app/docs/developers/operations/self-hosting"
          />
        </div>

        <a
          href="https://docs.demolisher.app"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            padding: "13px 22px",
            background: "var(--accent)",
            color: "var(--accent-fg)",
            border: "none",
            borderRadius: 11,
            fontWeight: 600,
            fontSize: 15,
            textDecoration: "none",
          }}
        >
          Open the full docs
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
    </section>
  );
}

function DocCard({
  title,
  body,
  href,
}: {
  readonly title: string;
  readonly body: string;
  readonly href: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "20px 22px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        color: "var(--fg)",
        textDecoration: "none",
        transition: "border-color 140ms, background 140ms",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: 15,
            letterSpacing: "-0.005em",
          }}
        >
          {title}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: "var(--fg-3)", flexShrink: 0 }}
          aria-hidden
        >
          <path d="M7 17L17 7M9 7h8v8" />
        </svg>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: "var(--fg-2)",
        }}
      >
        {body}
      </p>
    </a>
  );
}
