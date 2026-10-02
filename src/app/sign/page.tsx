"use client";

// co-signer page for a shared-account close. the person closing a multisig
// account sends a link (/sign?id=<hash>). this page fetches the transaction from
// the relay and only accepts it if it hashes to the id in the link; every later
// envelope from the relay (live frames, refreshes, sign responses) is checked
// the same way, and only its signatures are taken, so the transaction shown and
// signed here is always the one the link names. that holds against a relay or
// proxy that rewrites the api; it can't hold against a server that also serves
// altered page code. the co-signer signs with their own wallet or key, the
// signature goes back to the relay, and no secret leaves this browser.

import { NotFoundError, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
import {
  closeSignerSet,
  decodePinned,
  mergeRelayEnvelope,
  type CloseSignerSet,
} from "@/components/multisig/envelope";
import {
  Badge,
  Button,
  Card,
  CopyableAddress,
  Notice,
  PageContainer,
  PageHeader,
  Progress,
  Spinner,
} from "@/components/ui";
import { SEED_INPUT_ATTRS } from "@/components/wallet/seed-input";
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import { fetchPlan, submitSignature, subscribePlan } from "@/lib/multisig/plan-client";
import { inspectClose, signedSigners, type CloseInspection } from "@/lib/multisig/signing-request";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly network: NetworkConfig };

// what horizon says about the account being closed
type Facts =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly set: CloseSignerSet }
  // the account is gone; closedByThis is true when this very transaction did it
  | { readonly kind: "gone"; readonly closedByThis: boolean }
  | { readonly kind: "error"; readonly message: string };

function idFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("id");
  } catch {
    return null;
  }
}

// every op of a close must act on the account being closed. the relay refuses
// anything else at publish time; checking here too keeps the page honest on its own.
function foreignSources(tx: Transaction, closing: string): readonly string[] {
  const out = new Set<string>();
  for (const op of tx.operations) {
    const src = op.source ?? tx.source;
    if (src !== closing) out.add(src);
  }
  return [...out];
}

