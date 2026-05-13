"use client";

// landing page — also mounts ConnectButton + SecretKeyFallback as a smoke-test playground

import Link from "next/link";
import { useRef, useState } from "react";

import { ConnectButton } from "@/components/wallet/ConnectButton";
import { SecretKeyFallback } from "@/components/wallet/SecretKeyFallback";
import type { WalletKitConnector } from "@/lib/wallet/connector";
import type { SecretKeyConnector } from "@/lib/wallet/secret-key";

export default function HomePage(): React.JSX.Element {
  // refs so neither connector lands in serializable state
  const kitConnectorRef = useRef<WalletKitConnector | null>(null);
  const secretConnectorRef = useRef<SecretKeyConnector | null>(null);

  const [showFallback, setShowFallback] = useState(false);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Account Demolisher</h1>
      <p className="mt-4 text-base leading-relaxed">
        A production-grade Stellar account-closure tool. Cleanly drain and merge an account across
        classic operations and Soroban DeFi positions.
      </p>

      <section className="mt-8 flex flex-col gap-4" aria-labelledby="wallet-section-heading">
        <h2 id="wallet-section-heading" className="text-xl font-semibold">
          Connect
        </h2>
        <ConnectButton
          onConnector={(c) => {
            kitConnectorRef.current = c;
          }}
        />

        <button
          type="button"
          onClick={() => setShowFallback((v) => !v)}
          className="self-start text-xs underline text-slate-600 hover:text-slate-900"
        >
          {showFallback ? "Hide" : "Show"} advanced secret-key fallback
        </button>

        {showFallback && (
          <SecretKeyFallback
            onConnector={(c) => {
              secretConnectorRef.current = c;
            }}
          />
        )}
      </section>

      <ul className="mt-12 space-y-2 text-base">
        <li>
          <Link className="underline" href="/demolish">
            Demolish an account
          </Link>{" "}
          — full closure flow (classic + Soroban + DeFi).
        </li>
        <li>
          <Link className="underline" href="/allowances">
            Allowance Viewer
          </Link>{" "}
          — view and revoke active SEP-41 token allowances.
        </li>
      </ul>
      <p className="mt-12 text-xs opacity-60">
        Open source. Apache-2.0. Client-side signing. No telemetry.
      </p>
    </main>
  );
}
