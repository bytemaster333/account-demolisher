// The active signing connector for the current session, held in module scope.
//
// A Connector is a live object with in-memory signing capability. A pasted-seed
// SecretKeyConnector holds the seed and must never be serialized into the Zustand
// store or any persisted state. The store keeps only the display-side publicKey +
// connectorKind; the connector itself lives here.
//
// Module state survives App Router client-side navigation (Link / router.push do
// not reload the page), so a connection made on /demolish stays usable on
// /allowances. It is intentionally lost on a hard reload, at which point the
// (non-persisted) wallet store is empty too, so the two stay consistent. Only a
// "kit" connection can be rebuilt after that (from the wallet-kit's own persisted
// selection); a pasted-seed connector cannot, by design.

import type { Connector } from "./connector";

let active: Connector | null = null;

export function setActiveConnector(connector: Connector | null): void {
  active = connector;
}

export function getActiveConnector(): Connector | null {
  return active;
}

// Canonical wallet teardown. EVERY disconnect path must go through here so the
// three pieces of session state can never drift apart:
//   1. the in-memory session connector (cleared here),
//   2. the display store (cleared via the passed callback), and
//   3. the wallet-kit's own persisted selection (StellarWalletsKit.disconnect).
// The previous store-only disconnect cleared (2) alone, leaving the kit still
// "connected" to the wallet: the extension kept the site authorized and a later
// connect could silently reuse the stale session. A "kit" connector forwards its
// own disconnect() to the kit; the extra disconnectKit() covers a lingering kit
// selection with no live connector. Teardown is best-effort: the UI is already
// disconnected, so a failing wallet hook must not leave the app stuck connected.
export async function disconnectSession(clearStore: () => void): Promise<void> {
  const conn = active;
  active = null;
  clearStore();
  try {
    await conn?.disconnect();
  } catch {
    // ignore: a wallet whose teardown throws (e.g. WalletConnect already gone)
    // must not block the disconnect the user asked for
  }
  try {
    // dynamic import so the browser-only wallet-kit (and its Freighter dep) is
    // pulled in only at disconnect time, not by every module that reads the
    // active connector (get/set stay dependency-free and unit-testable).
    const { disconnectKit } = await import("./kit");
    await disconnectKit();
  } catch {
    // ignore: best-effort forget of the kit's persisted selection
  }
}
