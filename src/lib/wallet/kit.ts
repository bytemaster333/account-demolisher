// wrapper around @creit.tech/stellar-wallets-kit v2.7.0 (static-class API:
// StellarWalletsKit.init/authModal/getAddress/signTransaction/disconnect/...)
import "@/lib/wallet/buffer-polyfill"; // Ledger needs a browser Buffer global
import {
  activeAddress,
  activeModules,
  hardwareWalletPaths,
  Networks as KitNetworks,
  LocalStorageKeys,
  ModuleType,
  selectedModuleId,
  StellarWalletsKit,
  wcSessionPaths,
  type ModuleInterface,
  type SwkAppTheme,
} from "@creit.tech/stellar-wallets-kit";
import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import {
  WALLET_CONNECT_ID,
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
    default:
      throw new Error(
        `Unsupported network passphrase for stellar-wallets-kit: ${network.passphrase}`,
      );
  }
}

// the picker modal is a shadow-DOM web component that can't read our CSS
// variables, so it gets concrete copies of the globals.css palettes. keep these
// in step with the dark and light blocks there.
const KIT_THEMES: Record<"dark" | "light", SwkAppTheme> = {
  dark: {
    background: "#141618",
    "background-secondary": "#1a1d1f",
    "foreground-strong": "#eef0f2",
    foreground: "#a4a9b0",
    "foreground-secondary": "#848a92",
    primary: "#46a479",
    "primary-foreground": "#08140d",
    transparent: "transparent",
    lighter: "#212528",
    light: "#1a1d1f",
    "light-gray": "#363b40",
    gray: "#848a92",
    danger: "#d9756a",
    border: "#282b2e",
    shadow: "rgba(0, 0, 0, 0.5)",
    "border-radius": "12px",
    "font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
  },
  light: {
    background: "#ffffff",
    "background-secondary": "#f4f6f8",
    "foreground-strong": "#15171a",
    foreground: "#4a505a",
    "foreground-secondary": "#646a71",
    primary: "#1f7a52",
    "primary-foreground": "#ffffff",
    transparent: "transparent",
    lighter: "#e9edf1",
    light: "#f4f6f8",
    "light-gray": "#ccd2d9",
    gray: "#646a71",
    danger: "#b34a3f",
    border: "#e2e6ea",
    shadow: "rgba(10, 12, 14, 0.08)",
    "border-radius": "12px",
    "font-family": "Geist, ui-sans-serif, system-ui, sans-serif",
  },
};

// the page's theme as layout.tsx and ThemeProvider set it. anything but "light"
// renders with the dark palette, so the picker follows the same rule.
function pageTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

// called right before the picker opens, so a theme switch since the last
// opening is picked up
export function applyKitTheme(): void {
  StellarWalletsKit.setTheme(KIT_THEMES[pageTheme()]);
}

function wcTargetChain(network: NetworkConfig): WalletConnectTargetChain {
  return network.passphrase === KitNetworks.PUBLIC
    ? WalletConnectTargetChain.PUBLIC
    : WalletConnectTargetChain.TESTNET;
}

// the real WalletConnect module. constructing it runs SignClient.init (a relay
// socket) and createAppKit, whose mandatory INITIALIZE event reports the page url
// to pulse.walletconnect.org. so it is built only when WalletConnect is actually
// used: the user picks it in the picker, or signs with a restored WalletConnect
// session. never on page load, session restore or another wallet's connect.
let wcModule: WalletConnectModule | null = null;
let wcChain: WalletConnectTargetChain = WalletConnectTargetChain.PUBLIC;

function realWalletConnect(projectId: string): WalletConnectModule {
  if (wcModule) return wcModule;
  const origin = window.location.origin;
  wcModule = new WalletConnectModule({
    projectId,
    allowedChains: [wcChain],
    metadata: {
      name: "Account Demolisher",
      description: "Close a Stellar account and reclaim its reserves",
      url: origin,
      icons: [`${origin}/icon.svg`],
    },
  });
  return wcModule;
}

