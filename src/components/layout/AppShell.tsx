"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Select } from "@/components/ui";
import { useTheme } from "./ThemeProvider";
import { resolveNetwork, type NetworkConfig, type StellarNetwork } from "@/lib/config/networks";
import { explorerAccountUrl } from "@/lib/explorer";
import { disconnectSession, setActiveConnector } from "@/lib/wallet/active-connector";
import { WalletKitConnector } from "@/lib/wallet/connector";
import { useNetworkStore } from "@/stores/network";
import { useWalletStore } from "@/stores/wallet";

export function AppShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        backgroundImage: "var(--ambient)",
        backgroundAttachment: "fixed",
        backgroundRepeat: "no-repeat",
        color: "var(--fg)",
        position: "relative",
      }}
    >
      <Navbar />
      {/* flex:1 pins the footer to the viewport bottom so it doesn't float at a
          different height on short vs tall steps */}
      <main style={{ flex: 1 }}>{children}</main>
      <Footer />
    </div>
  );
}

function Navbar() {
  const pathname = usePathname();
  const { isDark, isLight, toggle } = useTheme();
  const publicKey = useWalletStore((s) => s.publicKey);
  const disconnect = useWalletStore((s) => s.disconnect);
  const setConnected = useWalletStore((s) => s.setConnected);
  const networkId = useNetworkStore((s) => s.networkId);
  const network = useMemo(() => resolveNetwork(networkId), [networkId]);

  const isDemolish = pathname?.startsWith("/demolish") ?? false;
  const isAllowances = pathname?.startsWith("/allowances") ?? false;
  const isLanding = pathname === "/";

  // Connect the wallet in place from the header (shares the connector app-wide so
  // any page can sign). On the landing page we keep the original "start here"
  // link into the close flow (that page is design-frozen); on the demolish page
  // the Connect step already owns connecting, so the header shows no button
  // there. Everywhere else (allowances, sign) this is the connect entry point.
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const onConnect = useCallback(async () => {
    setConnectError(null);
    setConnecting(true);
    try {
      const connector = new WalletKitConnector(network);
      const { publicKey: address } = await connector.connect();
      setActiveConnector(connector);
      setConnected(address, "kit");
    } catch {
      setConnectError(
        "Couldn't connect to your wallet. Make sure the wallet extension is installed and unlocked, then try again.",
      );
    } finally {
      setConnecting(false);
    }
  }, [network, setConnected]);

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
          <NetworkSwitcher />
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
            <WalletMenu publicKey={publicKey} network={network} onDisconnect={disconnect} />
          ) : isLanding ? (
            // design-frozen landing keeps its original "start the close flow" CTA
            <Link
              href="/demolish"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 34,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid var(--accent-line)",
                background: "transparent",
                color: "var(--accent)",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 13,
                whiteSpace: "nowrap",
                textDecoration: "none",
              }}
            >
              Connect wallet
            </Link>
          ) : (
            // every non-landing page (demolish, allowances, sign): connect in
            // place. The top-right wallet slot is ALWAYS present so its state is
            // predictable: "Connect wallet" when disconnected, the address chip
            // (with Disconnect) when connected. Never an empty dead-zone.
            <div style={{ position: "relative", display: "flex" }}>
              <button
                type="button"
                onClick={() => void onConnect()}
                disabled={connecting}
                data-testid="header-connect"
                aria-label="Connect wallet: this only shares your public address, never your secret key"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  height: 34,
                  padding: "0 14px",
                  borderRadius: 8,
                  border: "1px solid var(--accent-line)",
                  background: "transparent",
                  color: "var(--accent)",
                  cursor: connecting ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  fontSize: 13,
                  whiteSpace: "nowrap",
                  opacity: connecting ? 0.6 : 1,
                }}
              >
                {connecting ? "Connecting…" : "Connect wallet"}
              </button>
              {connectError ? (
                <span
                  role="alert"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    right: 0,
                    width: 240,
                    fontSize: 11.5,
                    lineHeight: 1.45,
                    color: "var(--fg-2)",
                    background: "var(--surface)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 9,
                    padding: "8px 11px",
                    boxShadow: "var(--shadow)",
                    zIndex: 50,
                    whiteSpace: "normal",
                  }}
                >
                  {connectError}
                </span>
              ) : null}
            </div>
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

// Connected-wallet control: the address chip opens a menu (the chevron finally
// means something) with copy, explorer, and an explicit Disconnect. Disconnect
// routes through disconnectSession so the kit, connector, and store all clear.
function WalletMenu({
  publicKey,
  network,
  onDisconnect,
}: {
  readonly publicKey: string;
  readonly network: NetworkConfig;
  readonly onDisconnect: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const short = `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(publicKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [publicKey]);

  const onDisconnectClick = useCallback(() => {
    setOpen(false);
    void disconnectSession(onDisconnect);
  }, [onDisconnect]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Wallet connected as ${publicKey}. Open wallet menu.`}
        data-testid="wallet-menu-trigger"
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
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }}
        />
        <span style={{ font: '500 12.5px/1 "Geist Mono", monospace', whiteSpace: "nowrap" }}>
          {short}
        </span>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--fg-3)"
          strokeWidth={2.2}
          strokeLinecap="round"
          aria-hidden
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .12s" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 230,
            zIndex: 60,
            padding: 6,
            borderRadius: 11,
            background: "var(--surface)",
            border: "1px solid var(--border-2)",
            boxShadow: "var(--shadow)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            animation: "fadeUp .12s ease",
          }}
        >
          <div
            style={{
              padding: "7px 9px 9px",
              borderBottom: "1px solid var(--border)",
              marginBottom: 4,
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--fg-3)",
                marginBottom: 5,
              }}
            >
              Connected
            </div>
            <div
              style={{
                font: '500 12px/1.4 "Geist Mono", monospace',
                color: "var(--fg-2)",
                wordBreak: "break-all",
              }}
            >
              {publicKey}
            </div>
          </div>
          <MenuItem onClick={onCopy} testId="wallet-copy-address">
            {copied ? "Copied" : "Copy address"}
          </MenuItem>
          <MenuItem href={explorerAccountUrl(network, publicKey)} onClick={() => setOpen(false)}>
            View on explorer
          </MenuItem>
          <MenuItem onClick={onDisconnectClick} tone="danger" testId="wallet-disconnect">
            Disconnect
          </MenuItem>
        </div>
      ) : null}
    </div>
  );
}

