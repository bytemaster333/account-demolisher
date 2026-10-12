import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";
import { getMiddlewareRouteMatcher } from "next/dist/shared/lib/router/utils/middleware-route-matcher";
import { describe, it, expect } from "vitest";

import nextConfig from "../../next.config";
import { buildContentSecurityPolicy } from "@/lib/config/csp";
import { NETWORKS } from "@/lib/config/networks";
import { config as proxyConfig } from "@/proxy";

// Locks in that next.config emits the static hardening headers, and that the
// CSP (set by src/proxy.ts) is locked down: no third-party script
// origins, no 'unsafe-eval' in prod, object-src/frame-ancestors/base-uri closed,
// both networks allow-listed. script-src carries 'unsafe-inline' by design (Next
// inline hydration is not nonce-stamped here); these tests assert that posture.
describe("security headers (next.config)", () => {
  it("emits the static hardening headers for every route", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers!();

    const global = rules.find((r) => r.source === "/(.*)")!;
    expect(global).toBeDefined();

    const byKey: Record<string, string> = {};
    for (const h of global.headers) byKey[h.key] = String(h.value);

    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("no-referrer");
    expect(byKey["Permissions-Policy"]).toBeDefined();
  });

  it("serves the well-known stellar.toml CORS-readable as TOML", async () => {
    const rules = await nextConfig.headers!();
    const wellKnown = rules.find((r) => r.source === "/.well-known/stellar.toml")!;
    expect(wellKnown).toBeDefined();
    const byKey: Record<string, string> = {};
    for (const h of wellKnown.headers) byKey[h.key] = String(h.value);
    expect(byKey["Access-Control-Allow-Origin"]).toBe("*");
    expect(byKey["Content-Type"]).toMatch(/text\/plain/);
  });
});

describe("Content-Security-Policy", () => {
  it("prod script-src is 'self' + inline (needed for Next hydration) with NO 'unsafe-eval'", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    // no arbitrary eval in prod, and no third-party script origins
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("http");
  });

  it("allow-lists both networks and locks down frame/object/base", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("https://horizon.stellar.org");
    expect(csp).toContain("https://horizon-testnet.stellar.org");
    expect(csp).toContain("https://soroban-rpc.mainnet.stellar.gateway.fm");
    expect(csp).toContain("https://soroban-testnet.stellar.org");
  });

  it("allow-lists every RPC failover endpoint (discovery runs client-side)", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });
    // testnet fallback
    expect(csp).toContain("https://soroban-rpc.testnet.stellar.gateway.fm");
    // mainnet fallbacks
    expect(csp).toContain("https://mainnet.sorobanrpc.com");
    expect(csp).toContain("https://stellar.api.onfinality.io/public");
  });

  it("relaxes ONLY dev for Next HMR (unsafe-eval + ws)", () => {
    const dev = buildContentSecurityPolicy({ isDev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws:");
  });

  it("allows every endpoint in NETWORKS in connect-src", () => {
    const connect = directive(buildContentSecurityPolicy({ isDev: false }), "connect-src");
    for (const net of Object.values(NETWORKS)) {
      const urls = [net.horizon, net.rpc, ...(net.rpcFallbacks ?? [])];
      if (net.friendbot !== null) urls.push(net.friendbot);
      for (const url of urls) {
        expect(connect.some((src) => url.startsWith(src))).toBe(true);
      }
    }
  });

  it("allows the WalletConnect verify API fetches and the AppKit font host", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });
    const connect = directive(csp, "connect-src");
    expect(connect).toContain("https://verify.walletconnect.org");
    expect(connect).toContain("https://verify.walletconnect.com");
    expect(directive(csp, "font-src")).toContain("https://fonts.reown.com");
  });

  it("blocks the WalletConnect telemetry hosts (M-61)", () => {
    const csp = buildContentSecurityPolicy({ isDev: false });
    for (const name of ["connect-src", "img-src", "frame-src", "default-src"]) {
      expect(directive(csp, name).filter((src) => src.includes("pulse."))).toEqual([]);
    }
    // dev keeps the same list, only adding ws: for HMR
    const devConnect = directive(buildContentSecurityPolicy({ isDev: true }), "connect-src");
    expect(devConnect.filter((src) => src.includes("pulse."))).toEqual([]);
  });

  it("allows the icon host of every wallet module the picker loads", () => {
    const img = directive(buildContentSecurityPolicy({ isDev: false }), "img-src");
    const hosts = walletIconUrls().map((u) => new URL(u).origin);
    // the scan must actually see the kit's remote icons
    expect(hosts).toContain("https://stellar.creit.tech");
    expect(hosts).toContain("https://scopuly.com");
    expect(hosts).toContain("https://uni.onekey-asset.com");
    for (const host of hosts) expect(img).toContain(host);
  });
});

