import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { NextConfig } from "next";

// next.js configuration. the only supported target is the server build
// (`next build` + `next start`): the api routes and the per-request CSP in
// src/proxy.ts need a running server, so there is no static export variant.
const isDev = process.env.NODE_ENV !== "production";

// the content-security-policy is set per request in src/proxy.ts (built in
// src/lib/config/csp.ts). script-src is 'self' plus 'unsafe-inline' rather than
// a nonce: next's inline hydration scripts are not nonce-stamped here, and a
// nonce would force every page out of static prerendering. the policy loads no
// third-party script origin, but an injected inline script could still reach
// every origin connect-src allows (horizon, soroban rpc, the walletconnect
// relay), so 'unsafe-inline' only limits where scripts load from, not where data
// can go. the static headers below apply to every response.
//
// the demolish page runs its close in an xstate actor whose execute step must
// not run twice at once. enabling cacheComponents or react <Activity> here lets
// an actor stop and restart re-invoke that step while the first run continues,
// so it needs the execute in-flight guard in
// src/lib/orchestrator/page-flow-machine.ts to be in place first.

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // /api is outside the proxy matcher, so the route handlers' own body caps
    // apply there. this bounds what next buffers for the proxy on every other
    // path (default 10 MB), a second limit behind caddy's request_body cap.
    proxyClientMaxBodySize: "32kb",
  },
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

// the slippage settings are inlined into the bundle at build time, so a bad
// value has to stop `next build` and `next dev` here, before anything compiles.
// a built server (the docker runner, the release tarball) ships without src/
// and its values are already baked into the bundle, so there is nothing left to
// check when the parser is not there.
const slippageSource = path.join(import.meta.dirname, "src/lib/safety/slippage.ts");
if (existsSync(slippageSource)) {
  const slippage = createRequire(import.meta.url)(
    slippageSource,
  ) as typeof import("./src/lib/safety/slippage");
  slippage.parseSlippageBpsEnv(process.env.NEXT_PUBLIC_SLIPPAGE_BPS);
  slippage.parseMinMarketOutEnv(process.env.NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS);
}

export default config;
