// remembers that this browser acknowledged the unaudited-on-mainnet notice.
// bump the version to ask everyone again when the notice changes. storage can
// throw (blocked site data, sandboxed frames); then the acknowledgement only
// lasts for this page load and the notice shows again on the next one.

const KEY = "demolisher.mainnetAck";
const VERSION = "1";

let acknowledgedThisLoad = false;
const listeners = new Set<() => void>();

export function hasMainnetAck(): boolean {
  if (acknowledgedThisLoad) return true;
  try {
    return window.localStorage.getItem(KEY) === VERSION;
  } catch {
    return false;
  }
}

export function recordMainnetAck(): void {
  acknowledgedThisLoad = true;
  try {
    window.localStorage.setItem(KEY, VERSION);
  } catch {
    // storage unavailable: remembered for this load only
  }
  for (const l of listeners) l();
}

// for useSyncExternalStore
export function subscribeMainnetAck(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