describe("proxy matcher", () => {
  // compile the exported matcher with Next's own getMiddlewareMatchers (exported
  // at runtime, not in its type declarations) and apply it the way the server does
  async function matcher(): Promise<(path: string) => boolean> {
    const staticInfo =
      (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
        getMiddlewareMatchers: (matcher: unknown, nextConfig: object) => ProxyMatcher[];
      };
    const matchers = staticInfo.getMiddlewareMatchers(proxyConfig.matcher, {});
    expect(matchers.length).toBeGreaterThan(0);
    const match = getMiddlewareRouteMatcher(matchers);
    return (p) => match(p, { headers: {} } as never, {});
  }

  it("skips every API route, so request bodies stream to the route's own cap", async () => {
    const matches = await matcher();
    for (const p of ["/api/plan", "/api/plan/abc/sign", "/api/metrics", "/api/mediator/sign"]) {
      expect(matches(p)).toBe(false);
    }
  });

  it("still covers the documents", async () => {
    const matches = await matcher();
    for (const p of ["/", "/demolish", "/sign", "/allowances"]) {
      expect(matches(p)).toBe(true);
    }
  });
});

function directive(csp: string, name: string): string[] {
  const d = csp.split(";").find((part) => part.trim().startsWith(`${name} `)) ?? "";
  return d.trim().split(/\s+/).slice(1);
}

// the productIcon of every module src/lib/wallet/kit.ts loads: defaultModules()
// plus Ledger and WalletConnect. read from the installed kit's sources, since
// the kit can't be imported in the node test environment.
function walletIconUrls(): string[] {
  // the kit's package.json isn't in its exports map, so resolve the folder on disk
  const kitRoot = realpathSync(
    path.join(process.cwd(), "node_modules/@creit.tech/stellar-wallets-kit"),
  );
  const modulesDir = path.join(kitRoot, "esm", "sdk", "modules");
  const utils = readFileSync(path.join(modulesDir, "utils.js"), "utf8");
  const files = [...utils.matchAll(/from "\.\/([\w-]+\.module\.js)"/g)].map((m) => m[1]!);
  files.push("ledger.module.js", "wallet-connect.module.js");

  const urls: string[] = [];
  for (const file of files) {
    const src = readFileSync(path.join(modulesDir, file), "utf8");
    const reexport = /export \{[^}]*\} from "([^".][^"]*)"/.exec(src);
    const code = reexport ? readPackageModule(reexport[1]!, kitRoot) : src;
    const live = code
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const pattern =
      /productIcon(?:"\s*,\s*\{[^}]*?value:\s*|\s*=\s*)["'`](https?:\/\/[^"'`]+)["'`]/gs;
    for (const m of live.matchAll(pattern)) urls.push(m[1]!);
  }
  return urls;
}

// a dependency of the kit sits next to it in the pnpm store
function readPackageModule(pkg: string, kitRoot: string): string {
  const dist = path.join(kitRoot, "..", "..", pkg, "dist");
  return readdirSync(dist)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => readFileSync(path.join(dist, f), "utf8"))
    .join("\n");
}