export default function SignPage(): React.JSX.Element {
  const [planId, setPlanId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [xdr, setXdr] = useState<string | null>(null);
  const [envelopeError, setEnvelopeError] = useState<string | null>(null);

  const [facts, setFacts] = useState<Facts>({ kind: "loading" });

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signedHere, setSignedHere] = useState(false);
  const [lastSigner, setLastSigner] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  // the live feed died terminally (relay swept the plan, or server restarted);
  // bumping liveReloadKey tears down and re-creates the EventSource on refresh.
  const [liveInterrupted, setLiveInterrupted] = useState(false);
  const [liveReloadKey, setLiveReloadKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // drop any pasted-but-unsubmitted secret key when this page unmounts
  useEffect(() => () => setSecret(""), []);

  const network = load.kind === "ready" ? load.network : null;

  // read the id and fetch the transaction; it must hash to the id in the link
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = idFromLocation();
      if (id === null || id.length === 0) {
        if (!cancelled) setLoad({ kind: "error", message: "No signing request id in this link." });
        return;
      }
      setPlanId(id);
      try {
        const plan = await fetchPlan(id);
        if (cancelled) return;
        const net = resolveNetwork(plan.network);
        try {
          decodePinned(plan.xdr, net.passphrase, id);
        } catch {
          setLoad({
            kind: "error",
            message: "This request couldn't be verified (its transaction doesn't match the link).",
          });
          return;
        }
        setXdr(plan.xdr);
        setLoad({ kind: "ready", network: net });
      } catch (e: unknown) {
        if (!cancelled)
          setLoad({
            kind: "error",
            message: errorMessage(e, "Couldn't load this signing request."),
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // take the signatures of a relay envelope, only when it is the linked
  // transaction. throws otherwise and leaves the held envelope alone.
  const absorb = useCallback(
    (incoming: string): void => {
      if (network === null || planId === null) return;
      decodePinned(incoming, network.passphrase, planId);
      setXdr((held) =>
        held === null ? incoming : mergeRelayEnvelope(held, incoming, network.passphrase, planId),
      );
    },
    [network, planId],
  );

  // live progress: reflect signatures other co-signers add
  useEffect(() => {
    if (planId === null || load.kind !== "ready") return;
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
        // transient drops self-heal (EventSource keeps CONNECTING); only a
        // terminal CLOSED means live updates have genuinely stopped.
        if (terminal) setLiveInterrupted(true);
      },
    );
    return unsubscribe;
  }, [planId, load.kind, liveReloadKey, absorb]);

  // manual re-sync after the live feed died: pull the latest envelope once and
  // re-open the stream, or say why that failed
  const refreshLive = useCallback(async () => {
    if (planId === null) return;
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

  const inspection: CloseInspection | null = useMemo(
    () => (network && xdr ? inspectClose(xdr, network.passphrase) : null),
    [network, xdr],
  );
  const closingSource = inspection?.source ?? "";

  const strayOpSources = useMemo(() => {
    if (network === null || xdr === null || planId === null || closingSource === "") return [];
    return foreignSources(decodePinned(xdr, network.passphrase, planId), closingSource);
  }, [network, xdr, planId, closingSource]);

  // load the signers, weights and thresholds of the account being closed. keyed
  // on the account id so a new signature doesn't refetch it. when the account is
  // gone, ask horizon whether this very transaction is what closed it.
  useEffect(() => {
    if (network === null || closingSource.length === 0 || planId === null) return;
    let cancelled = false;
    void (async () => {
      setFacts({ kind: "loading" });
      try {
        const acct = await getHorizon(network).loadAccount(closingSource);
        if (!cancelled) setFacts({ kind: "ready", set: closeSignerSet(acct) });
      } catch (e: unknown) {
        if (!(e instanceof NotFoundError)) {
          if (!cancelled)
            setFacts({
              kind: "error",
              message: errorMessage(e, "Couldn't load this account from the network."),
            });
          return;
        }
        try {
          const tx = await getHorizon(network).transactions().transaction(planId).call();
          if (!cancelled) setFacts({ kind: "gone", closedByThis: tx.successful });
        } catch (txErr: unknown) {
          if (cancelled) return;
          if (txErr instanceof NotFoundError) setFacts({ kind: "gone", closedByThis: false });
          else
            setFacts({
              kind: "error",
              message: errorMessage(txErr, "Couldn't check whether this close already landed."),
            });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, closingSource, planId]);

  const set = facts.kind === "ready" ? facts.set : null;
  const signerKeys = useMemo(() => (set === null ? [] : set.signers.map((s) => s.key)), [set]);
  const signed = useMemo(
    () => (network && xdr && set ? signedSigners(xdr, network.passphrase, signerKeys) : []),
    [network, xdr, set, signerKeys],
  );
  const weight = useMemo(() => {
    if (set === null) return 0;
    const byKey = new Map(set.signers.map((s) => [s.key, s.weight]));
    return signed.reduce((sum, k) => sum + (byKey.get(k) ?? 0), 0);
  }, [signed, set]);
  const thresholdMet = set !== null && weight >= set.required;

  // sign with the co-signer's own connector, then post the signature to the relay
  const signWith = useCallback(
    async (sign: (tx: Transaction) => Promise<{ signedXdr: string; signerPublicKey: string }>) => {
      if (network === null || xdr === null || planId === null) return;
      setSigning(true);
      setSignError(null);
      try {
        // re-check the hash right before signing, so nothing but the linked
        // transaction is ever put in front of the signer
        const tx = decodePinned(xdr, network.passphrase, planId);
        const { signedXdr, signerPublicKey } = await sign(tx);
        // reject a signature from a key that is not a signer on this account
        // before posting it, so the relay never sees it
        if (set !== null && !signerKeys.includes(signerPublicKey)) {
          setSignError(
            `That key (${signerPublicKey.slice(0, 6)}…${signerPublicKey.slice(-4)}) is not a signer on this account. Nothing was submitted; connect a signer key and try again.`,
          );
          return;
        }
        const merged = await submitSignature(planId, signedXdr);
        // the relay's answer may predate a signature that already arrived live;
        // absorb only adds, so nothing shown here is lost
        absorb(merged.xdr);
        setLastSigner(signerPublicKey);
        setSignedHere(true);
      } catch (e: unknown) {
        setSignError(errorMessage(e, "Couldn't sign the transaction."));
      } finally {
        setSigning(false);
      }
    },
    [network, xdr, planId, set, signerKeys, absorb],
  );

  const signWithWallet = useCallback(() => {
    if (network === null) return;
    void signWith(async (tx) => {
      const connector = new WalletKitConnector(network);
      await connector.connect();
      return connector.signTransaction(tx, network.passphrase);
    });
  }, [signWith, network]);

  const signWithSecret = useCallback(() => {
    if (network === null) return;
    const seed = secret.trim();
    setSecret("");
    void signWith(async (tx) => {
      const connector = new SecretKeyConnector(seed);
      return connector.signTransaction(tx, network.passphrase);
    });
  }, [signWith, secret, network]);

  // ── render ─────────────────────────────────────────────────────────────────

  if (load.kind === "loading") {
    return (
      <AppShell>
        <PageContainer>
          <PageHeader kicker="Co-sign a close" title="Loading the signing request…" />
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            <Spinner size={14} /> Fetching the transaction to review.
          </div>
        </PageContainer>
      </AppShell>
    );
  }

  if (load.kind === "error") {
    return (
      <AppShell>
        <PageContainer>
          <PageHeader kicker="Co-sign a close" title="This request can't be opened" />
          <Notice tone="danger" role="alert" title="Couldn't load a valid signing request">
            {load.message} Ask the sender for a fresh link.
          </Notice>
        </PageContainer>
      </AppShell>
    );
  }

  if (inspection === null || !inspection.isClose || strayOpSources.length > 0) {
    return (
      <AppShell>
        <PageContainer>
          <PageHeader kicker="Co-sign a close" title="This request can't be verified" />
          <Notice tone="danger" role="alert" title="Not a recognizable account close">
            {strayOpSources.length > 0
              ? `Some operations act on ${strayOpSources.length === 1 ? "another account" : "other accounts"} (${strayOpSources.join(", ")}), not only the account being closed.`
              : `The transaction isn't a single account-close on ${network?.id ?? "this network"}.`}{" "}
            Don&apos;t sign it.
          </Notice>
        </PageContainer>
      </AppShell>
    );
  }

  const gone = facts.kind === "gone";
  const showSignForm = !signedHere && !thresholdMet && !gone;

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          kicker="Co-sign a close"
          title="Review, then sign"
          subtitle="You're being asked to help permanently close the account below. Check every line, then add your signature with your own wallet or key."
        />

        {envelopeError !== null ? (
          <div style={{ marginBottom: 16 }}>
            <Notice
              tone="danger"
              role="alert"
              title="Ignored an update from the relay"
              data-testid="sign-envelope-error"
            >
              {envelopeError} What you see here is still the transaction from your link.
            </Notice>
          </div>
        ) : null}

        {/* what this transaction does, decoded, never blind base64 */}
        <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
              What you&apos;re signing
            </h2>
            <Badge tone="neutral">{network?.id}</Badge>
          </div>

          <div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-3)",
                letterSpacing: "0.05em",
                marginBottom: 6,
              }}
            >
              ACCOUNT BEING CLOSED
            </div>
            <CopyableAddress
              value={inspection.source}
              label="Account"
              full
              size={12.5}
              href={explorerAccountUrl(network!, inspection.source)}
            />
          </div>

          <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
            {inspection.operations.map((op, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "12px 14px",
                  borderTop: i > 0 ? "1px solid var(--border)" : "none",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    aria-hidden
                    style={{
                      font: "600 11px/1 'Geist Mono', monospace",
                      color: "var(--fg-3)",
                      minWidth: 20,
                    }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    style={{
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: op.danger ? "var(--danger)" : "var(--fg)",
                    }}
                  >
                    {op.type}
                  </span>
                </div>
                {op.detail ? (
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--fg-2)",
                      lineHeight: 1.5,
                      paddingLeft: 28,
                    }}
                  >
                    {op.detail}
                  </span>
                ) : null}
                {op.destination ? (
                  <span style={{ paddingLeft: 28 }}>
                    <CopyableAddress
                      value={op.destination}
                      label="Destination"
                      full
                      size={11.5}
                      href={explorerAccountUrl(network!, op.destination)}
                    />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </Card>

        {/* progress */}
        {facts.kind === "gone" ? (
          <div style={{ marginTop: 16 }} data-testid="sign-closed">
            {facts.closedByThis ? (
              <Notice tone="success" role="status" title="This account was already closed">
                This account was already closed by this transaction, so no more signatures are
                needed.{" "}
                <a
                  href={explorerTxUrl(network!, planId!)}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: "var(--accent)" }}
                >
                  View the transaction
                </a>
              </Notice>
            ) : (
              <Notice tone="warning" role="status" title="This account no longer exists">
                The account no longer exists on {network?.id}, and it wasn&apos;t closed by this
                transaction. This request can no longer be submitted, so there is nothing to sign.
              </Notice>
            )}
          </div>
        ) : facts.kind === "error" ? (
          <div style={{ marginTop: 16 }}>
            <Notice tone="warning" role="status" title="Couldn't confirm the signer list">
              {facts.message} You can still sign. The relay only accepts signatures from the
              account&apos;s signers, and the progress shows up again once the account can be read.
            </Notice>
          </div>
        ) : facts.kind === "ready" ? (
          <Card
            padding={24}
            style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}
          >
            <Progress
              value={weight}
              max={facts.set.required}
              tone="accent"
              label="Signing weight collected"
              valueLabel={`${weight} of ${facts.set.required}`}
              data-testid="sign-progress"
            />
            <div
              style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}
            >
              {facts.set.signers.map((s, i) => {
                const has = signed.includes(s.key);
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
                        href={explorerAccountUrl(network!, s.key)}
                      />
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>weight {s.weight}</span>
                    {lastSigner === s.key ? <Badge tone="neutral">You</Badge> : null}
                    {has ? (
                      <Badge tone="success">Signed</Badge>
                    ) : (
                      <Badge tone="warning">Pending</Badge>
                    )}
                  </div>
                );
              })}
            </div>
            {liveInterrupted ? (
              <Notice tone="warning" role="status" title="Live updates interrupted">
                This list stopped updating on its own. New signatures from others may not be shown.
                {refreshError !== null ? (
                  <span style={{ display: "block", marginTop: 8, color: "var(--danger)" }}>
                    {refreshError}
                  </span>
                ) : null}
                <span style={{ display: "inline-block", marginTop: 10 }}>
                  <Button variant="secondary" size="sm" onClick={() => void refreshLive()}>
                    Refresh
                  </Button>
                </span>
              </Notice>
            ) : null}
          </Card>
        ) : (
          <div
            style={{
              marginTop: 16,
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            <Spinner size={14} /> Loading the signer list…
          </div>
        )}

        {/* sign, or the confirmation once signed or once enough have signed */}
        {showSignForm ? (
          <Card
            padding={24}
            style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
                Add your signature
              </h2>
              <p
                style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5 }}
              >
                Sign with your own wallet (recommended), or paste your secret key. Your key is used
                only in this browser and is never uploaded or shared.
              </p>
            </div>

            <Button
              onClick={signWithWallet}
              loading={signing}
              disabled={signing}
              data-testid="sign-wallet"
              style={{ width: "100%" }}
            >
              Connect wallet and sign
            </Button>

            {/* subtle "or" divider */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span style={{ fontSize: 11, color: "var(--fg-3)", letterSpacing: "0.06em" }}>
                OR
              </span>
              <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                {...SEED_INPUT_ATTRS}
                value={secret}
                onChange={(e) => setSecret(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") signWithSecret();
                }}
                placeholder="Paste your secret key (S…)"
                aria-label="Your signer secret key"
                aria-invalid={signError !== null}
                aria-describedby={signError !== null ? "sign-error" : undefined}
                data-testid="sign-secret"
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
                onClick={signWithSecret}
                loading={signing}
                disabled={signing || secret.trim().length === 0}
                data-testid="sign-secret-submit"
              >
                Sign
              </Button>
            </div>
            {signError !== null ? (
              <p
                id="sign-error"
                role="alert"
                style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}
              >
                {signError}
              </p>
            ) : null}
          </Card>
        ) : gone ? null : (
          <div style={{ marginTop: 16 }}>
            <Notice
              tone="success"
              role="status"
              title={signedHere ? "Your signature is in" : "Enough signatures collected"}
            >
              {thresholdMet
                ? "This close has the signing weight it needs. The person closing the account can see it and will submit the close."
                : "The person closing the account can now see your signature. It still needs more signers to reach the threshold."}
            </Notice>
          </div>
        )}
      </PageContainer>
    </AppShell>
  );
}
