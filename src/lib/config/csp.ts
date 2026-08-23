// Content-Security-Policy, applied per response by the request middleware and
// asserted by the security-headers test. script-src is 'self' + 'unsafe-inline'
// (see buildContentSecurityPolicy below for why: Next's inline hydration is not
// nonce-stamped here), NOT a per-request nonce. connect-src is sourced from
// `grep -RE "https://" src/` to cover exactly the Horizon / Soroban RPC / AMM /
// Friendbot endpoints the app talks to, for BOTH networks (one deployment serves
// testnet + mainnet), plus the WalletConnect hosts below.
export const CONNECT_SRC_ENDPOINTS = [
  "https://horizon.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://horizon-futurenet.stellar.org",
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://soroban-testnet.stellar.org",
  "https://rpc-futurenet.stellar.org",
  // RPC failover endpoints (see NetworkConfig.rpcFallbacks); discovery runs
  // client-side, so every host getRpc() may fail over to must be reachable here.
  "https://soroban-rpc.testnet.stellar.gateway.fm",
  "https://mainnet.sorobanrpc.com",
  "https://stellar.api.onfinality.io/public",
  "https://amm-api.aqua.network",
  "https://amm-api-testnet.aqua.network",
  "https://api.soroswap.finance",
  "https://friendbot.stellar.org",
  "https://friendbot-futurenet.stellar.org",
] as const;

// WalletConnect / Reown AppKit hosts. Reached only when a user picks the
// WalletConnect wallet (the relay carries the encrypted session, the api/rpc
// hosts back the modal). Listed unconditionally alongside the RPC endpoints:
// they are contacted only if WC actually runs, and one deployment serves every
// network + wallet. https AND wss variants of the relay are both required.
const WALLETCONNECT_CONNECT_SRC = [
  "https://relay.walletconnect.com",
  "https://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://rpc.walletconnect.com",
  "https://rpc.walletconnect.org",
  "https://pulse.walletconnect.com",
  "https://pulse.walletconnect.org",
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://explorer-api.walletconnect.com",
] as const;

// the AppKit "verify" security iframe origins
const WALLETCONNECT_FRAME_SRC = [
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://secure.walletconnect.com",
  "https://secure.walletconnect.org",
] as const;

// wallet logos in the picker + the AppKit modal. stellar.creit.tech serves the
// kit's own wallet-icon set (every module, WalletConnect and Ledger included).
const WALLETCONNECT_IMG_SRC = [
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://explorer-api.walletconnect.com",
  "https://imagedelivery.net",
  "https://stellar.creit.tech",
] as const;

export interface CspOptions {
  readonly isDev: boolean;
}

// Build the CSP. script-src uses 'unsafe-inline' rather than a per-request nonce:
// Next.js emits inline hydration scripts and, in this deployment, does NOT stamp
// them with the middleware nonce, so a nonce-only script-src blocks every inline
// script and hydration never runs (all interactivity dies). 'unsafe-inline' is a
// weaker posture than a nonce, but the app loads NO third-party script hosts
// (script-src stays 'self' + inline only), and the rest of the policy is intact:
// no external script origins, object-src 'none', frame-ancestors 'none',
// restricted connect-src, etc. Dev additionally needs 'unsafe-eval' + ws: for HMR.
export function buildContentSecurityPolicy({ isDev }: CspOptions): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ${isDev ? "ws: wss: " : ""}${CONNECT_SRC_ENDPOINTS.join(" ")} ${WALLETCONNECT_CONNECT_SRC.join(" ")}`,
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${isDev ? " blob:" : ""} ${WALLETCONNECT_IMG_SRC.join(" ")}`,
    `font-src 'self'${isDev ? " data:" : ""}`,
    `frame-src 'self' ${WALLETCONNECT_FRAME_SRC.join(" ")}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
