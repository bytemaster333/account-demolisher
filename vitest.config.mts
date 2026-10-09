import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// unit tests: pure logic, no network. dom-dependent specs opt in per-file with
// a `// @vitest-environment happy-dom` pragma at the top of the file.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    passWithNoTests: false,
    // `pnpm test:coverage`, which ci runs. the measured scope is the logic the
    // unit suite exists for: the close engine, adapters and safety checks
    // (src/lib) and the server side (src/server). pages and components are
    // covered by e2e. the thresholds are the coverage measured on 2026-10-09
    // (src/lib 89.37 lines, 87.31 statements, 92.72 functions, 80.55 branches;
    // src/server 95.57, 93.45, 99.13, 84.88), rounded down, so new untested code
    // fails the run instead of quietly lowering it.
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        "src/lib/**": { lines: 89, statements: 87, functions: 92, branches: 80 },
        "src/server/**": { lines: 95, statements: 93, functions: 99, branches: 84 },
      },
    },
  },
});
