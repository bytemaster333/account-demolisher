// the partner history index's hosts per network, apart from the client so the
// content-security-policy can list them without loading the sdk

import type { StellarNetwork } from "@/lib/config/networks";

export const LUMEUS_HOSTS: Readonly<
  Record<StellarNetwork, { readonly activity: string; readonly assets: string }>
> = {
  mainnet: { activity: "https://api.lumeus.dev", assets: "https://assets.lumeus.dev" },
  testnet: {
    activity: "https://api-testnet.lumeus.dev",
    assets: "https://assets-testnet.lumeus.dev",
  },
};
