import type { NextConfig } from "next";

// next.js configuration
const isExport = process.env.OUTPUT === "export";
const isDev = process.env.NODE_ENV !== "production";

// connect-src allow-list. sourced from `grep -RE "https://" src/` to ensure
const CONNECT_SRC_ENDPOINTS = [
  "https://horizon.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://horizon-futurenet.stellar.org",
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://soroban-testnet.stellar.org",
  "https://rpc-futurenet.stellar.org",
  "https://api.refractor.space",
  "https://amm-api.aqua.network",
  "https://amm-api-testnet.aqua.network",
  "https://api.soroswap.finance",
  "https://friendbot.stellar.org",
  "https://friendbot-futurenet.stellar.org",
] as const;

const PRODUCTION_CSP = [
  "default-src 'self'",
  `connect-src 'self' ${CONNECT_SRC_ENDPOINTS.join(" ")}`,
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// dev CSP: relaxed enough for next.js HMR (inline scripts, eval, ws://) but
const DEV_CSP = [
  "default-src 'self'",
  `connect-src 'self' ws: wss: ${CONNECT_SRC_ENDPOINTS.join(" ")}`,
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  output: isExport ? "export" : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // account demolisher does not load remote images; tight allow-list
    remotePatterns: [],
  },
  async headers() {
    if (isExport) {
      // static export hosts (IPFS / fleek) deliver their own headers
      return [];
    }
    const csp = isDev ? DEV_CSP : PRODUCTION_CSP;
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // HSTS is only meaningful on HTTPS; the reference deployment is
          // vercel-hosted with TLS enforced
          ...(isDev
            ? []
            : [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]),
        ],
      },
    ];
  },
};

export default config;
