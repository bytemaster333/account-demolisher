import { describe, expect, it } from "vitest";

// zod 4 probes for eval with new Function("") the first time it builds an object
// schema, and compiles a fast object parser with new Function on first parse.
// the production csp has no 'unsafe-eval', so the browser reports the probe as a
// securitypolicyviolation on page load even though zod catches the throw (NPF-41).
// the app's schemas must be built and parsed without ever calling the Function
// constructor. the spy goes in before any of them is imported.

describe("app zod schemas under a csp without 'unsafe-eval' (NPF-41)", () => {
  it("build and parse without calling the Function constructor", async () => {
    const realFunction = globalThis.Function;
    const calls: unknown[][] = [];
    globalThis.Function = new Proxy(realFunction, {
      construct(target, args, newTarget) {
        calls.push(args);
        return Reflect.construct(target, args, newTarget) as object;
      },
      apply(target, thisArg, args) {
        calls.push(args);
        return Reflect.apply(target, thisArg, args) as unknown;
      },
    });

    let results: boolean[];
    try {
      const { FORM_SCHEMA } = await import("@/app/demolish/_lib/form");
      const { blendPositionSchema } = await import("@/lib/adapters/positions/schema");
      const { metricEventSchema } = await import("@/lib/metrics/events");
      const { getPublicEnv } = await import("@/lib/config/env");

      results = [
        FORM_SCHEMA.safeParse({
          destination: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
          memoType: "none",
          memoValue: "",
          returnToIssuer: [],
          sendToDestination: [],
        }).success,
        blendPositionSchema.safeParse({}).success,
        metricEventSchema.safeParse({ type: "visit", page: "demolish", network: "testnet" })
          .success,
      ];
      getPublicEnv();
    } finally {
      globalThis.Function = realFunction;
    }

    // the parses ran (so the object parser was exercised), whatever they returned
    expect(results).toHaveLength(3);
    // the function body is enough to tell the eval probe from a compiled parser
    expect(calls.map((args) => String(args.at(-1)).slice(0, 60))).toEqual([]);
  });
});
