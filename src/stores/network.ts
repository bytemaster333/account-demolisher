// Client-selected Stellar network. Defaults to the build-time env, and can be
// switched at runtime from the navbar (Testnet / Mainnet). Persisted to
// localStorage in the switcher; initialised from env so server and first client
// render agree (no hydration mismatch).

import { create } from "zustand";

import { getPublicEnv } from "@/lib/config/env";
import type { StellarNetwork } from "@/lib/config/networks";

interface NetworkState {
  networkId: StellarNetwork;
  setNetwork: (id: StellarNetwork) => void;
}

export const useNetworkStore = create<NetworkState>((set) => ({
  networkId: getPublicEnv().NEXT_PUBLIC_STELLAR_NETWORK,
  setNetwork: (id) => set({ networkId: id }),
}));
