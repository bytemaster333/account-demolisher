"use client";

// legacy seed-paste path

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { SecretKeyConnector } from "@/lib/wallet/secret-key";
import { setActiveConnector } from "@/lib/wallet/active-connector";
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
        // share the live connector app-wide so other pages (e.g. /allowances)
        // can sign with it after a client-side navigation. The seed stays inside
        // the connector; nothing serializable leaves this module.
        setActiveConnector(connector);
        setConnected(publicKey, "secret");
        onConnector?.(connector);
      } catch {
        // any failure here means the pasted value couldn't be used as a key;
        // show a plain, actionable message instead of a raw library error
        setError(
          "That doesn't look like a valid Stellar secret key. It should start with 'S' and be 56 characters.",
        );
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
          background: "var(--surface-2)",
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
          Not recommended
        </h2>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "var(--fg-2)" }}>
          Anyone who has this key controls the account and can move or steal all its funds. Only
          paste it if you trust this device and no one can see your screen.
        </p>
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label
          htmlFor="secret-key-input"
          style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}
        >
          Stellar secret key (starts with{" "}
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
          We only check the format on your device — the key is never uploaded.
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
            background: "transparent",
            color: "var(--danger)",
            fontWeight: 600,
            fontSize: 13.5,
            cursor: submitDisabled ? "not-allowed" : "pointer",
            opacity: submitDisabled ? 0.55 : 1,
          }}
        >
          {pending ? "Loading…" : "Continue with secret key"}
        </button>
      </form>
    </section>
  );
}
