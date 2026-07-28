import type { NextConfig } from "next";

// next.js configuration
const isExport = process.env.OUTPUT === "export";
const isDev = process.env.NODE_ENV !== "production";

// NOTE: the Content-Security-Policy is set per-request in `src/middleware.ts` so
// it can carry a fresh nonce (strict script-src, no 'unsafe-inline'). The static
// security headers below apply to every response.

const config: NextConfig = {
  // only set `output` for the static-export build; omitting it entirely (rather
  // than assigning undefined) satisfies exactOptionalPropertyTypes
  ...(isExport ? { output: "export" as const } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // account demolisher does not load remote images; tight allow-list
    remotePatterns: [],
  },
  async headers() {
    if (isExport) {
      // static export hosts (IPFS / fleek) deliver their own headers, and
      // middleware does not run under export, so there is no per-request CSP there
      return [];
    }
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          // HSTS is only meaningful on HTTPS; the reference deployment is served
          // by `next start` behind Caddy, which terminates TLS and enforces HTTPS
          // via ACME auto-certificates
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
