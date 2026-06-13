"use client";

// legacy seed-paste path

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { SecretKeyConnector } from "@/lib/wallet/secret-key";
import { useWalletStore } from "@/stores/wallet";

export interface SecretKeyFallbackProps {
  onConnector?: (connector: SecretKeyConnector) => void;
}

export function SecretKeyFallback({ onConnector }: SecretKeyFallbackProps): React.JSX.Element {
  const setConnected = useWalletStore((s) => s.setConnected);

  const [seed, setSeed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    return () => {
      setSeed("");
    };
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setPending(true);

      // snapshot the seed locally so we can clear the input before any async runs
      // after this line the seed only exists on the connector and the local `current` variable
      const current = seed;
      setSeed("");

      try {
        const connector = new SecretKeyConnector(current);
        const publicKey = await connector.getPublicKey();
        setConnected(publicKey, "secret");
        onConnector?.(connector);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to load secret seed.";
        setError(message);
      } finally {
        setPending(false);
      }
    },
    [seed, setConnected, onConnector],
  );

  const submitDisabled = pending || seed.length === 0;

  return (
    <section
      aria-labelledby="secret-key-fallback-heading"
      data-testid="secret-key-fallback"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div
        role="alert"
        style={{
          borderRadius: 11,
          border: "1px solid color-mix(in srgb, var(--danger) 38%, transparent)",
          background: "var(--danger-soft)",
          padding: "14px 16px",
          color: "var(--danger)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <h2
          id="secret-key-fallback-heading"
          style={{
            margin: 0,
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--danger)",
            letterSpacing: "-0.005em",
          }}
        >
          Legacy / Advanced multisig — NOT recommended
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--danger)",
            opacity: 0.92,
          }}
        >
          Pasting your secret seed gives this page direct signing authority. Use a wallet extension
          (Freighter, xBull, Albedo, Rabet, Lobstr, Hana) or WalletConnect whenever possible. Only
          use this path if you understand the risks: a malicious page, a compromised browser
          extension, or a clipboard-monitoring tool can capture your seed.
        </p>
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: "var(--danger)",
            opacity: 0.78,
          }}
        >
          Your seed stays in this tab&apos;s memory only. It is never stored, transmitted, or shared
          with our server. Closing the tab discards it.
        </p>
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label
          htmlFor="secret-key-input"
          style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}
        >
          Stellar secret seed (starts with{" "}
          <code style={{ fontFamily: "'Geist Mono', ui-monospace, monospace" }}>S</code>)
        </label>
        <input
          id="secret-key-input"
          name="secret-key"
          type="password"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={seed}
          onChange={(e) => setSeed(e.currentTarget.value)}
          placeholder="S…"
          aria-describedby="secret-key-help"
          data-testid="secret-key-input"
          style={{
            height: 40,
            padding: "0 13px",
            borderRadius: 9,
            border: "1px solid var(--border-2)",
            background: "var(--surface-2)",
            color: "var(--fg)",
            fontFamily: "'Geist Mono', ui-monospace, monospace",
            fontSize: 13,
            outline: "none",
          }}
        />
        <p id="secret-key-help" style={{ margin: 0, fontSize: 11.5, color: "var(--fg-3)" }}>
          Validated locally via{" "}
          <code style={{ fontFamily: "'Geist Mono', ui-monospace, monospace" }}>
            StrKey.isValidEd25519SecretSeed
          </code>
          .
        </p>
        {error !== null ? (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitDisabled}
          data-testid="secret-key-submit"
          style={{
            height: 40,
            padding: "0 16px",
            borderRadius: 9,
            border: "1px solid color-mix(in srgb, var(--danger) 55%, transparent)",
            background: "color-mix(in srgb, var(--danger) 22%, transparent)",
            color: "var(--danger)",
            fontWeight: 600,
            fontSize: 13.5,
            cursor: submitDisabled ? "not-allowed" : "pointer",
            opacity: submitDisabled ? 0.55 : 1,
          }}
        >
          {pending ? "Loading…" : "Use secret seed (I accept the risks)"}
        </button>
      </form>
    </section>
  );
}
