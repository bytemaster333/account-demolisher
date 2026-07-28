import { describe, it, expect } from "vitest";

import nextConfig from "../../next.config";
import { buildContentSecurityPolicy } from "@/lib/config/csp";

// Locks in that next.config emits the static hardening headers, and that the
// per-request CSP (built in the middleware) is strict: nonce-gated scripts with
// no 'unsafe-inline', both networks allow-listed.
describe("security headers (next.config)", () => {
  it("emits the static hardening headers for every route", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);

    const rule = rules[0]!;
    expect(rule.source).toBe("/(.*)");

    const byKey: Record<string, string> = {};
    for (const h of rule.headers) byKey[h.key] = String(h.value);

    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("no-referrer");
    expect(byKey["Permissions-Policy"]).toBeDefined();
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
});