const MENU_ITEM_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: "8px 9px",
  borderRadius: 7,
  border: "none",
  background: "transparent",
  font: "500 13px/1 Geist, sans-serif",
  textAlign: "left",
  textDecoration: "none",
  cursor: "pointer",
};

function MenuItem({
  onClick,
  href,
  children,
  tone,
  testId,
}: {
  readonly onClick: () => void;
  readonly href?: string;
  readonly children: React.ReactNode;
  readonly tone?: "danger";
  readonly testId?: string;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = {
    ...MENU_ITEM_BASE,
    color: tone === "danger" ? "var(--danger)" : "var(--fg)",
    background: hover ? "var(--surface-2)" : "transparent",
  };
  const shared = {
    role: "menuitem" as const,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    "data-testid": testId,
    style,
  };
  if (href !== undefined) {
    return (
      <a {...shared} href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>
        {children}
      </a>
    );
  }
  return (
    <button {...shared} type="button" onClick={onClick}>
      {children}
    </button>
  );
}

const NETWORK_STORAGE_KEY = "demolisher.network";

function NetworkSwitcher() {
  const networkId = useNetworkStore((s) => s.networkId);
  const setNetwork = useNetworkStore((s) => s.setNetwork);
  const disconnect = useWalletStore((s) => s.disconnect);

  // hydrate the saved choice on the client (store initialises from env for SSR)
  useEffect(() => {
    const stored = window.localStorage.getItem(NETWORK_STORAGE_KEY);
    if ((stored === "mainnet" || stored === "testnet") && stored !== networkId) {
      setNetwork(stored);
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = (id: StellarNetwork): void => {
    if (id === networkId) return;
    setNetwork(id);
    try {
      window.localStorage.setItem(NETWORK_STORAGE_KEY, id);
    } catch {
      // storage disabled; selection still applies for this session
    }
    // a connected account is network-scoped; changing network invalidates it.
    // Full teardown (connector + kit + store), not just the store, so the wallet
    // extension doesn't stay authorized to the old network's session.
    void disconnectSession(disconnect);
  };

  const label = (net: StellarNetwork): React.JSX.Element => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: net === "mainnet" ? "var(--success)" : "var(--warning)",
          flexShrink: 0,
        }}
      />
      <span style={{ letterSpacing: "0.04em", fontWeight: 600, fontSize: 12 }}>
        {net === "mainnet" ? "MAINNET" : "TESTNET"}
      </span>
    </span>
  );

  return (
    <Select
      size="sm"
      ariaLabel="Select network"
      value={networkId === "mainnet" ? "mainnet" : "testnet"}
      onChange={(v) => onChange(v as StellarNetwork)}
      options={[
        { value: "testnet", label: label("testnet") },
        { value: "mainnet", label: label("mainnet") },
      ]}
    />
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
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.02c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.05 11.05 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.62 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function Footer() {
  return (
    <footer
      style={{
        marginTop: 56,
        borderTop: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--bg) 90%, transparent)",
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 28px 22px" }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: 40,
          }}
        >
          {/* brand + description */}
          <div style={{ maxWidth: 360 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
              <span
                aria-hidden
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: "var(--accent)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="var(--accent-fg)">
                  <rect x="4" y="4.6" width="16" height="2.9" rx="1.45" />
                  <rect x="6.7" y="10.55" width="10.6" height="2.9" rx="1.45" />
                  <rect x="9.4" y="16.5" width="5.2" height="2.9" rx="1.45" />
                </svg>
              </span>
              <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.02em" }}>
                Demolisher
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--fg-3)" }}>
              Close a Stellar account safely, and send everything to a destination you choose.
              Signed entirely in your browser.
            </p>
          </div>

          {/* link groups */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 56 }}>
            <FooterColumn title="Product">
              <FooterLink href="/demolish">Close an account</FooterLink>
              <FooterLink href="/allowances">Allowances</FooterLink>
            </FooterColumn>
            <FooterColumn title="Resources">
              <FooterLink href="https://docs.demolisher.saliht.xyz" external>
                Documentation
              </FooterLink>
              <FooterLink href="https://github.com/bytemaster333/account-demolisher" external>
                Source code
              </FooterLink>
            </FooterColumn>
          </div>
        </div>

        {/* bottom bar */}
        <div
          style={{
            marginTop: 22,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span style={{ fontSize: 12.5, color: "var(--fg-3)" }}>
            © {new Date().getFullYear()} Demolisher · Apache-2.0 licensed
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--fg-3)",
        }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

function FooterLink({
  href,
  external = false,
  children,
}: {
  readonly href: string;
  readonly external?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const style: React.CSSProperties = {
    fontSize: 13,
    color: "var(--fg-2)",
    textDecoration: "none",
  };
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" style={style}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} style={style}>
      {children}
    </Link>
  );
}
