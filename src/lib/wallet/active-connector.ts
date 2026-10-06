// the active signing connector for this session, held in module scope.
//
// a connector is a live object that can sign. a pasted-seed SecretKeyConnector
// holds the seed, so it must never go into the zustand store or any persisted
// state: the store keeps only the publicKey and connectorKind for display.
//
// module state survives client-side navigation (Link and router.push do not
// reload the page), so a connection made on /demolish stays usable on
// /allowances. a hard reload loses it, and the wallet store (not persisted) is
// empty then too, so the two stay consistent. only a kit connection can be
// rebuilt after a reload, from the kit's own persisted selection; a pasted seed
// cannot.

import type { Connector } from "./connector";

let active: Connector | null = null;

export function setActiveConnector(connector: Connector | null): void {
  active = connector;
}

export function getActiveConnector(): Connector | null {
  return active;
}

// the one wallet teardown every disconnect path uses, so these three never drift
// apart:
//   1. the in-memory connector (cleared here),
//   2. the display store (cleared through clearStore), and
//   3. the kit's persisted selection (disconnectKit).
// clearing only the store would leave the extension still authorizing the site,
// and a later connect could quietly reuse that session. a kit connector forwards
// its own disconnect() to the kit; disconnectKit() also covers a kit selection
// left with no live connector. the ui is disconnected before the wallet is told,
// so a wallet whose teardown fails cannot keep the app connected.
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
