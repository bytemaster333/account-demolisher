import { describe, it, expect } from "vitest";

import { parseDemolishError } from "@/app/demolish/_lib/demolish-error";

describe("parseDemolishError (I-10)", () => {
  it("names the failing operation inside the transaction, not a plan step", () => {
    const raw =
      'submitClassic rejected: {"transaction":"tx_failed","operations":["op_success","op_underfunded","op_success"]}';
    const parsed = parseDemolishError(raw);
    expect(parsed.summary).toMatch(/^Operation 2 of 3 in the transaction was rejected/);
    expect(parsed.summary).not.toMatch(/^Step /);
    expect(parsed.ops).toEqual(["op_success", "op_underfunded", "op_success"]);
  });

  it("reads the last result-code object when several errors are joined", () => {
    const raw =
      'submitClassic rejected: {"transaction":"tx_bad_seq"}; ' +
      'submitClassic rejected: {"transaction":"tx_failed","operations":["op_no_trust"]}';
    const parsed = parseDemolishError(raw);
    expect(parsed.txCode).toBe("tx_failed");
    expect(parsed.ops).toEqual(["op_no_trust"]);
    expect(parsed.summary).toMatch(/Operation 1 of 1/);
  });

  it("keeps braces inside string values from breaking the scan", () => {
    const raw = 'x: {"transaction":"tx_failed","note":"a } b","operations":["op_malformed"]}';
    expect(parseDemolishError(raw).ops).toEqual(["op_malformed"]);
  });

  it("does not promise the funds are safe when there is no detail (H-30)", () => {
    const parsed = parseDemolishError(null);
    expect(parsed.summary).not.toMatch(/funds are safe/i);
    expect(parsed.summary).toBe("The close stopped. See the details below.");
  });
});
