// wrapper around @creit.tech/stellar-wallets-kit v2.2.0.
//
// in v2.2.0 the kit is a static class with module-level singleton state;
// there is no per-instance object to construct. `defaultModules()` replaces
// the older `allowAllModules()` helper.
import { Networks as KitNetworks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";

import type { NetworkConfig } from "@/lib/config/networks";

// exported as the class type — `new StellarWalletsKit()` isn't supported.
export type KitHandle = typeof StellarWalletsKit;

// the kit's enum values are the passphrase strings themselves; match by
// passphrase so we stay correct even if either side renames a variant.
function toKitNetwork(network: NetworkConfig): KitNetworks {
  switch (network.passphrase) {
    case KitNetworks.PUBLIC:
      return KitNetworks.PUBLIC;
    case KitNetworks.TESTNET:
      return KitNetworks.TESTNET;
    case KitNetworks.FUTURENET:
      return KitNetworks.FUTURENET;
    default:
      throw new Error(
        `Unsupported network passphrase for stellar-wallets-kit: ${network.passphrase}`,
      );
  }
}

// tracks the passphrase the kit was last initialized for, so we can switch
// networks but skip the init when it already matches.
let initializedPassphrase: string | null = null;

// returns the process-wide kit handle configured for `network`. first call
// initializes; subsequent calls with a different network call setNetwork.
export function getKit(network: NetworkConfig): KitHandle {
  const kitNetwork = toKitNetwork(network);

  if (initializedPassphrase === null) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: kitNetwork,
    });
    initializedPassphrase = network.passphrase;
    return StellarWalletsKit;
  }

  if (initializedPassphrase !== network.passphrase) {
    StellarWalletsKit.setNetwork(kitNetwork);
    initializedPassphrase = network.passphrase;
  }

  return StellarWalletsKit;
}

// test-only: reset the init latch. the upstream lib has no public reset
// hook, so tests needing a truly virgin kit must mock the module.
export function _resetKitInitLatchForTests(): void {
  initializedPassphrase = null;
}
