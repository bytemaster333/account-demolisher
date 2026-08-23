// wrapper around @creit.tech/stellar-wallets-kit v2.3.0 (static-class API:
// StellarWalletsKit.init/authModal/getAddress/signTransaction/disconnect/...)
import "@/lib/wallet/buffer-polyfill"; // Ledger needs a browser Buffer global
import { Networks as KitNetworks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";

import { getPublicEnv } from "@/lib/config/env";
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

// WalletConnect only speaks the public and testnet chains; futurenet has no WC
// namespace, so on futurenet the WC entry stays present but its getAddress will
// reject (an accurate "unsupported network" instead of a silent wrong-chain).
function wcTargetChain(network: NetworkConfig): WalletConnectTargetChain | null {
  switch (network.passphrase) {
    case KitNetworks.PUBLIC:
      return WalletConnectTargetChain.PUBLIC;
    case KitNetworks.TESTNET:
      return WalletConnectTargetChain.TESTNET;
    default:
      return null;
  }
}

// single WalletConnect module instance. constructing it eagerly opens a relay
// socket (SignClient.init), so we build it lazily on first getKit() and never
// during passive session-restore (see restoreKitSession) to keep a fresh
// visitor from contacting the WC relay before they choose to connect a wallet.
let wcModule: WalletConnectModule | null = null;

function getWalletConnectModule(network: NetworkConfig): WalletConnectModule | null {
  const projectId = getPublicEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (!projectId) return null; // not configured -> WC stays out of the picker

  const chain = wcTargetChain(network);
  if (wcModule) {
    // keep the requested chain in sync with the active network on switches
    if (chain) wcModule.wcParams.allowedChains = [chain];
    return wcModule;
  }

  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://demolisher.app";
  wcModule = new WalletConnectModule({
    projectId,
    allowedChains: [chain ?? WalletConnectTargetChain.PUBLIC],
    metadata: {
      name: "Account Demolisher",
      description: "Close a Stellar account and reclaim its reserves",
      url: origin,
      icons: [`${origin}/icon.svg`],
    },
  });
  return wcModule;
}

// the wallet-picker module list: the 11 zero-config defaults plus Ledger
// (hardware, WebUSB) and, when configured, WalletConnect (mobile via QR)
function buildModules(network: NetworkConfig) {
  const modules = [...defaultModules(), new LedgerModule()];
  const wc = getWalletConnectModule(network);
  if (wc) modules.push(wc);
  return modules;
}

// WalletConnect's isAvailable() only flips true once its SignClient.init round
// trip to the relay resolves. The kit samples availability when the picker
// renders and never re-renders, so opening the picker before init finishes lists
// WC as unavailable, and the kit then treats a click as "not installed" and opens
// walletconnect.com instead of the QR. Await readiness (bounded) before opening
// the picker so a configured WalletConnect is actually connectable. No-op when WC
// isn't configured or is already ready; falls through on timeout (WC just shows
// as needing install, the pre-existing degraded state, never a hang).
export async function ensureWalletConnectReady(timeoutMs = 2500): Promise<void> {
  const wc = wcModule;
  if (!wc) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await wc.isAvailable()) return;
    } catch {
      // isAvailable shouldn't throw; never let readiness polling break connect
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// tracks the passphrase the kit was last initialized for, so we can switch
// networks but skip the init when it already matches
let initializedPassphrase: string | null = null;

// returns the process-wide kit handle configured for `network`. first call
// initializes; subsequent calls with a different network call setNetwork
export function getKit(network: NetworkConfig): KitHandle {
  const kitNetwork = toKitNetwork(network);

  if (initializedPassphrase === null) {
    StellarWalletsKit.init({
      modules: buildModules(network),
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
    // re-point WalletConnect at the new network's chain
    getWalletConnectModule(network);
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

// the kit's own persistence key for the wallets a user has connected with. we
// read it directly to decide whether there is anything to restore, WITHOUT
// initializing the kit first (init would eagerly construct WalletConnect and
// open a relay socket even for visitors who never connected a wallet).
const KIT_USED_WALLETS_KEY = "@StellarWalletsKit/usedWalletsIds";

function hasPersistedKitSession(): boolean {
  try {
    const raw = window.localStorage.getItem(KIT_USED_WALLETS_KEY);
    if (!raw) return false;
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) && ids.length > 0;
  } catch {
    return false;
  }
}

// Silently restore a prior kit connection after a hard refresh. The kit persists
// the selected wallet id AND the address in localStorage and re-seeds them on
// init, so getAddress() returns the remembered address with NO wallet prompt.
// Returns the address if a session was persisted, or null if there is nothing to
// restore. Skips kit init entirely when nothing was persisted, so a fresh
// visitor never triggers WalletConnect's relay connection on page load.
export async function restoreKitSession(network: NetworkConfig): Promise<string | null> {
  if (!hasPersistedKitSession()) return null;
  getKit(network);
  try {
    const { address } = await StellarWalletsKit.getAddress();
    return typeof address === "string" && address.length > 0 ? address : null;
  } catch {
    return null;
  }
}
