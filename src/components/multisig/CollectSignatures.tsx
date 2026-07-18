"use client";

// The Signatures step of a shared-account close. The reviewed close has been
// published to the relay (signed with the initiator's key). Here the initiator
// shares a short link for remote signers AND/OR pastes a co-signer's key to sign
// locally; each accepted signature arrives live over Server-Sent Events. When the
// threshold is met the initiator confirms, and the fully-signed bundle is handed
// UP (onClose) so the shared Close step submits it, exactly like any close. It
// never auto-closes, and no secret ever leaves this browser.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import { Badge, Button, Card, CopyableAddress, Progress, SectionLabel } from "@/components/ui";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl } from "@/lib/explorer";
import { submitSignature, subscribePlan } from "@/lib/multisig/plan-client";
import {
  closeThreshold,
  collectedWeight,
  requiredSigners,
  signedSigners,
} from "@/lib/multisig/signing-request";
import type { AccountAudit } from "@/lib/types/account";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

export interface CollectSignaturesProps {
  readonly planId: string;
  readonly audit: AccountAudit;
  readonly network: NetworkConfig;
  // the close transaction, already signed with the initiator's key, to seed the
  // view before the first live update arrives
  readonly initialXdr: string;
  readonly destination: string;
  readonly connectedKey: string | null;
  // hand the fully-signed bundle up to be submitted through the shared Close step
  readonly onClose: (signedXdr: string) => void;
}

