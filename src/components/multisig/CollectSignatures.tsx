"use client";

// the Signatures step of a shared-account close. the reviewed close has been
// published to the relay, signed with the initiator's key. the initiator shares
// a link for remote signers and/or pastes a co-signer's key to sign here; each
// accepted signature arrives live over server-sent events. every relay envelope
// must hash to the request id, and only its signatures are taken. once the
// threshold is met the initiator confirms, the envelope is trimmed to the
// signatures the network will use, and the bundle goes up (onClose) to the
// shared Close step. it never auto-closes, and no secret leaves this browser.

import { useCallback, useEffect, useMemo, useState } from "react";

import { TypedConfirmation } from "@/components/confirmations/TypedConfirmation";
import {
  closeSignerSet,
  decodePinned,
  EnvelopeMismatchError,
  mergeRelayEnvelope,
  trimToThreshold,
} from "@/components/multisig/envelope";
import {
  Badge,
  Button,
  Card,
  CopyableAddress,
  Notice,
  Progress,
  SectionLabel,
} from "@/components/ui";
import { SEED_INPUT_ATTRS } from "@/components/wallet/seed-input";
import type { NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl } from "@/lib/explorer";
import { fetchPlan, publishPlan, submitSignature, subscribePlan } from "@/lib/multisig/plan-client";
import {
  closeThreshold,
  collectedWeight,
  requiredSigners,
  signedSigners,
} from "@/lib/multisig/signing-request";
import { getHorizon } from "@/lib/stellar/horizon-client";
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
  // hand the signed bundle up to be submitted through the shared Close step
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
  const [copyError, setCopyError] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [signingLocal, setSigningLocal] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [checkingSigners, setCheckingSigners] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  // a relay frame that wasn't this transaction; the held envelope is kept
  const [envelopeError, setEnvelopeError] = useState<string | null>(null);
  // the live feed died terminally (relay swept the plan, or server restarted);
  // bumping liveReloadKey tears down and re-opens the EventSource on refresh.
  const [liveInterrupted, setLiveInterrupted] = useState(false);
  const [liveReloadKey, setLiveReloadKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [republishing, setRepublishing] = useState(false);

  // the request id is the hash of what the initiator reviewed and signed. if the
  // two disagree nothing on this step can be trusted, so it refuses to run.
  const initialError = useMemo(() => {
    try {
      decodePinned(initialXdr, network.passphrase, planId);
      return null;
    } catch (e: unknown) {
      return errorMessage(e, "The signing request doesn't match the reviewed transaction.");
    }
  }, [initialXdr, network.passphrase, planId]);

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

  // take the signatures of a relay envelope, only when it is this transaction.
  // throws EnvelopeMismatchError otherwise and leaves the held envelope alone.
  const absorb = useCallback(
    (incoming: string): void => {
      decodePinned(incoming, network.passphrase, planId);
      setXdr((held) => mergeRelayEnvelope(held, incoming, network.passphrase, planId));
    },
    [network.passphrase, planId],
  );

  // live updates: every signature a co-signer adds on the relay arrives here at
  // once, so progress advances without polling.
  useEffect(() => {
    if (initialError !== null) return;
    const unsubscribe = subscribePlan(
      planId,
      (plan) => {
        try {
          absorb(plan.xdr);
          setLiveInterrupted(false);
        } catch (e: unknown) {
          setEnvelopeError(errorMessage(e, "The relay sent a transaction that doesn't match."));
        }
      },
      ({ terminal }) => {
        // transient drops self-heal; only a terminal CLOSED means live updates
        // have genuinely stopped and the initiator needs to re-sync manually.
        if (terminal) setLiveInterrupted(true);
      },
    );
    return unsubscribe;
  }, [planId, liveReloadKey, absorb, initialError]);

  // manual re-sync after the live feed died: pull the latest envelope once and
  // re-open the stream. a failure (usually the relay lost the request after a
  // restart or expiry) is shown, with a way to publish the held envelope again.
  const refreshLive = useCallback(async () => {
    setRefreshError(null);
    try {
      const plan = await fetchPlan(planId);
      absorb(plan.xdr);
      setLiveInterrupted(false);
      setLiveReloadKey((k) => k + 1);
    } catch (e: unknown) {
      setRefreshError(errorMessage(e, "Couldn't reach the signing request."));
    }
  }, [planId, absorb]);

  // the relay keys a request by its transaction hash, so publishing the held
  // envelope again restores the same link with every signature collected so far
  const republish = useCallback(async () => {
    setRepublishing(true);
    try {
      const id = await publishPlan(network.id, xdr);
      if (id !== planId) {
        throw new EnvelopeMismatchError(
          "The relay returned a different request id for this transaction.",
        );
      }
      setRefreshError(null);
      setLiveInterrupted(false);
      setLiveReloadKey((k) => k + 1);
    } catch (e: unknown) {
      setRefreshError(errorMessage(e, "Couldn't publish the request again."));
    } finally {
      setRepublishing(false);
    }
  }, [network.id, xdr, planId]);

  // drop any pasted-but-unsubmitted secret key from state when this surface goes
  // away, so a seed never lingers in memory after the step unmounts
  useEffect(() => () => setSecret(""), []);

  const onCopy = useCallback(async () => {
    setCopyError(null);
    // navigator.clipboard is missing on plain-http origins
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
      setCopyError("Copying isn't available here. Select the link and copy it manually.");
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e: unknown) {
      setCopyError(
        `Couldn't copy the link (${errorMessage(e, "clipboard refused")}). Select it and copy it manually.`,
      );
    }
  }, [link]);

  // sign locally with a pasted signer key, then publish the signature to the
  // relay so the merged envelope (and progress) stays canonical for everyone.
  // signs one key per submit; paste the next key to add another signer.
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
      const tx = decodePinned(xdr, network.passphrase, planId);
      const { signedXdr } = await connector.signTransaction(tx, network.passphrase);
      const merged = await submitSignature(planId, signedXdr);
      // the relay's answer may predate a signature that already arrived live;
      // absorb only adds, so nothing shown here is lost
      absorb(merged.xdr);
      setLastAdded(pk);
    } catch (e: unknown) {
      setSecretError(errorMessage(e, "Couldn't add that signature."));
    } finally {
      setSigningLocal(false);
    }
  }, [secret, xdr, network.passphrase, signerKeys, signed, planId, absorb]);

  // reload the account's current signers and thresholds, keep only the
  // signatures the network will use, and hand that bundle up. a signer removed
  // since publishing, or a raised threshold, is caught here instead of on chain.
  const onConfirmClose = useCallback(async () => {
    setShowConfirm(false);
    setCloseError(null);
    setCheckingSigners(true);
    try {
      const account = await getHorizon(network).loadAccount(audit.accountId);
      const current = closeSignerSet(account);
      const trimmed = trimToThreshold(xdr, network.passphrase, current.signers, current.required);
      if (!trimmed.met) {
        setCloseError(
          `The account now needs ${current.required} signing weight, and the signatures collected from its current signers add up to ${trimmed.weight}. Collect more signatures before closing.`,
        );
        return;
      }
      onClose(trimmed.xdr);
    } catch (e: unknown) {
      setCloseError(errorMessage(e, "Couldn't check the account's current signers."));
    } finally {
      setCheckingSigners(false);
    }
  }, [network, audit.accountId, xdr, onClose]);

  if (initialError !== null) {
    return (
      <Card padding={24}>
        <Notice
          tone="danger"
          role="alert"
          title="This signing request can't be used"
          data-testid="collect-envelope-error"
        >
          {initialError} Start the close again from the review step.
        </Notice>
      </Card>
    );
  }

  return (
    <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
          Collect the other signatures
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
          Share the link so the other signers can sign from their own devices, or paste a signer key
          to sign here. Each signature shows up below the moment it lands. When you have enough, you
          close the account.
        </p>
      </div>

      {envelopeError !== null ? (
        <Notice
          tone="danger"
          role="alert"
          title="Ignored an update from the relay"
          data-testid="collect-envelope-error"
        >
          {envelopeError} The signatures shown here are the ones checked against your reviewed
          transaction.
        </Notice>
      ) : null}

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
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onCopy()}
            data-testid="collect-copy"
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        {copyError !== null ? (
          <p
            role="alert"
            data-testid="collect-copy-error"
            style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}
          >
            {copyError}
          </p>
        ) : null}
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
        {liveInterrupted ? (
          <Notice tone="warning" role="status" title="Live updates interrupted">
            Signatures added by others may not be showing here. Refresh to pull the latest.
            {refreshError !== null ? (
              <span
                data-testid="collect-refresh-error"
                style={{ display: "block", marginTop: 8, color: "var(--danger)" }}
              >
                {refreshError} If the request expired on the server, publish it again: the link
                stays the same and every signature collected here is kept.
              </span>
            ) : null}
            <span style={{ display: "inline-flex", gap: 8, marginTop: 10 }}>
              <Button variant="secondary" size="sm" onClick={() => void refreshLive()}>
                Refresh
              </Button>
              {refreshError !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={republishing}
                  onClick={() => void republish()}
                  data-testid="collect-republish"
                >
                  Publish this request again
                </Button>
              ) : null}
            </span>
          </Notice>
        ) : null}
      </div>

      {/* sign locally with a pasted key, one signer at a time, until enough
          weight is in. past that point extra signatures would only be trimmed. */}
      {thresholdMet ? (
        <p
          role="status"
          style={{ margin: 0, fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5 }}
        >
          Enough signatures collected. Signatures beyond the threshold aren&apos;t needed and are
          left out of the close.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel>SIGN A KEY LOCALLY</SectionLabel>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              {...SEED_INPUT_ATTRS}
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
              aria-invalid={secretError !== null}
              aria-describedby={secretError !== null ? "collect-secret-error" : undefined}
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
            <p
              id="collect-secret-error"
              role="alert"
              style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}
            >
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
        </div>
      )}

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
            loading={checkingSigners}
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
            {checkingSigners ? "Checking the account's signers…" : "Continue to final confirmation"}
          </Button>
          {closeError !== null ? (
            <p
              role="alert"
              data-testid="collect-close-error"
              style={{ margin: 0, fontSize: 12.5, color: "var(--danger)", lineHeight: 1.5 }}
            >
              {closeError}
            </p>
          ) : null}
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
