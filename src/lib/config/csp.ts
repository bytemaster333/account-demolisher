// Content-Security-Policy, set on every document response by src/proxy.ts and
// asserted by the security-headers test. script-src is 'self' + 'unsafe-inline'
// (see buildContentSecurityPolicy below), not a per-request nonce.
//
// connect-src is the set of hosts the browser talks to directly. the network
// part is derived from NETWORKS so it can't drift from the endpoints the app
// actually uses (Horizon, Soroban RPC and its failovers, friendbot).

import { NETWORKS } from "@/lib/config/networks";

function originOf(url: string): string {
  const u = new URL(url);
  // keep a path when the endpoint lives under one (onfinality's /public)
  return u.pathname === "/" ? u.origin : `${u.origin}${u.pathname.replace(/\/$/, "")}`;
}

export function networkEndpoints(): readonly string[] {
  const out = new Set<string>();
  for (const net of Object.values(NETWORKS)) {
    out.add(originOf(net.horizon));
    out.add(originOf(net.rpc));
    for (const fallback of net.rpcFallbacks ?? []) out.add(originOf(fallback));
    if (net.friendbot !== null) out.add(originOf(net.friendbot));
  }
  return [...out];
}

// the AMM REST backends the browser reads pool data from
const AMM_CONNECT_SRC = [
  "https://amm-api.aqua.network",
  "https://amm-api-testnet.aqua.network",
] as const;

// WalletConnect / Reown AppKit hosts. reached only when a user picks the
// WalletConnect wallet, signs with a restored WalletConnect session, or
// disconnects or closes a restored session (src/lib/wallet/kit.ts builds the
// module lazily). the relay carries the encrypted session, the api/rpc hosts
// back the modal, and verify answers the domain-verification fetches from
// @walletconnect/core. https and wss variants of the relay are both required.
// pulse.walletconnect.* is left out on purpose: it only receives telemetry, and
// AppKit sends its INITIALIZE and CONNECT_SUCCESS events even with analytics
// off, so the policy blocks them.
const WALLETCONNECT_CONNECT_SRC = [
  "https://relay.walletconnect.com",
  "https://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://rpc.walletconnect.com",
  "https://rpc.walletconnect.org",
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://explorer-api.walletconnect.com",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
] as const;

// the AppKit "verify" security iframe origins
const WALLETCONNECT_FRAME_SRC = [
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://secure.walletconnect.com",
  "https://secure.walletconnect.org",
] as const;

// wallet logos in the picker and the AppKit modal. stellar.creit.tech serves the
// kit's own icon set; OneKey and Scopuly load their icons from their own hosts
// (onekey.module.js and scopuly.module.js in stellar-wallets-kit 2.7).
export const WALLET_IMG_SRC = [
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://explorer-api.walletconnect.com",
  "https://imagedelivery.net",
  "https://stellar.creit.tech",
  "https://uni.onekey-asset.com",
  "https://scopuly.com",
] as const;

// the AppKit modal's typeface (@reown/appkit-ui ThemeUtil)
const WALLETCONNECT_FONT_SRC = ["https://fonts.reown.com"] as const;

export interface CspOptions {
  readonly isDev: boolean;
}

// script-src uses 'unsafe-inline' rather than a per-request nonce: Next emits
// inline hydration scripts and does not stamp them with a nonce in this setup,
// so a nonce-only script-src would block hydration. what that leaves open: an
// injected inline script would run, and connect-src still allows Horizon (which
// accepts any signed transaction) and the WalletConnect relay, so a script
// injection is not contained by this policy. what stays closed: no third-party
// script origin, object-src 'none', frame-ancestors 'none', base-uri and
// form-action 'self'. dev additionally needs 'unsafe-eval' and ws: for HMR.
export function buildContentSecurityPolicy({ isDev }: CspOptions): string {
  const connect = [...networkEndpoints(), ...AMM_CONNECT_SRC, ...WALLETCONNECT_CONNECT_SRC];
  return [
    "default-src 'self'",
    `connect-src 'self' ${isDev ? "ws: wss: " : ""}${connect.join(" ")}`,
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${isDev ? " blob:" : ""} ${WALLET_IMG_SRC.join(" ")}`,
    `font-src 'self'${isDev ? " data:" : ""} ${WALLETCONNECT_FONT_SRC.join(" ")}`,
    `frame-src 'self' ${WALLETCONNECT_FRAME_SRC.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
