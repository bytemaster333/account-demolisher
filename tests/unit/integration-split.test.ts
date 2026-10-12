import { globSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  INTEGRATION_TESTS,
  MAINNET_INTEGRATION_DIR,
  MAINNET_INTEGRATION_TESTS,
} from "../integration/scope.mjs";

// what a file that talks to mainnet has to name: the network config, the sdk's
// mainnet passphrase, a pinned mainnet contract id, a mainnet host, or the
// stellar.expert mainnet directory
const READS_MAINNET =
  /\bMAINNET\b|NETWORKS\.mainnet|Networks\.PUBLIC|_MAINNET_ID\b|horizon\.stellar\.org|mainnet\.sorobanrpc\.com|stellar\.expert/;

const blocking = globSync(INTEGRATION_TESTS, { exclude: [`${MAINNET_INTEGRATION_DIR}/**`] });
const scheduled = globSync(MAINNET_INTEGRATION_TESTS);

// the `run:` line of the step or job whose run starts with `pnpm test:integration`
function integrationRuns(workflow: string): string[] {
  return readFileSync(`.github/workflows/${workflow}`, "utf8")
    .split("\n")
    .map((line) => line.trim().replace(/^- /, ""))
    .filter((line) => line.startsWith("run: pnpm test:integration"))
    .map((line) => line.slice("run: ".length));
}

describe("integration split (NPF-57)", () => {
  it("keeps every mainnet read out of the integration files that block ci", () => {
    expect(blocking.length).toBeGreaterThan(20);
    const offenders = blocking.filter((file) => READS_MAINNET.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("runs the mainnet files on their own", () => {
    expect(scheduled.length).toBeGreaterThan(0);
    for (const file of scheduled) expect(READS_MAINNET.test(readFileSync(file, "utf8"))).toBe(true);
  });

  it("points each package script at the matching config", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(scripts["test:integration"]).toBe("vitest run --config vitest.integration.config.mts");
    expect(scripts["test:integration:mainnet"]).toBe(
      "vitest run --config vitest.integration-mainnet.config.mts",
    );
  });

  it("runs the whole blocking set in ci and before a release, and nothing from mainnet", () => {
    expect(integrationRuns("ci.yml")).toEqual(["pnpm test:integration"]);
    expect(integrationRuns("release.yml")).toEqual(["pnpm test:integration"]);
  });

  it("runs every mainnet file in the scheduled job", () => {
    const runs = integrationRuns("mainnet-timing.yml");
    expect(runs.length).toBeGreaterThan(0);
    const covered = new Set<string>();
    for (const run of runs) {
      const [cmd, script, ...args] = run.split(/\s+/);
      expect(`${cmd} ${script}`).toBe("pnpm test:integration:mainnet");
      const excluded = args.filter((_, i) => args[i - 1] === "--exclude");
      const named = args.filter((a, i) => a.endsWith(".ts") && args[i - 1] !== "--exclude");
      // a run that names files runs those; one that names none runs the rest
      const files = named.length > 0 ? named : scheduled.filter((f) => !excluded.includes(f));
      for (const file of files) covered.add(file);
    }
    expect([...covered].sort()).toEqual([...scheduled].sort());
  });
});
