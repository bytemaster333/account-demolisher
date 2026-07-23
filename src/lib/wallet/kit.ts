// wrapper around @creit.tech/stellar-wallets-kit v2.3.0 (static-class API:
// StellarWalletsKit.init/authModal/getAddress/signTransaction/disconnect/...)
import { Networks as KitNetworks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";

import type { NetworkConfig } from "@/lib/config/networks";

// exported as the class type. `new StellarWalletsKit()` isn't supported
export type KitHandle = typeof StellarWalletsKit;

// the kit's enum values are the passphrase strings themselves; match by
// passphrase so we stay correct even if either side renames a variant
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

// dark theme for the kit's wallet-picker modal, matching the app palette (the
// modal is a shadow-DOM web component, so it can't read our CSS variables and
// needs concrete color values). Keeps the picker on-brand instead of the kit's
// stock black/white styling.
const KIT_THEME = {
  background: "#141618",
  "background-secondary": "#1a1d1f",
  "foreground-strong": "#eef0f2",
  foreground: "#a4a9b0",
  "foreground-secondary": "#7e848c",
  primary: "#46a479",
  "primary-foreground": "#08140d",
  transparent: "transparent",
  lighter: "#212528",
  light: "#1a1d1f",
  "light-gray": "#363b40",
  gray: "#7e848c",
  danger: "#d9756a",
  border: "#282b2e",
  shadow: "rgba(0, 0, 0, 0.5)",
  "border-radius": "12px",
  "font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
};

// tracks the passphrase the kit was last initialized for, so we can switch
// networks but skip the init when it already matches
let initializedPassphrase: string | null = null;

// returns the process-wide kit handle configured for `network`. first call
// initializes; subsequent calls with a different network call setNetwork
export function getKit(network: NetworkConfig): KitHandle {
  const kitNetwork = toKitNetwork(network);

  if (initializedPassphrase === null) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: kitNetwork,
      theme: KIT_THEME,
      // label not-installed wallets with an "Install" link instead of hiding
      // them, so the list is predictable
      authModal: { showInstallLabel: true },
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

// Fully disconnect the kit: forget the selected wallet and reset its internal
// state, so the wallet extension no longer treats the site as connected and a
// later connect re-prompts the picker. Safe to call when the kit was never
// initialized (no-op) and idempotent (the kit's own disconnect resets state).
export async function disconnectKit(): Promise<void> {
  if (initializedPassphrase === null) return;
  await StellarWalletsKit.disconnect();
}

// Silently restore a prior kit connection after a hard refresh. The kit persists
// the selected wallet id AND the address in localStorage and re-seeds them on
// init, so getAddress() returns the remembered address with NO wallet prompt.
// Returns the address if a session was persisted, or null if there is nothing to
// restore (getAddress throws "No wallet has been connected"). The wallet
// extension still holds the granted permission, so the restored session can sign.
export async function restoreKitSession(network: NetworkConfig): Promise<string | null> {
  getKit(network);
  try {
    const { address } = await StellarWalletsKit.getAddress();
    return typeof address === "string" && address.length > 0 ? address : null;
  } catch {
    return null;
  }
}
