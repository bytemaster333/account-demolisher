// wrapper around @creit.tech/stellar-wallets-kit v2.7.1 (static-class API:
// StellarWalletsKit.init/authModal/getAddress/signTransaction/disconnect/...)
import "@/lib/wallet/buffer-polyfill"; // Ledger needs a browser Buffer global
import {
  activeAddress,
  activeModules,
  closeEvent,
  disconnectEvent,
  hardwareWalletPaths,
  Networks as KitNetworks,
  LocalStorageKeys,
  ModuleType,
  routerHistory,
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
  type TWalletConnectModuleParams,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";

import { getPublicEnv } from "@/lib/config/env";
import type { NetworkConfig } from "@/lib/config/networks";
import { teardownFailures } from "@/lib/wallet/teardown-report";

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
// socket) and createAppKit. so it is built only when WalletConnect is actually
// used: the user picks it in the picker, signs with a restored WalletConnect
// session, or disconnects or closes a restored session. never on page load,
// session restore or another wallet's connect.
let wcModule: WalletConnectModule | null = null;
let wcChain: WalletConnectTargetChain = WalletConnectTargetChain.PUBLIC;

type AppKitOptions = NonNullable<TWalletConnectModuleParams["appKitOptions"]>;

// AppKit defaults features.analytics to true and then reports every modal event
// to pulse.walletconnect.org. its INITIALIZE and CONNECT_SUCCESS events are sent
// even with analytics off; the CSP (src/lib/config/csp.ts) blocks those. the kit
// spreads appKitOptions over its own createAppKit options, so only the keys set
// here change; the type still asks for projectId and networks, which the kit
// already passes itself.
const APPKIT_OVERRIDES: Partial<AppKitOptions> = { features: { analytics: false } };

function realWalletConnect(projectId: string): WalletConnectModule {
  if (wcModule) return wcModule;
  const origin = window.location.origin;
  wcModule = new WalletConnectModule({
    projectId,
    allowedChains: [wcChain],
    appKitOptions: APPKIT_OVERRIDES as AppKitOptions,
    // the sign client's core keeps its own event log for pulse.walletconnect.org
    signClientOptions: { telemetryEnabled: false },
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

// the real module, once its sign client is up. it has no session list or
// closeSession before that.
async function readyWalletConnect(projectId: string): Promise<WalletConnectModule> {
  const real = realWalletConnect(projectId);
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

// walletconnect for closing sessions. a session restored from the last visit
// has to be closed through the relay too, so this starts the module when it is
// not running yet.
async function walletConnectForTeardown(): Promise<WalletConnectModule> {
  if (wcModule !== null) return readyWalletConnect(wcModule.wcParams.projectId);
  const projectId = getPublicEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      "A WalletConnect session is open, but WalletConnect is not configured on this site, " +
        "so it cannot be closed from here. End it in your wallet app.",
    );
  }
  return readyWalletConnect(projectId);
}

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

  #ready(): Promise<WalletConnectModule> {
    return readyWalletConnect(this.#projectId);
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

// fully disconnect the kit: close the selected wallet and every walletconnect
// session, and reset the kit's state, so the extension no longer treats the site
// as connected and a later connect opens the picker again. the state is reset
// before any wallet is asked, so a refusal cannot keep it; the refusal is thrown
// afterwards so the caller can tell the user. does nothing when the kit was
// never initialized, and is safe to repeat or overlap.
export async function disconnectKit(): Promise<void> {
  if (initializedPassphrase === null) return;
  await returnKitTo(NO_SESSION, true);
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

// restore a kit connection after a hard refresh without a wallet prompt. the kit
// keeps the selected wallet id and the address in localStorage and re-seeds both
// on init, so getAddress() returns the remembered address. returns null, without
// initializing the kit, when nothing was persisted.
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
export async function restoreKitSessionSnapshot(snapshot: KitSessionSnapshot): Promise<void> {
  const target =
    snapshot.activeAddress === undefined || snapshot.selectedModuleId === undefined
      ? NO_SESSION
      : snapshot;
  await returnKitTo(target, false);
}

// sign client topics a teardown is closing right now, so an overlapping one (a
// second disconnect while the first still waits on the relay) leaves them alone
// instead of closing them twice
const closingTopics = new Set<string>();

// the kit's own disconnect() is never used here: it calls the selected module's
// disconnect() without awaiting it, so a failure would be an unhandled
// rejection. walletconnect sessions are ended through the sign client, not the
// module's closeSession(), because that runs the kit's disconnect() once the
// last session path is gone, which would reset whatever is selected by then.
//
// the target is written before anything is awaited, as the kit's own disconnect
// does. the app lets go of the wallet first and leaves this running in the
// background, so the user can be connecting again while an extension or the
// relay is still slow to answer, and that new connection has to survive it.
// what gets closed is fixed up front for the same reason: the module selected
// before, the topics the kit listed and, with allWalletConnect, every other
// sign client session open right now (such as a co-signer pairing whose earlier
// close failed on the relay). every close is attempted; failures are thrown
// together at the end.
async function returnKitTo(target: KitSessionSnapshot, allWalletConnect: boolean): Promise<void> {
  const between = activeModules.value.find((m) => m.productId === selectedModuleId.value);
  const keptTopics = new Set(target.wcSessionPaths.map((p) => p.topic));
  const listed = wcSessionPaths.value.map((p) => p.topic);
  // only a sign client that is already up is swept. one that never reached its
  // relay holds nothing the kit lost track of in this page, and waiting for it
  // would hold every later disconnect for the whole relay timeout.
  const running: WalletConnectModule["signClient"] | undefined = wcModule?.signClient;
  const unlisted = allWalletConnect && running ? running.session.keys : [];
  const topics = [...new Set([...listed, ...unlisted])].filter(
    (t) => !keptTopics.has(t) && !closingTopics.has(t),
  );

  hardwareWalletPaths.value = target.hardwareWalletPaths;
  wcSessionPaths.value = target.wcSessionPaths;
  selectedModuleId.value = target.selectedModuleId;
  activeAddress.value = target.activeAddress;
  if (target === NO_SESSION) {
    // what the kit's own disconnect does last, for anything listening to it
    routerHistory.value = [];
    disconnectEvent.next();
    closeEvent.next();
  }

  const failures: unknown[] = [];
  const closes: Promise<void>[] = [];
  if (
    between !== undefined &&
    between.productId !== target.selectedModuleId &&
    between.productId !== WALLET_CONNECT_ID
  ) {
    closes.push(
      (async () => {
        try {
          await between.disconnect?.();
        } catch (e) {
          failures.push(e);
        }
      })(),
    );
  }
  if (topics.length > 0) closes.push(closeWalletConnectTopics(topics, failures));
  await Promise.all(closes);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw teardownFailures(failures);
}

async function closeWalletConnectTopics(topics: string[], failures: unknown[]): Promise<void> {
  for (const topic of topics) closingTopics.add(topic);
  try {
    const { signClient } = await walletConnectForTeardown();
    for (const topic of topics) {
      try {
        await signClient.disconnect({ topic, reason: { message: "Session closed", code: -1 } });
      } catch (e) {
        failures.push(e);
      }
    }
  } catch (e) {
    failures.push(e);
  } finally {
    for (const topic of topics) closingTopics.delete(topic);
  }
}
