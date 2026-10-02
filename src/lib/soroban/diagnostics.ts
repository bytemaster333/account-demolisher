// shared decoder for a FAILED Soroban transaction's diagnostic events.
//
// The RPC keeps the human-facing failure reason (an "outside of the footprint"
// trap, an scecExceededLimit, a contract panic) only in these events. Every
// Soroban submit path should decode them rather than throw a bare "failed
// on-chain": it surfaces the real cause to the user, and it lets a caller that
// has a rebuild-and-retry loop classify a recoverable footprint/resource trap
// (the simulated footprint under-declaring a time-dependent contract write)
// instead of treating every trap as a terminal revert.

import { scValToNative, type xdr } from "@stellar/stellar-sdk";

export function describeSorobanFailure(events: readonly xdr.DiagnosticEvent[] | undefined): string {
  if (!events || events.length === 0) return "";
  const reasons: string[] = [];
  for (const ev of events) {
    let topics: unknown[] = [];
    let data: unknown = null;
    try {
      const body = ev.event.body.v0;
      topics = body.topics.map((t) => {
        try {
          return scValToNative(t);
        } catch {
          return null;
        }
      });
      try {
        data = scValToNative(body.data);
      } catch {
        /* data not scval-convertible; keep the topics */
      }
    } catch {
      continue;
    }
    if (topics[0] !== "error") continue;
    const code =
      topics[1] == null
        ? ""
        : typeof topics[1] === "object"
          ? JSON.stringify(topics[1])
          : String(topics[1]);
    const text = Array.isArray(data)
      ? data.find((x): x is string => typeof x === "string")
      : typeof data === "string"
        ? data
        : undefined;
    const line = [code, text].filter(Boolean).join(" ");
    if (line) reasons.push(line);
  }
  return reasons.join(" | ");
}
