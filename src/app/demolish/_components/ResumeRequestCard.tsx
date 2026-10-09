"use client";

import { Button, Notice } from "@/components/ui";
import { shortAddress } from "@/lib/safe-display";

import type { StoredSigningRequest } from "../_lib/signing-request-store";

// a signing request this browser published earlier for this account, offered
// for resuming on Configure
export function ResumeRequestCard({
  record,
  busy,
  error,
  onResume,
  onDiscard,
}: {
  readonly record: StoredSigningRequest;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onResume: () => void;
  readonly onDiscard: () => void;
}): React.JSX.Element {
  return (
    <Notice
      tone="neutral"
      title="You have a signing request in progress"
      data-testid="resume-signing-request"
    >
      A close of this account to {shortAddress(record.destination)} was published for co-signers on{" "}
      {new Date(record.createdAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}
      {record.validUntil !== null
        ? ` and stays valid until ${new Date(record.validUntil).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}`
        : ""}
      . Resume it to keep collecting the signatures already given.
      {error !== null ? (
        <div role="alert" style={{ marginTop: 8, color: "var(--danger)", fontSize: 12.5 }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
        <Button onClick={onResume} loading={busy} disabled={busy} data-testid="resume-request">
          {busy ? "Loading…" : "Resume signing request"}
        </Button>
        <Button variant="ghost" onClick={onDiscard} data-testid="discard-request">
          Discard
        </Button>
      </div>
    </Notice>
  );
}
