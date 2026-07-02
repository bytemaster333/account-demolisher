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
