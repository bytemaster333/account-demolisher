import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// compose passes the app only the variables listed under its environment (and
// the build args under build.args). every variable the server code reads must be
// listed, or an operator who sets it in .env silently gets the default.

const ROOT = process.cwd();

// read without a yaml dependency: collect the keys of a mapping that sits at a
// given indentation under the "app:" service
function appMappingKeys(compose: string, mapping: "environment" | "args"): Set<string> {
  const lines = compose.split("\n");
  const keys = new Set<string>();
  let inApp = false;
  let mappingIndent = -1;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inApp = false;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    if (indent === 2) {
      inApp = text === "app:";
      mappingIndent = -1;
      continue;
    }
    if (!inApp) continue;
    if (text === `${mapping}:`) {
      mappingIndent = indent;
      continue;
    }
    if (mappingIndent >= 0) {
      if (indent <= mappingIndent) {
        mappingIndent = -1;
        continue;
      }
      if (indent === mappingIndent + 2) {
        const key = /^([A-Z0-9_]+):/.exec(text)?.[1];
        if (key) keys.add(key);
      }
    }
  }
  return keys;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function envReads(dirs: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of dirs.flatMap((d) => sourceFiles(path.join(ROOT, d)))) {
    for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      found.add(m[1]!);
    }
  }
  return found;
}

// set by the image itself (Dockerfile ENV), not by the operator
const SET_BY_IMAGE = new Set(["NODE_ENV"]);

const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

describe("docker-compose forwards every variable the server reads", () => {
  const environment = appMappingKeys(compose, "environment");
  const args = appMappingKeys(compose, "args");

  it("parses the app service", () => {
    expect(environment.size).toBeGreaterThan(0);
    expect(args.size).toBeGreaterThan(0);
  });

  it.each([...envReads(["src/server", "src/app/api"])].sort())("%s reaches the app", (name) => {
    const listed = SET_BY_IMAGE.has(name) || environment.has(name) || args.has(name);
    expect(listed, `${name} is read by the server but not listed in docker-compose.yml`).toBe(true);
  });

  // the other direction: a variable compose still forwards after the code that
  // read it is gone tells an operator to configure something that does nothing
  it.each([...environment].sort())("%s is read by the server", (name) => {
    expect(
      envReads(["src"]).has(name),
      `${name} is forwarded by docker-compose.yml but nothing in src reads it`,
    ).toBe(true);
  });

  it.each([...envReads(["src"])].filter((n) => n.startsWith("NEXT_PUBLIC_")).sort())(
    "%s is a build arg",
    (name) => {
      expect(args.has(name), `${name} is inlined at build time but not a compose build arg`).toBe(
        true,
      );
    },
  );

  it("keeps the proxy hop count at one or more", () => {
    expect(compose).toMatch(/TRUSTED_PROXY_HOPS: \$\{TRUSTED_PROXY_HOPS:-1\}/);
  });
});
