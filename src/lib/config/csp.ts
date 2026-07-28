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
  "https://amm-api.aqua.network",
  "https://amm-api-testnet.aqua.network",
  "https://api.soroswap.finance",
  "https://friendbot.stellar.org",
  "https://friendbot-futurenet.stellar.org",
] as const;

export interface CspOptions {
  readonly nonce: string;
  readonly isDev: boolean;
}

// Build the CSP for one request. The per-request `nonce` gates inline scripts, so
// 'unsafe-inline' is NOT present in script-src (the SEC-18 fix). Dev additionally
// needs 'unsafe-eval' + ws: for Next's HMR.
export function buildContentSecurityPolicy({ nonce, isDev }: CspOptions): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ${isDev ? "ws: wss: " : ""}${CONNECT_SRC_ENDPOINTS.join(" ")}`,
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    // styles only: Next injects inline <style> tags; inline STYLE is far lower risk
    // than inline SCRIPT (which the nonce now gates), and nonce-ing every style is
    // impractical, so 'unsafe-inline' is scoped to style-src alone.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${isDev ? " blob:" : ""}`,
    `font-src 'self'${isDev ? " data:" : ""}`,
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
