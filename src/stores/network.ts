// the stellar network the user picked. it starts from the build-time env, so the
// server render and the first client render agree, and the navbar switcher
// changes it at runtime and keeps the choice in localStorage.

import { create } from "zustand";

import { getPublicEnv } from "@/lib/config/env";
import type { StellarNetwork } from "@/lib/config/networks";

interface NetworkState {
  networkId: StellarNetwork;
  setNetwork: (id: StellarNetwork) => void;
  // set while a close executes or signatures are being collected: a network
  // switch then would tear down the wallet session the run is signing with. the
  // switcher and the header disconnect show this text instead of acting.
  lockReason: string | null;
  setLockReason: (reason: string | null) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  networkId: getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK,
  setNetwork: (id) => set({ networkId: id }),
  lockReason: null,
  setLockReason: (reason) => set({ lockReason: reason }),
}));
