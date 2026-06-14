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
  },
});
