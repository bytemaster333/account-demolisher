import { defineConfig, devices } from "@playwright/test";

// e2e / accessibility specs. They drive the real Next.js app (built + started)
// behind the reverse proxy it requires (tests/helpers/e2e-server.mjs). smoke and
// accessibility use no wallet; the close specs sign real closes on testnet with
// throwaway keys. Browser binaries must be installed once with
// `pnpm exec playwright install chromium`.

// the proxy listens here and the app on the port after it. the default is kept
// away from 3000, so a local run never lands on some other dev server.
const port = process.env.E2E_PORT ?? "3250";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // the close specs fund accounts through friendbot, which rate-limits, and
  // several share one server's per-client rate limits, so specs run one at a time
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/helpers/e2e-server.mjs",
    url: baseURL,
    env: { E2E_PORT: port },
    // always our own server: reusing whatever answers on the port could test an
    // unrelated app and report it green
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
  },
});