function setWalletConnectChain(network: NetworkConfig): void {
  wcChain = wcTargetChain(network);
  if (wcModule) wcModule.wcParams.allowedChains = [wcChain];
}

// how long a picked WalletConnect waits for its relay handshake before failing
const WC_READY_TIMEOUT_MS = 15_000;

// stands in for WalletConnect in the module list until it is used. the picker
// only needs the id, name, icon and availability, none of which require the
// relay, so the real module (and its network traffic) waits for the first call
// that does.
class LazyWalletConnectModule implements ModuleInterface {
  moduleType = ModuleType.BRIDGE_WALLET;
  productId = WALLET_CONNECT_ID;
  productName = "WalletConnect";
  productUrl = "https://walletconnect.com/";
  productIcon = "https://stellar.creit.tech/wallet-icons/walletconnect.png";

  readonly #projectId: string;

  constructor(projectId: string) {
    this.#projectId = projectId;
  }

  // the real module's isAvailable only turns true after its relay handshake.
  // configured is enough here: the handshake runs when the user picks it.
  async isAvailable(): Promise<boolean> {
    return true;
  }

  // same check the real module makes: Freighter mobile's in-app browser
  // connects through WalletConnect without showing the picker
  async isPlatformWrapper(): Promise<boolean> {
    const host = (window as { stellar?: { provider?: unknown; platform?: unknown } }).stellar;
    return host?.provider === "freighter" && host?.platform === "mobile";
  }

