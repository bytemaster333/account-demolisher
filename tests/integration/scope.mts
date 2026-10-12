// which integration files block ci and a release, and which run only in the
// scheduled mainnet job (.github/workflows/mainnet-timing.yml). both vitest
// integration configs and the split's unit test read these, so the three cannot
// disagree.
//
// a file that reads mainnet, even read-only, belongs under mainnet/: a public
// mainnet rate limit or outage says nothing about a change and must not block a
// merge or a release.

import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

export const INTEGRATION_TESTS = "tests/integration/**/*.test.{ts,tsx}";

export const MAINNET_INTEGRATION_DIR = "tests/integration/mainnet";

export const MAINNET_INTEGRATION_TESTS = `${MAINNET_INTEGRATION_DIR}/**/*.test.{ts,tsx}`;

// the settings both sets share. they make real round trips, so they are slow
// and run under their own commands, never in the fast unit gate.
export function integrationConfig(scope: "blocking" | "mainnet"): ViteUserConfig {
  return defineConfig({
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("../../src", import.meta.url)),
      },
    },
    test: {
      environment: "node",
      include: [scope === "mainnet" ? MAINNET_INTEGRATION_TESTS : INTEGRATION_TESTS],
      exclude:
        scope === "mainnet"
          ? [...configDefaults.exclude]
          : [...configDefaults.exclude, `${MAINNET_INTEGRATION_DIR}/**`],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      // a glob or path that matches nothing must fail the run, never pass it
      passWithNoTests: false,
      // testnet round-trips share sequence numbers / friendbot rate limits, so
      // don't run integration files in parallel.
      fileParallelism: false,
    },
  });
}
