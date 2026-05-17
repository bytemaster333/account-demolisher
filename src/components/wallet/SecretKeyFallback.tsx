"use client";

// legacy seed-paste path. seed lives in local state only while typing and is cleared the
// moment a SecretKeyConnector is constructed. never written to the store, storage, urls,
// logs, or network requests.

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { cn } from "@/lib/utils";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";
import { useWalletStore } from "@/stores/wallet";

export interface SecretKeyFallbackProps {
  // receives the freshly-constructed SecretKeyConnector. parent should stash it in a useRef.
  onConnector?: (connector: SecretKeyConnector) => void;
  className?: string;
}

export function SecretKeyFallback({
  onConnector,
  className,
}: SecretKeyFallbackProps): React.JSX.Element {
  const setConnected = useWalletStore((s) => s.setConnected);

  const [seed, setSeed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // drop the seed if we unmount mid-typing
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

      // snapshot the seed locally so we can clear the input before any async runs.
      // after this line the seed only exists on the connector and the local `current` variable.
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

  return (
    <section
      className={cn("flex flex-col gap-3 rounded-md border border-red-300 p-4", className)}
      aria-labelledby="secret-key-fallback-heading"
      data-testid="secret-key-fallback"
    >
      <div
        role="alert"
        className="rounded-sm border border-red-400 bg-red-50 p-3 text-sm text-red-900"
      >
        <h2 id="secret-key-fallback-heading" className="font-semibold">
          Legacy / Advanced multisig — NOT recommended
        </h2>
        <p className="mt-1 leading-snug">
          Pasting your secret seed gives this page direct signing authority. Use a wallet extension
          (Freighter, xBull, Albedo, Rabet, Lobstr, Hana) or WalletConnect whenever possible. Only
          use this path if you understand the risks: a malicious page, a compromised browser
          extension, or a clipboard-monitoring tool can capture your seed.
        </p>
        <p className="mt-2 leading-snug">
          Your seed stays in this tab&apos;s memory only. It is never stored, transmitted, or shared
          with our server. Closing the tab discards it.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <label htmlFor="secret-key-input" className="text-sm font-medium">
          Stellar secret seed (starts with <code className="font-mono">S</code>)
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
          className={cn(
            "rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          )}
        />
        <p id="secret-key-help" className="text-xs text-slate-600">
          Validated locally via <code className="font-mono">StrKey.isValidEd25519SecretSeed</code>.
        </p>
        {error !== null && (
          <p role="alert" className="text-xs text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || seed.length === 0}
          data-testid="secret-key-submit"
          className={cn(
            "inline-flex items-center justify-center rounded-md px-4 py-2",
            "text-sm font-medium transition-colors",
            "bg-red-700 text-white hover:bg-red-800",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {pending ? "Loading…" : "Use secret seed (I accept the risks)"}
        </button>
      </form>
    </section>
  );
}
