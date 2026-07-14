"use client";

// Co-signer page for a shared-account close. Someone closing a multisig account
// sends a short link (/sign?id=<hash>). This page fetches the transaction from
// the relay, verifies its hash matches the id in the link (so a tampered server
// can't swap in a different transaction), shows the co-signer exactly what they're
// authorizing, and lets them sign with THEIR OWN wallet or key. The signature is
// posted back to the relay so the person closing the account sees it instantly.
// No secret ever leaves this browser; co-signers sign, they don't submit.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/layout/AppShell";
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
import { resolveNetwork, type NetworkConfig } from "@/lib/config/networks";
import { errorMessage } from "@/lib/errors";
import { explorerAccountUrl } from "@/lib/explorer";
import { fetchPlan, submitSignature, subscribePlan } from "@/lib/multisig/plan-client";
import { inspectClose, signedSigners, type CloseInspection } from "@/lib/multisig/signing-request";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

interface AccountFacts {
  readonly signerKeys: readonly string[];
  readonly threshold: number;
}

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly network: NetworkConfig; readonly xdr: string };

function idFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("id");
  } catch {
    return null;
  }
}

export default function SignPage(): React.JSX.Element {
  const [planId, setPlanId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [xdr, setXdr] = useState<string | null>(null);

  const [facts, setFacts] = useState<AccountFacts | null>(null);
  const [signerWeights, setSignerWeights] = useState<Map<string, number>>(new Map());
  const [factsError, setFactsError] = useState<string | null>(null);

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signedHere, setSignedHere] = useState(false);
  const [lastSigner, setLastSigner] = useState<string | null>(null);
  const [secret, setSecret] = useState("");

  const network = load.kind === "ready" ? load.network : null;

  // read the id and fetch the transaction; verify its hash matches the id so a
  // tampered server can't substitute a different transaction.
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
        const hash = Buffer.from(
          (TransactionBuilder.fromXDR(plan.xdr, net.passphrase) as Transaction).hash(),
        ).toString("hex");
        if (hash !== id) {
          setLoad({
            kind: "error",
            message: "This request couldn't be verified (its transaction doesn't match the link).",
          });
          return;
        }
        setXdr(plan.xdr);
        setLoad({ kind: "ready", network: net, xdr: plan.xdr });
      } catch (e: unknown) {
        if (!cancelled)
          setLoad({ kind: "error", message: errorMessage(e, "Couldn't load this signing request.") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // live progress: reflect signatures other co-signers add
  useEffect(() => {
    if (planId === null || load.kind !== "ready") return;
    const unsubscribe = subscribePlan(planId, (plan) => setXdr(plan.xdr));
    return unsubscribe;
  }, [planId, load.kind]);

  const inspection: CloseInspection | null = useMemo(
    () => (network && xdr ? inspectClose(xdr, network.passphrase) : null),
    [network, xdr],
  );

  // load who must sign, weights, and threshold from the account being closed
  useEffect(() => {
    if (network === null || inspection === null || inspection.source.length === 0) return;
    let cancelled = false;
    void (async () => {
      setFactsError(null);
      try {
        const acct = await getHorizon(network).loadAccount(inspection.source);
        if (cancelled) return;
        const signerKeys = acct.signers
          .filter((s) => s.type === "ed25519_public_key" && s.weight > 0)
          .map((s) => s.key);
        setFacts({ signerKeys, threshold: Math.max(1, acct.thresholds.high_threshold) });
        setSignerWeights(new Map(acct.signers.map((s) => [s.key, s.weight])));
      } catch (e: unknown) {
        if (!cancelled)
          setFactsError(errorMessage(e, "Couldn't load this account from the network."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, inspection]);

  const signed = useMemo(
    () => (network && xdr && facts ? signedSigners(xdr, network.passphrase, facts.signerKeys) : []),
    [network, xdr, facts],
  );
  const weight = useMemo(
    () => signed.reduce((sum, k) => sum + (signerWeights.get(k) ?? 0), 0),
    [signed, signerWeights],
  );
  const thresholdMet = facts !== null && weight >= facts.threshold;

  // sign with the co-signer's own connector, then post the signature to the relay
  const signWith = useCallback(
    async (sign: (tx: Transaction) => Promise<{ signedXdr: string; signerPublicKey: string }>) => {
      if (network === null || xdr === null || planId === null) return;
      setSigning(true);
      setSignError(null);
      try {
        const tx = TransactionBuilder.fromXDR(xdr, network.passphrase) as Transaction;
        const { signedXdr, signerPublicKey } = await sign(tx);
        const merged = await submitSignature(planId, signedXdr);
        setXdr(merged.xdr);
        setLastSigner(signerPublicKey);
        setSignedHere(true);
      } catch (e: unknown) {
        setSignError(errorMessage(e, "Couldn't sign the transaction."));
      } finally {
        setSigning(false);
      }
    },
    [network, xdr, planId],
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
          <div style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--fg-2)" }}>
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

  if (inspection === null || !inspection.isClose) {
    return (
      <AppShell>
        <PageContainer>
          <PageHeader kicker="Co-sign a close" title="This request can't be verified" />
          <Notice tone="danger" role="alert" title="Not a recognizable account close">
            The transaction isn&apos;t a single account-close on {network?.id ?? "this network"}.
            Don&apos;t sign it.
          </Notice>
        </PageContainer>
      </AppShell>
    );
  }

  const nonSigner = lastSigner !== null && facts !== null && !facts.signerKeys.includes(lastSigner);

  return (
    <AppShell>
      <PageContainer>
        <PageHeader
          kicker="Co-sign a close"
          title="Review, then sign"
          subtitle="You're being asked to help permanently close the account below. Check every line, then add your signature with your own wallet or key."
        />

        {/* what this transaction does, decoded, never blind base64 */}
        <Card padding={22} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>What you&apos;re signing</h2>
            <Badge tone="neutral">{network?.id}</Badge>
          </div>

          <div>
            <div style={{ fontSize: 11.5, color: "var(--fg-3)", letterSpacing: "0.05em", marginBottom: 6 }}>
              ACCOUNT BEING CLOSED
            </div>
            <CopyableAddress
              value={inspection.source}
              label="Account"
              head={8}
              tail={6}
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
                    style={{ font: "600 11px/1 'Geist Mono', monospace", color: "var(--fg-3)", minWidth: 20 }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: op.danger ? "var(--danger)" : "var(--fg)" }}>
                    {op.type}
                  </span>
                </div>
                {op.detail ? (
                  <span style={{ fontSize: 12.5, color: "var(--fg-2)", lineHeight: 1.5, paddingLeft: 28 }}>
                    {op.detail}
                  </span>
                ) : null}
                {op.destination ? (
                  <span style={{ paddingLeft: 28 }}>
                    <CopyableAddress
                      value={op.destination}
                      label="Destination"
                      head={8}
                      tail={6}
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
        {factsError !== null ? (
          <div style={{ marginTop: 16 }}>
            <Notice tone="warning" role="status" title="Couldn't confirm the signer list">
              {factsError} You can still sign; your signature will count once the account is
              reachable.
            </Notice>
          </div>
        ) : facts !== null ? (
          <Card padding={20} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <Progress
              value={weight}
              max={facts.threshold}
              tone="accent"
              label="Signing weight collected"
              valueLabel={`${weight} of ${facts.threshold}`}
              data-testid="sign-progress"
            />
            <div style={{ border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
              {facts.signerKeys.map((key, i) => {
                const has = signed.includes(key);
                return (
                  <div
                    key={key}
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
                        value={key}
                        label="Signer"
                        head={8}
                        tail={6}
                        size={12}
                        href={explorerAccountUrl(network!, key)}
                      />
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
                      weight {signerWeights.get(key) ?? "—"}
                    </span>
                    {has ? <Badge tone="success">Signed</Badge> : <Badge tone="warning">Pending</Badge>}
                  </div>
                );
              })}
            </div>
          </Card>
        ) : (
          <div style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 9, fontSize: 13, color: "var(--fg-2)" }}>
            <Spinner size={14} /> Loading the signer list…
          </div>
        )}

        {nonSigner ? (
          <div style={{ marginTop: 16 }}>
            <Notice tone="warning" role="alert" title="This key isn't a signer on the account">
              The key you just signed with isn&apos;t authorized on this account, so its signature
              won&apos;t count toward the threshold. Sign with one of the keys listed above.
            </Notice>
          </div>
        ) : null}

        {/* sign, or the confirmation once signed */}
        {!signedHere ? (
          <Card padding={20} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Add your signature</h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button onClick={signWithWallet} loading={signing} disabled={signing} data-testid="sign-wallet">
                Connect wallet and sign
              </Button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") signWithSecret();
                }}
                placeholder="…or paste your secret key (S…)"
                aria-label="Your signer secret key"
                autoComplete="off"
                spellCheck={false}
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
            <p style={{ margin: 0, fontSize: 11.5, color: "var(--fg-3)", lineHeight: 1.5 }}>
              Your key is used only in this browser to sign, and is never uploaded or shared.
            </p>
            {signError !== null ? (
              <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
                {signError}
              </p>
            ) : null}
          </Card>
        ) : (
          <div style={{ marginTop: 16 }}>
            <Notice tone="success" role="status" title="Your signature is in">
              {thresholdMet
                ? "This close now has enough signatures. The person closing the account can see it and will submit it."
                : "The person closing the account can now see your signature. It still needs more signers to reach the threshold."}
            </Notice>
          </div>
        )}
      </PageContainer>
    </AppShell>
  );
}
