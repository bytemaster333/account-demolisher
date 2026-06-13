"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "./ThemeProvider";
import { useWalletStore } from "@/stores/wallet";

export function AppShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        backgroundImage: "var(--ambient)",
        backgroundAttachment: "fixed",
        backgroundRepeat: "no-repeat",
        color: "var(--fg)",
        position: "relative",
      }}
    >
      <Navbar />
      <main>{children}</main>
      <Footer />
    </div>
  );
}

function Navbar() {
  const pathname = usePathname();
  const { isDark, isLight, toggle } = useTheme();
  const publicKey = useWalletStore((s) => s.publicKey);
  const disconnect = useWalletStore((s) => s.disconnect);

  const isDemolish = pathname?.startsWith("/demolish") ?? false;
  const isAllowances = pathname?.startsWith("/allowances") ?? false;
  const isPlan = pathname?.startsWith("/plan") ?? false;

  const walletShort = publicKey ? `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}` : null;

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        backdropFilter: "blur(14px)",
        background: "color-mix(in srgb, var(--bg) 82%, transparent)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "0 28px",
          height: 62,
          display: "flex",
          alignItems: "center",
          gap: 22,
        }}
      >
        <Link
          href="/"
          aria-label="Home"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            textDecoration: "none",
            color: "var(--fg)",
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "var(--accent)",
              display: "grid",
              placeItems: "center",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--accent-fg)">
              <rect x="4" y="4.6" width="16" height="2.9" rx="1.45" />
              <rect x="6.7" y="10.55" width="10.6" height="2.9" rx="1.45" />
              <rect x="9.4" y="16.5" width="5.2" height="2.9" rx="1.45" />
            </svg>
          </span>
          <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.02em" }}>
            Demolisher
          </span>
        </Link>

        <nav style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
          <NavLink href="/demolish" active={isDemolish}>
            Demolish
          </NavLink>
          <NavLink href="/allowances" active={isAllowances}>
            Allowances
          </NavLink>
          <NavLink href="/plan" active={isPlan}>
            Multisig
          </NavLink>
          <a
            href="https://docs.demolisher.saliht.xyz"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "8px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              color: "var(--fg-2)",
              textDecoration: "none",
              transition: "color 120ms",
            }}
          >
            Docs
          </a>
        </nav>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <NetworkBadge />
          <a
            href="https://github.com/bytemaster333/account-demolisher"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open repository on GitHub"
            title="Open on GitHub"
            style={{
              width: 34,
              height: 34,
              display: "grid",
              placeItems: "center",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--fg-2)",
              textDecoration: "none",
            }}
          >
            <GithubIcon />
          </a>
          <button
            onClick={toggle}
            aria-label="Toggle color theme"
            style={{
              width: 34,
              height: 34,
              display: "grid",
              placeItems: "center",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--fg-2)",
              cursor: "pointer",
            }}
          >
            {isDark ? <SunIcon /> : null}
            {isLight ? <MoonIcon /> : null}
          </button>

          {publicKey ? (
            <button
              onClick={() => void disconnect()}
              title="Disconnect wallet"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                height: 34,
                padding: "0 12px",
                borderRadius: 8,
                border: "1px solid var(--border-2)",
                background: "var(--surface)",
                cursor: "pointer",
                color: "var(--fg)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--success)",
                }}
              />
              <span
                style={{
                  font: '500 12.5px/1 "Geist Mono", monospace',
                  whiteSpace: "nowrap",
                }}
              >
                {walletShort}
              </span>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--fg-3)"
                strokeWidth={2.2}
                strokeLinecap="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          ) : (
            <Link
              href="/demolish"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "none",
                background: "var(--accent)",
                color: "var(--accent-fg)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 13,
                whiteSpace: "nowrap",
                textDecoration: "none",
              }}
            >
              Connect wallet
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  readonly href: string;
  readonly active: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: "8px 12px",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 500,
        color: active ? "var(--fg)" : "var(--fg-2)",
        background: active ? "var(--surface-2)" : "transparent",
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}

function NetworkBadge() {
  // pulls from NEXT_PUBLIC_STELLAR_NETWORK at runtime via env. defaults to testnet
  const net = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet").toUpperCase();
  const dotColor =
    net === "MAINNET" ? "var(--success)" : net === "FUTURENET" ? "var(--accent)" : "var(--warning)";
  return (
    <div
      title="Active network"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        height: 32,
        padding: "0 12px",
        borderRadius: 8,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor }} />
      <span
        style={{
          font: "600 12px/1 Geist, sans-serif",
          color: "var(--fg-2)",
          letterSpacing: "0.04em",
        }}
      >
        {net}
      </span>
    </div>
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.02c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function Footer() {
  return (
    <footer
      style={{
        marginTop: 80,
        borderTop: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--bg) 90%, transparent)",
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: "0 auto",
          padding: "32px 28px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 20,
          color: "var(--fg-2)",
          fontSize: 13,
        }}
      >
        <span>open source · apache-2.0 · client-side signing · no telemetry</span>
        <div style={{ display: "flex", gap: 16 }}>
          <a
            href="https://docs.demolisher.saliht.xyz"
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--fg-2)", textDecoration: "none" }}
          >
            docs
          </a>
          <a
            href="https://github.com/bytemaster333/account-demolisher"
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--fg-2)", textDecoration: "none" }}
          >
            github
          </a>
        </div>
      </div>
    </footer>
  );
}
