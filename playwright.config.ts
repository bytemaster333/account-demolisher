import { defineConfig, devices } from "@playwright/test";

// e2e / accessibility specs. They drive the real Next.js app (built + started).
// smoke/accessibility use no wallet; secret-key-close signs a real close on
// testnet with a throwaway pasted key. Browser binaries must be installed once
// with `pnpm exec playwright install chromium`.

// the port the app is built and served on for the run. defaults to 3000; set
// E2E_PORT when that port is already taken on the machine.
const port = process.env.E2E_PORT ?? "3000";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm build && pnpm start --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
