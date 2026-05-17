// zustand store for the display side of the connected wallet.
//
// holds the public key and connector kind ("kit" | "secret"). does NOT
// hold the Connector reference or the seed — those live in a React useRef
// scoped to the active flow, so they can't end up in devtools snapshots,
// persistence middleware, or ssr payloads.
import { create } from "zustand";

import type { ConnectorKind } from "@/lib/wallet/connector";

export interface WalletState {
  publicKey: string | null;
  connectorKind: ConnectorKind | null;
  setConnected: (publicKey: string, kind: ConnectorKind) => void;
  disconnect: () => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  publicKey: null,
  connectorKind: null,
  setConnected: (publicKey, kind) => set({ publicKey, connectorKind: kind }),
  disconnect: () => set({ publicKey: null, connectorKind: null }),
}));
