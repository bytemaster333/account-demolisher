"use client";

// Co-signer page for a shared-account close. Someone closing a multisig account
// sends this link; it carries the reviewed transaction in the URL fragment (never
// on any server). The co-signer sees exactly what they're authorizing, signs with
// THEIR OWN wallet or key on THEIR device, and sends the signed request back (or
// submits it directly if their signature completes the threshold). No secret ever
// leaves this browser and nothing is uploaded anywhere.

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
import { explorerAccountUrl, explorerTxUrl } from "@/lib/explorer";
import {
  decodeSigningRequest,
  encodeSigningRequest,
  inspectClose,
  signedSigners,
  type CloseInspection,
} from "@/lib/multisig/signing-request";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

interface AccountFacts {
  readonly signerKeys: readonly string[];
  readonly threshold: number;
}

type Outcome =
  | { readonly kind: "none" }
  | { readonly kind: "submitting" }
  | { readonly kind: "submitted"; readonly hash: string }
  | { readonly kind: "error"; readonly message: string };

export default function SignPage(): React.JSX.Element {
  // the signing request, read from the URL fragment on mount
  const [network, setNetwork] = useState<NetworkConfig | null>(null);
  const [xdr, setXdr] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");

  // account facts (who must sign, their weights, threshold), loaded from Horizon
  const [facts, setFacts] = useState<AccountFacts | null>(null);
  const [signerWeights, setSignerWeights] = useState<Map<string, number>>(new Map());
  const [factsError, setFactsError] = useState<string | null>(null);

  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  // the key that just signed here, to flag a non-signer paste that won't count
  const [lastSigner, setLastSigner] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [copied, setCopied] = useState(false);

  const parseRequest = useCallback((raw: string): boolean => {
    // accept a full link (…/sign#<token>) or the bare token
    const token = raw.includes("#") ? raw.slice(raw.lastIndexOf("#") + 1) : raw.trim();
    const decoded = decodeSigningRequest(token);
    if (decoded === null) {
      setParseError(
        "This signing request couldn't be read. Ask the sender for a fresh link, or paste the request text.",
      );
      return false;
    }
    setNetwork(resolveNetwork(decoded.network));
    setXdr(decoded.xdr);
    setParseError(null);
    return true;
  }, []);

  // read the request from the fragment on mount. Deferred so the parse's state
  // updates land after mount rather than synchronously during the effect.
  useEffect(() => {
    const hash = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
    if (hash.length === 0) return;
    const t = setTimeout(() => parseRequest(hash), 0);
    return () => clearTimeout(t);
  }, [parseRequest]);

  const inspection: CloseInspection | null = useMemo(
    () => (network && xdr ? inspectClose(xdr, network.passphrase) : null),
    [network, xdr],
  );

  // load who must sign, their weights, and the threshold from the account being
  // closed. accountMerge is a high-threshold operation.
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

  const encodedRequest = useMemo(
    () => (network && xdr ? encodeSigningRequest({ network: network.id, xdr }) : null),
    [network, xdr],
  );
  const returnLink =
    encodedRequest !== null && typeof window !== "undefined"
      ? `${window.location.origin}/sign#${encodedRequest}`
      : null;

  // sign the current envelope with a co-signer's connector; the returned XDR
  // carries every prior signature plus the new one. `sign` produces the connector
  // from the co-signer's own wallet or key, on their device.
  const signWith = useCallback(
    async (sign: (tx: Transaction) => Promise<{ signedXdr: string; signerPublicKey: string }>) => {
      if (network === null || xdr === null) return;
      setSigning(true);
      setSignError(null);
      try {
        const tx = TransactionBuilder.fromXDR(xdr, network.passphrase) as Transaction;
        const { signedXdr, signerPublicKey } = await sign(tx);
        setXdr(signedXdr);
        setLastSigner(signerPublicKey);
      } catch (e: unknown) {
        setSignError(errorMessage(e, "Couldn't sign the transaction."));
      } finally {
        setSigning(false);
      }
    },
    [network, xdr],
  );

  const signWithWallet = useCallback(() => {
    if (network === null) return;
    void signWith(async (tx) => {
      const connector = new WalletKitConnector(network);
      await connector.connect();
      return connector.signTransaction(tx, network.passphrase);
    });
  }, [signWith, network]);

  const [secret, setSecret] = useState("");
  const signWithSecret = useCallback(() => {
    if (network === null) return;
    const seed = secret.trim();
    setSecret("");
    void signWith(async (tx) => {
      const connector = new SecretKeyConnector(seed);
      return connector.signTransaction(tx, network.passphrase);
    });
  }, [signWith, secret, network]);

  const onSubmit = useCallback(async () => {
    if (network === null || xdr === null) return;
    setOutcome({ kind: "submitting" });
    try {
      const tx = TransactionBuilder.fromXDR(xdr, network.passphrase) as Transaction;
      const res = (await getHorizon(network).submitTransaction(tx)) as { hash: string };
      setOutcome({ kind: "submitted", hash: res.hash });
    } catch (e: unknown) {
      setOutcome({ kind: "error", message: errorMessage(e, "The network rejected the transaction.") });
    }
  }, [network, xdr]);

  const onCopyReturn = useCallback(() => {
    if (returnLink === null) return;
    void navigator.clipboard?.writeText(returnLink);
    setCopied(true);
  }, [returnLink]);

  // ── render ─────────────────────────────────────────────────────────────────

  // no request yet: paste box
  if (xdr === null) {
    return (
      <AppShell>
        <PageContainer width={720}>
          <PageHeader
            kicker="Co-sign a close"
            title="Sign a shared-account close"
            subtitle="Paste the signing request you were sent, or open the link. You'll see exactly what it does before you sign anything."
          />
          <Card padding={20} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <textarea
              value={pasteValue}
              onChange={(e) => setPasteValue(e.currentTarget.value)}
              placeholder="Paste the signing request link or text…"
              spellCheck={false}
              data-testid="sign-paste"
              style={{
                minHeight: 96,
                padding: "12px 13px",
                borderRadius: 10,
                border: "1px solid var(--border-2)",
                background: "var(--surface-2)",
                color: "var(--fg)",
                font: "500 12px/1.5 'Geist Mono', monospace",
                resize: "vertical",
              }}
            />
            {parseError !== null ? (
              <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
                {parseError}
              </p>
            ) : null}
            <Button
              onClick={() => parseRequest(pasteValue)}
              disabled={pasteValue.trim().length === 0}
              data-testid="sign-load"
            >
              Load request
            </Button>
          </Card>
        </PageContainer>
      </AppShell>
    );
  }

  // request present but not a valid close
  if (inspection === null || !inspection.isClose) {
    return (
      <AppShell>
        <PageContainer width={720}>
          <PageHeader kicker="Co-sign a close" title="This request can't be verified" />
          <Notice tone="danger" role="alert" title="Not a recognizable account close">
            The request decoded, but it isn&apos;t a single account-close transaction on{" "}
            {network?.id ?? "this network"}. Don&apos;t sign it. Ask the sender to regenerate the
            request from the close flow.
          </Notice>
        </PageContainer>
      </AppShell>
    );
  }

  if (outcome.kind === "submitted") {
    return (
      <AppShell>
        <PageContainer width={720}>
          <PageHeader kicker="Co-sign a close" title="Signed and submitted" />
          <Notice tone="success" role="status" title="The account has been closed">
            Enough signatures were collected and the transaction was submitted.{" "}
            <a
              href={explorerTxUrl(network!, outcome.hash)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}
            >
              View transaction ↗
            </a>
          </Notice>
        </PageContainer>
      </AppShell>
    );
  }

  const alreadySigned = lastSigner !== null;
  const nonSigner =
    lastSigner !== null && facts !== null && !facts.signerKeys.includes(lastSigner);

  return (
    <AppShell>
      <PageContainer width={760}>
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
                    style={{
                      font: "600 11px/1 'Geist Mono', monospace",
                      color: "var(--fg-3)",
                      minWidth: 20,
                    }}
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

        {/* sign controls, or the return/submit step once signed */}
        {!alreadySigned ? (
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
          <Card padding={20} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              {thresholdMet ? "Enough signatures, ready to close" : "Your signature is in"}
            </h2>
            {thresholdMet ? (
              <>
                <p style={{ margin: 0, fontSize: 13, color: "var(--fg-2)", lineHeight: 1.55 }}>
                  This transaction now has enough weight to submit. You can close the account now, or
                  send the signed request back for someone else to submit.
                </p>
                {outcome.kind === "error" ? (
                  <p role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
                    {outcome.message}
                  </p>
                ) : null}
                <Button
                  variant="danger"
                  onClick={() => void onSubmit()}
                  loading={outcome.kind === "submitting"}
                  disabled={outcome.kind === "submitting"}
                  data-testid="sign-submit"
                >
                  Submit and close the account
                </Button>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: "var(--fg-2)", lineHeight: 1.55 }}>
                Send the updated request back to whoever is coordinating the close, or on to the next
                signer. It still needs more signing weight to reach the threshold.
              </p>
            )}

            <div>
              <div style={{ fontSize: 11.5, color: "var(--fg-3)", letterSpacing: "0.05em", marginBottom: 6 }}>
                SIGNED REQUEST TO SEND BACK
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code
                  data-testid="sign-return-link"
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
                    maxHeight: 96,
                    overflow: "auto",
                  }}
                >
                  {returnLink}
                </code>
                <Button variant="secondary" size="sm" onClick={onCopyReturn} data-testid="sign-copy-return">
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            </div>
          </Card>
        )}
      </PageContainer>
    </AppShell>
  );
}
