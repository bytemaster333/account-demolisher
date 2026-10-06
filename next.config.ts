import type { NextConfig } from "next";

// next.js configuration. the only supported target is the server build
// (`next build` + `next start`): the api routes and the per-request CSP in
// src/proxy.ts need a running server, so there is no static export variant.
const isDev = process.env.NODE_ENV !== "production";

// NOTE: the Content-Security-Policy is set per-request in `src/proxy.ts`
// (source of truth: src/lib/config/csp.ts). script-src is 'self' + 'unsafe-inline'
// rather than a per-request nonce: Next's inline hydration scripts are not
// nonce-stamped here, and a nonce would also force every page out of static
// prerendering (undesirable for CDN serving). The policy loads NO third-party
// script origin and locks default-src/object-src/frame-ancestors/base-uri, so the
// residual risk of 'unsafe-inline' is bounded. The static headers below apply to
// every response.

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pin the workspace root to this directory. a parent-level lockfile (the docs
  // app / a monorepo checkout) would otherwise make Next infer the parent as the
  // root and mis-resolve file tracing.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  images: {
    // account demolisher does not use next/image, so the optimizer is turned off:
    // /_next/image answers 404 instead of exposing an image endpoint nothing needs
    unoptimized: true,
    // and no remote image origin is allowed either way
    remotePatterns: [],
  },
  // serve the SEP-1 stellar.toml at its canonical well-known path
  async rewrites() {
    return [{ source: "/.well-known/stellar.toml", destination: "/stellar.toml" }];
  },
  async headers() {
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
      {
        // SEP-1 requires the stellar.toml to be CORS-readable and served as TOML
        source: "/.well-known/stellar.toml",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "text/plain; charset=utf-8" },
        ],
      },
    ];
  },
};

export default config;
