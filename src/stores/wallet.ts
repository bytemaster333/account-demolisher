// zustand store for the display side of the connected wallet
import { create } from "zustand";

import type { ConnectorKind } from "@/lib/wallet/connector";

export interface WalletState {
  publicKey: string | null;
  connectorKind: ConnectorKind | null;
  isDemo: boolean;
  setConnected: (publicKey: string, kind: ConnectorKind, isDemo?: boolean) => void;
  disconnect: () => void;
}

export const useWalletStore = create<WalletState>((set) => ({
  publicKey: null,
  connectorKind: null,
  isDemo: false,
  setConnected: (publicKey, kind, isDemo = false) =>
    set({ publicKey, connectorKind: kind, isDemo }),
  disconnect: () => set({ publicKey: null, connectorKind: null, isDemo: false }),
}));
