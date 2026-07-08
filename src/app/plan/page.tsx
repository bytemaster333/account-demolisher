"use client";

// /plan index: open a multisig signing plan by link or hash

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  Field,
  InfoTip,
  Notice,
  PageContainer,
  PageHeader,
  SectionLabel,
} from "@/components/ui";

const REFRACTOR_DOCS_URL = "https://refractor.space";

// accept either a 64-char hex hash, a refractor.space/tx/<hash> url, or a
// /plan/<hash> url copy-pasted out of a previous session
function parsePlanInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // bare hex hash: refractor hashes are 64 hex chars
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  // url form. tolerate either refractor's frontend or our own /plan/<id>
  try {
    const url = new URL(trimmed);
    // last non-empty path segment is the hash
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    if (last && /^[0-9a-f]{64}$/i.test(last)) return last.toLowerCase();
  } catch {
    // not a url; fall through
  }

  return null;
}

const STEPS: ReadonlyArray<string> = [
  "Have your multi-signature closure transaction on Refractor, then paste its link or transaction hash below. Demolisher opens a shareable /plan/<hash> view of that plan.",
  "Send that link to every co-signer. Each one opens it, reviews the exact transaction, and adds their signature with their own wallet.",
  "Once the collected signatures meet the account's threshold, Refractor submits the transaction to the network automatically, and the plan page then shows the final tx hash.",
];

export default function PlanIndexPage(): React.JSX.Element {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);

  const parsed = useMemo(() => parsePlanInput(input), [input]);
  const showError = touched && input.trim().length > 0 && parsed === null;

  const submit = useCallback((): void => {
    setTouched(true);
    if (parsed !== null) router.push(`/plan/${parsed}`);
  }, [parsed, router]);

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          kicker="Multisig"
          title="Open a plan to sign"
          subtitle={
            <>
              Closing a{" "}
              <InfoTip tip="A multi-signature account requires more than one key to authorize a transaction. Every required signer has to sign the same closure transaction before the network will accept it.">
                multi-signature
              </InfoTip>{" "}
              account needs every key holder to sign the same transaction. Paste the plan link (or
              its hash) a co-signer shared with you to open its live signing status.
            </>
          }
        />

        <Card padding={22}>
          <Field
            label="Refractor link or transaction hash"
            value={input}
            onChange={(v) => {
              setInput(v);
              setTouched(false);
            }}
            onEnter={submit}
            placeholder="https://refractor.space/tx/… or 64-char hex hash"
            mono
            autoComplete="off"
            spellCheck={false}
            aria-label="Refractor link or transaction hash"
            error={
              showError
                ? "That doesn't look like a Refractor link or a 64-character hex hash. Double-check the link you were sent."
                : null
            }
          />
          <div style={{ marginTop: 14 }}>
            <Button
              onClick={submit}
              disabled={parsed === null}
              disabledReason="Enter a valid Refractor link or 64-char hash"
              iconRight={
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
              }
            >
              Open plan
            </Button>
          </div>
        </Card>

        <div style={{ marginTop: 22 }}>
          <Card padding={20} style={{ background: "var(--surface-2)" }}>
            <SectionLabel>How it works</SectionLabel>
            <ol
              style={{
                margin: "12px 0 0",
                padding: "0 0 0 20px",
                fontSize: 13.5,
                lineHeight: 1.65,
                color: "var(--fg-2)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {STEPS.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <Link
              href={REFRACTOR_DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              style={{
                display: "inline-block",
                marginTop: 14,
                font: "600 12.5px/1 Geist, sans-serif",
                color: "var(--accent)",
                textDecoration: "none",
              }}
            >
              Read the Refractor documentation ↗
            </Link>
          </Card>
        </div>

        <div style={{ marginTop: 16 }}>
          <Notice tone="neutral">
            Signature collection is coordinated through{" "}
            <InfoTip tip="Refractor is a third-party service that collects each key holder's partial signature and submits the transaction once enough have signed. Demolisher never stores your envelope.">
              <strong style={{ color: "var(--fg-2)" }}>Refractor</strong>
            </InfoTip>
            , a third-party service. Demolisher does not store any envelope state itself.
          </Notice>
        </div>
      </PageContainer>
    </AppShell>
  );
}
