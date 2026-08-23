// the Ledger module (@ledgerhq/hw-app-str + hw-transport) reaches for a global
// Buffer at signing time; browsers don't provide one and Next doesn't polyfill
// node globals for the client bundle, so the module warns it "will break your
// app" without this. set it once, additively, before any Ledger call runs.
import { Buffer as NodeBuffer } from "buffer";

type MaybeBuffer = { Buffer?: unknown };

if (typeof globalThis !== "undefined" && (globalThis as MaybeBuffer).Buffer === undefined) {
  (globalThis as MaybeBuffer).Buffer = NodeBuffer;
}
