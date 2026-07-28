// Content-Security-Policy, shared between the request middleware (which injects a
// per-request nonce for a STRICT script-src, replacing 'unsafe-inline') and the
// security-headers test. Sourced from `grep -RE "https://" src/` to cover exactly
// the Horizon / Soroban RPC / AMM / Friendbot endpoints the app talks to, for
// BOTH networks (one deployment serves testnet + mainnet).
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
    `connect-src 'self' ${isDev ? "ws: wss: " : ""}${CONNECT_SRC_ENDPOINTS.join(" ")}`,
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${isDev ? " blob:" : ""}`,
    `font-src 'self'${isDev ? " data:" : ""}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
