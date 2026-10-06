import { describe, it, expect } from "vitest";
import { NETWORKS } from "@/lib/config/networks";
import { METRIC_NETWORKS, metricEventSchema } from "@/lib/metrics/events";

const HASH = "a".repeat(64);

describe("metricEventSchema", () => {
  it("accepts a well-formed visit (network optional)", () => {
    expect(metricEventSchema.safeParse({ type: "visit", page: "landing" }).success).toBe(true);
    expect(
      metricEventSchema.safeParse({ type: "visit", page: "demolish", network: "mainnet" }).success,
    ).toBe(true);
  });

  it("accepts a funnel step and a close with a 64-hex hash", () => {
    expect(
      metricEventSchema.safeParse({ type: "funnel", step: "close_started", network: "testnet" })
        .success,
    ).toBe(true);
    expect(
      metricEventSchema.safeParse({ type: "close", network: "mainnet", txHash: HASH }).success,
    ).toBe(true);
  });

  it("rejects unknown pages, steps, and networks", () => {
    expect(metricEventSchema.safeParse({ type: "visit", page: "evil" }).success).toBe(false);
    expect(
      metricEventSchema.safeParse({ type: "funnel", step: "nope", network: "mainnet" }).success,
    ).toBe(false);
    expect(
      metricEventSchema.safeParse({ type: "close", network: "eth", txHash: HASH }).success,
    ).toBe(false);
  });

  it("accepts exactly the networks in the app config, nothing the config dropped", () => {
    expect([...METRIC_NETWORKS].sort()).toEqual(Object.keys(NETWORKS).sort());
    for (const id of Object.keys(NETWORKS)) {
      expect(
        metricEventSchema.safeParse({ type: "close", network: id, txHash: HASH }).success,
      ).toBe(true);
    }
  });

  it("rejects malformed tx hashes (wrong length, uppercase, non-hex)", () => {
    for (const bad of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "xyz",
      `${"a".repeat(63)}g`,
    ]) {
      expect(
        metricEventSchema.safeParse({ type: "close", network: "mainnet", txHash: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects an unknown event type and requires funnel/close to carry network", () => {
    expect(metricEventSchema.safeParse({ type: "wat", page: "landing" }).success).toBe(false);
    expect(metricEventSchema.safeParse({ type: "funnel", step: "close_started" }).success).toBe(
      false,
    );
    expect(metricEventSchema.safeParse({ type: "close", txHash: HASH }).success).toBe(false);
  });
});
