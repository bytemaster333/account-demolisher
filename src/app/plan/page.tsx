"use client";

// /plan index

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";

import { AppShell } from "@/components/layout/AppShell";

const REFRACTOR_DOCS_URL = "https://refractor.space";

// accept either a 64-char hex hash, a refractor.space/tx/<hash> url, or a
// /plan/<hash> url copy-pasted out of a previous session
function parsePlanInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // bare hex hash — refractor hashes are 64 hex chars
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  // url form. tolerate either refractor's frontend or our own /plan/<id>
  try {
    const url = new URL(trimmed);
    // last non-empty path segment is the hash
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last && /^[0-9a-f]{64}$/i.test(last)) return last.toLowerCase();
  } catch {
    // not a url — fall through
  }

  return null;
}

export default function PlanIndexPage(): React.JSX.Element {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);

  const parsed = useMemo(() => parsePlanInput(input), [input]);
  const showError = touched && input.trim().length > 0 && parsed === null;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setTouched(true);
    if (parsed !== null) {
      router.push(`/plan/${parsed}`);
    }
  };

  return (
    <AppShell>
      <section
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "40px 28px 96px",
        }}
      >
        <div
          style={{
            font: "600 12px/1 Geist,sans-serif",
            color: "var(--accent)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: 13,
          }}
        >
          Multisig coordination
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: "-0.03em",
          }}
        >
          Open a coordination plan
        </h1>
        <p
          style={{
            margin: "13px 0 26px",
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--fg-2)",
            maxWidth: 560,
          }}
        >
          Multi-signature accounts need every key holder to sign before the closure can submit.
          Demolisher uploads the canonical transaction to{" "}
          <Link
            href={REFRACTOR_DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
          >
            Refractor
          </Link>
          , a third-party signature-coordination service, and gives you a shareable link. Paste that
          link (or its underlying transaction hash) below to open the live status page.
        </p>

        <form
          onSubmit={handleSubmit}
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            padding: 22,
            boxShadow: "var(--shadow-sm)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <label
            htmlFor="plan-input"
            style={{
              font: "600 12px/1 Geist,sans-serif",
              color: "var(--fg-2)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Refractor link or transaction hash
          </label>
          <input
            id="plan-input"
            name="plan-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://refractor.space/tx/… or 64-char hex hash"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setTouched(false);
            }}
            aria-invalid={showError}
            aria-describedby={showError ? "plan-input-error" : undefined}
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 11,
              border: `1px solid ${showError ? "var(--danger)" : "var(--border-2)"}`,
              background: "var(--surface-2)",
              color: "var(--fg)",
              font: "500 13px/1.4 'Geist Mono', monospace",
              boxSizing: "border-box",
            }}
          />
          {showError ? (
            <div
              id="plan-input-error"
              role="alert"
              style={{
                font: "500 12px/1.4 Geist,sans-serif",
                color: "var(--danger)",
              }}
            >
              That doesn&apos;t look like a Refractor link or a 64-character hex hash. Double-check
              the link you were sent.
            </div>
          ) : null}
          <button
            type="submit"
            disabled={parsed === null}
            style={{
              alignSelf: "flex-start",
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              padding: "11px 18px",
              borderRadius: 11,
              border: "none",
              background: parsed === null ? "var(--surface-3)" : "var(--accent)",
              color: parsed === null ? "var(--fg-3)" : "var(--accent-fg)",
              font: "600 14px/1 Geist,sans-serif",
              cursor: parsed === null ? "not-allowed" : "pointer",
              boxShadow: parsed === null ? "none" : "0 6px 20px var(--accent-soft)",
            }}
          >
            Open plan →
          </button>
        </form>

        <div
          style={{
            marginTop: 26,
            padding: 18,
            borderRadius: 14,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              font: "600 11px/1 Geist,sans-serif",
              color: "var(--fg-3)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            How it works
          </div>
          <ol
            style={{
              margin: 0,
              padding: "0 0 0 18px",
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--fg-2)",
            }}
          >
            <li>
              Run a demolition against a multi-sig account. Demolisher uploads the unsigned envelope
              to Refractor and shows you a /plan/&lt;hash&gt; URL.
            </li>
            <li>
              Share that URL with every co-signer. Each one opens it, reviews the canonical XDR, and
              adds their signature with their wallet.
            </li>
            <li>
              Once the cumulative signature weight meets the account threshold, Refractor submits
              the transaction to Horizon automatically and the page surfaces the resulting tx hash.
            </li>
          </ol>
          <Link
            href={REFRACTOR_DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              alignSelf: "flex-start",
              marginTop: 4,
              font: "600 12.5px/1 Geist,sans-serif",
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            Read the Refractor documentation ↗
          </Link>
        </div>

        <p
          style={{
            margin: "16px 0 0",
            fontSize: 12,
            color: "var(--fg-3)",
            lineHeight: 1.5,
            display: "flex",
            gap: 8,
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--fg-3)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: 1 }}
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          <span>
            Signature collection is coordinated through{" "}
            <strong style={{ color: "var(--fg-2)" }}>Refractor</strong>, a third-party service.
            Demolisher does not store any envelope state itself.
          </span>
        </p>
      </section>
    </AppShell>
  );
}
