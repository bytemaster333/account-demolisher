"use client";

// Terminal step of a shared-account close when the initiator doesn't hold every
// key. The reviewed close was built into ONE bundled transaction and signed with
// the initiator's key; this step shares it as a signing request, tracks which
// signers have signed (decoded locally from the envelope, no server), lets the
// initiator paste back returned signatures, and submits once the threshold is
// met. It also watches the chain so a close submitted by a co-signer is detected
// here too.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, CopyableAddress, Notice, Progress } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import {
  closeThreshold,
  collectedWeight,
  decodeSigningRequest,
  encodeSigningRequest,
  mergeSignatures,
  requiredSigners,
  signedSigners,
} from "@/lib/multisig/signing-request";
import { getHorizon } from "@/lib/stellar/horizon-client";
import type { AccountAudit } from "@/lib/types/account";

const POLL_MS = 8000;

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: number }; name?: string };
  return e.response?.status === 404 || e.name === "NotFoundError";
}

export interface CollectSignaturesProps {
  readonly audit: AccountAudit;
  readonly network: NetworkConfig;
  // the close transaction, already signed with the initiator's key
  readonly initialXdr: string;
  readonly connectedKey: string | null;
}

type Submit =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "error"; readonly message: string };

export function CollectSignatures({
  audit,
  network,
  initialXdr,
  connectedKey,
}: CollectSignaturesProps): React.JSX.Element {
  const [xdr, setXdr] = useState(initialXdr);
  const [closed, setClosed] = useState<{ hash: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<Submit>({ kind: "idle" });

  const required = useMemo(() => requiredSigners(audit), [audit]);
  const threshold = useMemo(() => closeThreshold(audit), [audit]);
  const signerKeys = useMemo(() => required.map((s) => s.key), [required]);

  const signed = useMemo(
    () => signedSigners(xdr, network.passphrase, signerKeys),
    [xdr, network.passphrase, signerKeys],
  );
  const weight = useMemo(() => collectedWeight(signed, audit), [signed, audit]);
  const thresholdMet = weight >= threshold;

  const encoded = useMemo(() => encodeSigningRequest({ network: network.id, xdr }), [network.id, xdr]);
  const link =
    typeof window !== "undefined" ? `${window.location.origin}/sign#${encoded}` : `/sign#${encoded}`;

  // watch the chain: once the account is merged it 404s on Horizon, which is the
  // definitive "closed" signal regardless of who submitted the transaction.
  useEffect(() => {
    if (closed !== null) return;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        await getHorizon(network).loadAccount(audit.accountId);
      } catch (e: unknown) {
        if (!cancelled && isNotFound(e)) setClosed({ hash: null });
      }
    };
    const id = setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [closed, network, audit.accountId]);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(link);
    setCopied(true);
  }, [link]);

  const onPasteBack = useCallback(() => {
    setPasteError(null);
    const raw = paste.trim();
    if (raw.length === 0) return;
    // accept a returned link, an encoded request, or a raw signed XDR
    const token = raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw;
    const decoded = decodeSigningRequest(token);
    const returnedXdr = decoded !== null ? decoded.xdr : raw;
    try {
      const merged = mergeSignatures(xdr, [returnedXdr], network.passphrase, {
        expectedSigners: signerKeys,
      });
      setXdr(merged);
      setPaste("");
    } catch (e: unknown) {
      setPasteError(errorMessage(e, "Couldn't add that signature. Check you pasted the right request."));
    }
  }, [paste, xdr, network.passphrase, signerKeys]);

  const onSubmit = useCallback(async () => {
    setSubmit({ kind: "submitting" });
    try {
      const tx = TransactionBuilder.fromXDR(xdr, network.passphrase) as Transaction;
      const res = (await getHorizon(network).submitTransaction(tx)) as { hash: string };
      setClosed({ hash: res.hash });
    } catch (e: unknown) {
      setSubmit({ kind: "error", message: errorMessage(e, "The network rejected the transaction.") });
    }
  }, [xdr, network]);

  if (closed !== null) {
    return (
      <Notice tone="success" role="status" title="Enough signatures collected, the account is closed">
        The transaction was submitted and the account has been closed. Any remaining XLM was sent to
        your destination.
        {closed.hash !== null ? (
          <>
            {" "}
            <a
              href={explorerTxUrl(network, closed.hash)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
            >
              View transaction ↗
            </a>
          </>
        ) : null}
      </Notice>
    );
  }

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Collect the other signatures
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Your signature is in. Send this request to the other signers; they open it, review the
          exact close, and sign with their own key. It stays open until enough have signed.
        </p>
      </div>

      {/* share link */}
      <div>
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", letterSpacing: "0.05em", marginBottom: 6 }}>
          SEND TO THE OTHER SIGNERS
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code
            data-testid="collect-link"
            style={{
              flex: 1,
              minWidth: 220,
              padding: "10px 12px",
              borderRadius: 9,
              background: "var(--bg-2)",
              border: "1px solid var(--border)",
              font: "500 12px/1.4 'Geist Mono', monospace",
              color: "var(--fg-2)",
              wordBreak: "break-all",
              maxHeight: 88,
              overflow: "auto",
            }}
          >
            {link}
          </code>
          <Button variant="primary" size="sm" onClick={onCopy} data-testid="collect-copy">
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </div>

      {/* progress */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Progress
          value={weight}
          max={threshold}
          tone="accent"
          label="Signing weight collected"
          valueLabel={`${weight} of ${threshold}`}
          data-testid="collect-progress"
        />
        <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }} data-testid="collect-signers">
          {required.map((s, i) => {
            const has = signed.includes(s.key);
            const isYou = connectedKey !== null && s.key === connectedKey;
            return (
              <div
                key={s.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "11px 14px",
                  borderTop: i > 0 ? "1px solid var(--border)" : "none",
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <CopyableAddress
                    value={s.key}
                    label="Signer"
                    head={8}
                    tail={6}
                    size={12}
                    href={explorerAccountUrl(network, s.key)}
                  />
                </span>
                <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>weight {s.weight}</span>
                {isYou ? <Badge tone="neutral">You</Badge> : null}
                {has ? <Badge tone="success">Signed</Badge> : <Badge tone="warning">Pending</Badge>}
              </div>
            );
          })}
        </div>
      </div>

      {/* paste back a returned signature */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 11.5, color: "var(--fg-3)", letterSpacing: "0.05em" }}>
          GOT A SIGNED REQUEST BACK? PASTE IT HERE
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={paste}
            onChange={(e) => {
              setPaste(e.currentTarget.value);
              setPasteError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onPasteBack();
            }}
            placeholder="Paste the signed request a co-signer sent back…"
            spellCheck={false}
            data-testid="collect-paste"
            style={{
              flex: 1,
              minWidth: 220,
              height: 40,
              padding: "0 13px",
              borderRadius: 9,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              color: "var(--fg)",
              font: "500 12px/1 'Geist Mono', monospace",
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={onPasteBack}
            disabled={paste.trim().length === 0}
            data-testid="collect-add"
          >
            Add
          </Button>
        </div>
        {pasteError !== null ? (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>
            {pasteError}
          </p>
        ) : null}
      </div>

      {submit.kind === "error" ? (
        <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
          {submit.message}
        </p>
      ) : null}

      <Button
        variant="danger"
        onClick={() => void onSubmit()}
        loading={submit.kind === "submitting"}
        disabled={!thresholdMet || submit.kind === "submitting"}
        disabledReason={thresholdMet ? undefined : "Collect enough signatures to reach the threshold first"}
        data-testid="collect-submit"
      >
        {thresholdMet ? "Submit and close the account" : "Waiting for enough signatures"}
      </Button>
    </Card>
  );
}
