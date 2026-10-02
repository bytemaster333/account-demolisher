import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// integration tests: real round-trips against live testnet (Horizon, Soroban
// RPC, Friendbot). Slow + network-dependent, so they run under a separate
// command (`pnpm test:integration`) and are not part of the fast unit gate.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.{ts,tsx}"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // integration specs are added per-phase as the network paths land; until a
    // given area has them, don't fail the command for an empty match.
    passWithNoTests: true,
    // testnet round-trips share sequence numbers / friendbot rate limits, so
    // don't run integration files in parallel.
    fileParallelism: false,
  },
});
