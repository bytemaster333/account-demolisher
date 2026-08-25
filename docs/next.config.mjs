import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// the docs were reorganised into /docs/users/* and /docs/developers/*. these keep
// every previously published URL resolving, including the ones baked into the app's
// own footer and landing page.
const legacyRedirects = [
  ["/docs/getting-started", "/docs/users/connect-your-wallet"],
  ["/docs/how-it-works", "/docs/developers/concepts/closure-lifecycle"],
  ["/docs/destinations-and-mediator", "/docs/users/send-to-an-exchange"],
  ["/docs/security", "/docs/developers/security/model"],
  ["/docs/allowance-viewer", "/docs/users/revoke-token-allowances"],
  ["/docs/self-host", "/docs/developers/operations/self-hosting"],
  ["/docs/demo-account", "/docs/users/try-it-on-testnet"],
  ["/docs/multisig", "/docs/users/close-a-shared-account"],
  ["/docs/integrators", "/docs/developers/protocol/exchange-integration"],
  ["/docs/faq", "/docs/users/faq"],
  ["/docs/audit", "/docs/developers/security/model"],
];

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // this docs app sits next to the main app (two lockfiles), so Next would
  // otherwise infer the parent as the workspace root and try to compile the main
  // app's source. pin the root to this directory.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  async redirects() {
    return [
      {
        source: "/",
        destination: "/docs",
        permanent: false,
      },
      ...legacyRedirects.map(([source, destination]) => ({
        source,
        destination,
        permanent: true,
      })),
    ];
  },
};

export default withMDX(config);
