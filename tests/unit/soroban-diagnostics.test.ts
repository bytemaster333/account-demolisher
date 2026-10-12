import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk";

import { describeSorobanFailure } from "@/lib/soroban/diagnostics";

// captured from testnet rpc on 2026-10-12: a simulated native SAC transfer of
// 10^18 stroops from a freshly funded account. the first event is the fn_call
// trace, the second the host's error event with its message and arguments.
const FN_CALL_EVENT =
  "AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAADAAAADwAAAAdmbl9jYWxsAAAAAA0AAAAg15KLcsJwPM/q9+uf9O9NUEpVqLl5/JtFDqLIQrTRzmEAAAAPAAAACHRyYW5zZmVyAAAAEAAAAAEAAAADAAAAEgAAAAAAAAAAIvHM87YfN1R/Nanf1zCe2FcfNTmSsBR1b6sEV5QA+5MAAAASAAAAAAAAAACGAnjZWn7SLpAvkr8I/q7YaQx9nzejboF8D6FqIktXswAAAAoAAAAAAAAAAA3gtrOnZAAA";
const BALANCE_ERROR_EVENT =
  "AAAAAAAAAAAAAAAB15KLcsJwPM/q9+uf9O9NUEpVqLl5/JtFDqLIQrTRzmEAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAKAAAAEAAAAAEAAAAEAAAADgAAADFyZXN1bHRpbmcgYmFsYW5jZSBpcyBub3Qgd2l0aGluIHRoZSBhbGxvd2VkIHJhbmdlAAAAAAAABgAAAAAAmJaAAAAABvIfSWOhEugAAAAABn//////////";

const decode = (b64: string) => xdr.DiagnosticEvent.fromXDR(b64, "base64");

// a diagnostic event built the way the host emits one, for shapes the capture
// above does not cover
function diagnostic(topics: xdr.ScVal[], data: xdr.ScVal): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data })),
    }),
  });
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const str = (s: string) => xdr.ScVal.scvString(s);

describe("describeSorobanFailure", () => {
  it("returns an empty reason when there are no events", () => {
    expect(describeSorobanFailure(undefined)).toBe("");
    expect(describeSorobanFailure([])).toBe("");
  });

  it("reads the error code and message from a real host error event", () => {
    expect(describeSorobanFailure([decode(FN_CALL_EVENT), decode(BALANCE_ERROR_EVENT)])).toBe(
      '{"type":"contract","code":10} resulting balance is not within the allowed range',
    );
  });

  it("ignores events that are not errors", () => {
    expect(describeSorobanFailure([decode(FN_CALL_EVENT)])).toBe("");
  });

  it("takes a plain string payload as the message", () => {
    const ev = diagnostic(
      [sym("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(3))],
      str("trapped in the pool"),
    );
    expect(describeSorobanFailure([ev])).toBe('{"type":"contract","code":3} trapped in the pool');
  });

  it("keeps the code when the payload carries no text", () => {
    const ev = diagnostic(
      [sym("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(7))],
      xdr.ScVal.scvU32(4),
    );
    expect(describeSorobanFailure([ev])).toBe('{"type":"contract","code":7}');
  });

  it("joins every error event in order", () => {
    const first = diagnostic([sym("error"), sym("first")], str("a"));
    const second = diagnostic(
      [sym("error"), sym("second")],
      xdr.ScVal.scvVec([str("b"), str("c")]),
    );
    expect(describeSorobanFailure([first, second])).toBe("first a | second b");
  });

  it("skips an error event with neither a code nor a message", () => {
    const empty = diagnostic([sym("error")], xdr.ScVal.scvVoid());
    const real = decode(BALANCE_ERROR_EVENT);
    expect(describeSorobanFailure([empty, real])).toBe(
      '{"type":"contract","code":10} resulting balance is not within the allowed range',
    );
  });
});