  async #ready(): Promise<WalletConnectModule> {
    const real = realWalletConnect(this.#projectId);
    const deadline = Date.now() + WC_READY_TIMEOUT_MS;
    while (!(await real.isAvailable())) {
      if (Date.now() >= deadline) {
        throw new Error(
          "WalletConnect could not reach its relay. Check your connection and try again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return real;
  }

  async getAddress(): Promise<{ address: string }> {
    return (await this.#ready()).getAddress();
  }

  async signTransaction(...args: Parameters<WalletConnectModule["signTransaction"]>) {
    return (await this.#ready()).signTransaction(...args);
  }

  async signAndSubmitTransaction(
    ...args: Parameters<WalletConnectModule["signAndSubmitTransaction"]>
  ) {
    return (await this.#ready()).signAndSubmitTransaction(...args);
  }

  async signAuthEntry(...args: Parameters<WalletConnectModule["signAuthEntry"]>) {
    return (await this.#ready()).signAuthEntry(...args);
  }

  async signMessage(...args: Parameters<WalletConnectModule["signMessage"]>) {
    return (await this.#ready()).signMessage(...args);
  }

  async getNetwork() {
    return (await this.#ready()).getNetwork();
  }

  // nothing to tear down when WalletConnect was never started
  async disconnect(): Promise<void> {
    if (wcModule) await wcModule.disconnect();
  }
}

// the wallet-picker module list: the kit's zero-config defaults plus Ledger
// (hardware, WebUSB) and, when configured, WalletConnect (mobile via QR)
function buildModules(): ModuleInterface[] {
  const modules: ModuleInterface[] = [...defaultModules(), new LedgerModule()];
  const projectId = getPublicEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (projectId) modules.push(new LazyWalletConnectModule(projectId));
  return modules;
}

// tracks the passphrase the kit was last initialized for, so we can switch
// networks but skip the init when it already matches
let initializedPassphrase: string | null = null;

// returns the process-wide kit handle configured for `network`. first call
// initializes; subsequent calls with a different network call setNetwork
export function getKit(network: NetworkConfig): KitHandle {
  const kitNetwork = toKitNetwork(network);

  if (initializedPassphrase === null) {
    setWalletConnectChain(network);
    StellarWalletsKit.init({
      modules: buildModules(),
      network: kitNetwork,
      theme: KIT_THEMES[pageTheme()],
      // label not-installed wallets with an "Install" link instead of hiding
      // them, so the list is predictable
      authModal: { showInstallLabel: true },
    });
    initializedPassphrase = network.passphrase;
    return StellarWalletsKit;
  }

  if (initializedPassphrase !== network.passphrase) {
    StellarWalletsKit.setNetwork(kitNetwork);
    setWalletConnectChain(network);
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

// the kit persists the connected session as these two keys (and clears both on
// disconnect). its usedWalletsIds key is only a most-recently-used list for
// ordering the picker that the kit never clears, so it says nothing about
// whether a session exists.
function hasPersistedKitSession(): boolean {
  try {
    const address = window.localStorage.getItem(LocalStorageKeys.activeAddress);
    const moduleId = window.localStorage.getItem(LocalStorageKeys.selectedModuleId);
    return !!address && !!moduleId;
  } catch {
    // storage unavailable (private mode, blocked site data): nothing to restore
    return false;
  }
}

// Silently restore a prior kit connection after a hard refresh. The kit persists
// the selected wallet id AND the address in localStorage and re-seeds them on
// init, so getAddress() returns the remembered address with NO wallet prompt.
// Returns the address if a session was persisted, or null if there is nothing to
// restore. Skips kit init entirely when nothing was persisted.
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

// the kit's session state, which it mirrors to localStorage on every change
export interface KitSessionSnapshot {
  readonly activeAddress: string | undefined;
  readonly selectedModuleId: string | undefined;
  readonly hardwareWalletPaths: typeof hardwareWalletPaths.value;
  readonly wcSessionPaths: typeof wcSessionPaths.value;
}

export function snapshotKitSession(): KitSessionSnapshot {
  return {
    activeAddress: activeAddress.value,
    selectedModuleId: selectedModuleId.value,
    hardwareWalletPaths: hardwareWalletPaths.value,
    wcSessionPaths: wcSessionPaths.value,
  };
}

const NO_SESSION: KitSessionSnapshot = {
  activeAddress: undefined,
  selectedModuleId: undefined,
  hardwareWalletPaths: [],
  wcSessionPaths: [],
};

// put the kit back to a snapshot, after closing the wallet used in between:
// WalletConnect sessions that were not there before are ended (a co-signer's
// phone pairing would otherwise stay live on the relay), and a different
// extension or device is disconnected. with no session in the snapshot the kit
// ends up fully disconnected.
//
// the kit's own disconnect() is never used here. it calls the selected module's
// disconnect() without awaiting it, so a failure would be an unhandled rejection,
// and the WalletConnect module's closeSession() calls it once the last session
// path is gone, which with WalletConnect still selected closes every relay
// session a second time while the first close is in flight. so the selection is
// cleared before anything is closed, and the snapshot is written back afterwards
// whether or not the closing worked. every close is attempted; failures are
// thrown together at the end.
export async function restoreKitSessionSnapshot(snapshot: KitSessionSnapshot): Promise<void> {
  const target =
    snapshot.activeAddress === undefined || snapshot.selectedModuleId === undefined
      ? NO_SESSION
      : snapshot;
  const between = activeModules.value.find((m) => m.productId === selectedModuleId.value);
  const keptTopics = new Set(target.wcSessionPaths.map((p) => p.topic));
  const strayTopics = [
    ...new Set(wcSessionPaths.value.map((p) => p.topic).filter((t) => !keptTopics.has(t))),
  ];
  const failures: unknown[] = [];
  selectedModuleId.value = undefined;
  try {
    for (const topic of strayTopics) {
      try {
        if (wcModule === null) {
          throw new Error(
            `WalletConnect session ${topic} is open but WalletConnect is not running`,
          );
        }
        await wcModule.closeSession(topic);
      } catch (e) {
        failures.push(e);
      }
    }
    if (
      between !== undefined &&
      between.productId !== target.selectedModuleId &&
      between.productId !== WALLET_CONNECT_ID
    ) {
      try {
        await between.disconnect?.();
      } catch (e) {
        failures.push(e);
      }
    }
  } finally {
    hardwareWalletPaths.value = target.hardwareWalletPaths;
    wcSessionPaths.value = target.wcSessionPaths;
    selectedModuleId.value = target.selectedModuleId;
    activeAddress.value = target.activeAddress;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "the wallet used for signing could not be disconnected");
  }
}