export function CollectSignatures({
  planId,
  audit,
  network,
  initialXdr,
  destination,
  connectedKey,
  onClose,
}: CollectSignaturesProps): React.JSX.Element {
  const [xdr, setXdr] = useState(initialXdr);
  const [copied, setCopied] = useState(false);
  const [secret, setSecret] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [signingLocal, setSigningLocal] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const required = useMemo(() => requiredSigners(audit), [audit]);
  const threshold = useMemo(() => closeThreshold(audit), [audit]);
  const signerKeys = useMemo(() => required.map((s) => s.key), [required]);

  const signed = useMemo(
    () => signedSigners(xdr, network.passphrase, signerKeys),
    [xdr, network.passphrase, signerKeys],
  );
  const weight = useMemo(() => collectedWeight(signed, audit), [signed, audit]);
  const thresholdMet = weight >= threshold;

  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/sign?id=${planId}`
      : `/sign?id=${planId}`;

  // live updates: every signature a co-signer adds on the relay arrives here at
  // once, so progress advances without polling.
  useEffect(() => {
    const unsubscribe = subscribePlan(planId, (plan) => setXdr(plan.xdr));
    return unsubscribe;
  }, [planId]);

  // drop any pasted-but-unsubmitted secret key from state when this surface goes
  // away, so a seed never lingers in memory after the step unmounts
  useEffect(() => () => setSecret(""), []);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(link);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [link]);

  // sign locally with a pasted signer key, then publish the signature to the
  // relay so the merged envelope (and progress) stays canonical for everyone.
  // Signs ONE key per submit; paste the next key to add another signer.
  const onAddKey = useCallback(async () => {
    const seed = secret.trim();
    if (seed.length === 0) return;
    setSecret("");
    setSecretError(null);
    setLastAdded(null);
    setSigningLocal(true);
    try {
      const connector = new SecretKeyConnector(seed);
      const pk = await connector.getPublicKey();
      if (!signerKeys.includes(pk)) {
        setSecretError("That key isn't a signer on this account.");
        return;
      }
      if (signed.includes(pk)) {
        setSecretError("That signer already signed.");
        return;
      }
      const tx = TransactionBuilder.fromXDR(xdr, network.passphrase) as Transaction;
      const { signedXdr } = await connector.signTransaction(tx, network.passphrase);
      const merged = await submitSignature(planId, signedXdr);
      setXdr(merged.xdr);
      setLastAdded(pk);
    } catch (e: unknown) {
      setSecretError(errorMessage(e, "Couldn't add that signature."));
    } finally {
      setSigningLocal(false);
    }
  }, [secret, xdr, network.passphrase, signerKeys, signed, planId]);

  // hand the fully-signed bundle up to the shared Close step (the machine submits
  // it and shows the same executing -> succeeded status as a single-signer close).
  const onConfirmClose = useCallback(() => {
    setShowConfirm(false);
    onClose(xdr);
  }, [xdr, onClose]);

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Collect the other signatures
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Share the link so the other signers can sign from their own devices, or paste a signer
          key to sign here. Each signature shows up below the moment it lands. When you have enough,
          you close the account.
        </p>
      </div>

      {/* share link */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <SectionLabel>SEND TO THE OTHER SIGNERS</SectionLabel>
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
        <div
          style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}
          data-testid="collect-signers"
        >
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
                    full
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

      {/* sign locally with a pasted key, one signer at a time */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SectionLabel>SIGN A KEY LOCALLY</SectionLabel>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="password"
            value={secret}
            onChange={(e) => {
              setSecret(e.currentTarget.value);
              setSecretError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onAddKey();
            }}
            placeholder="Signer secret key (S…)"
            aria-label="Signer secret key"
            autoComplete="off"
            spellCheck={false}
            data-testid="collect-secret"
            style={{
              flex: 1,
              minWidth: 220,
              height: 40,
              padding: "0 13px",
              borderRadius: 9,
              border: "1px solid var(--border-2)",
              background: "var(--surface-2)",
              color: "var(--fg)",
              font: "500 13px/1 'Geist Mono', monospace",
            }}
          />
          <Button
            variant="secondary"
            onClick={() => void onAddKey()}
            loading={signingLocal}
            disabled={signingLocal || secret.trim().length === 0}
            data-testid="collect-sign-local"
          >
            Sign
          </Button>
        </div>
        {secretError !== null ? (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>
            {secretError}
          </p>
        ) : lastAdded !== null ? (
          <p
            role="status"
            style={{ margin: 0, fontSize: 12, color: "var(--success)", fontWeight: 600 }}
          >
            ✓ Signed as {lastAdded.slice(0, 8)}…{lastAdded.slice(-6)}. Paste the next key to add
            another signer.
          </p>
        ) : null}
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
          Hold more than one key? Paste and sign each one; every signature moves the bar up. Keys
          are used only in this browser to sign, and are never uploaded or stored.
        </p>
        {thresholdMet ? (
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
            Threshold reached; more signatures are optional.
          </p>
        ) : null}
      </div>

      {/* once enough signatures are in, the close terminal matches the
          single-signer Review flow: the same danger notice + "Continue to final
          confirmation", then the typed-confirmation dialog. */}
      {thresholdMet ? (
        <>
          <div
            role="note"
            style={{
              display: "flex",
              gap: 10,
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-2)",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--danger)"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginTop: 1 }}
              aria-hidden
            >
              <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
            </svg>
            <span>
              This permanently deletes the account and sends all its XLM to your destination.{" "}
              <strong style={{ color: "var(--fg)", fontWeight: 600 }}>It cannot be undone.</strong>{" "}
              Double-check the destination before continuing.
            </span>
          </div>

          <Button
            variant="danger"
            onClick={() => setShowConfirm(true)}
            data-testid="collect-close"
            style={{ width: "100%" }}
            iconRight={
              <svg
                width="16"
                height="16"
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
            Continue to final confirmation
          </Button>
        </>
      ) : (
        <Button
          variant="danger"
          disabled
          disabledReason="Collect enough signatures to reach the threshold first"
          data-testid="collect-close"
          style={{ width: "100%" }}
        >
          Waiting for enough signatures
        </Button>
      )}

      {showConfirm ? (
        <TypedConfirmation
          destination={destination}
          explorerUrl={explorerAccountUrl(network, destination)}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => void onConfirmClose()}
        />
      ) : null}
    </Card>
  );
}
