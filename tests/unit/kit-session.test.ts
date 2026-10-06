// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { MAINNET, TESTNET } from "@/lib/config/networks";

// counts real WalletConnect constructions: building that module opens a relay
// socket and makes AppKit report the page url to WalletConnect, so it must only
// happen when the user actually uses WalletConnect
const wc = vi.hoisted(() => ({
  constructed: 0,
  address: "",
  // the sign client's open sessions, and every relay disconnect it was asked for
  sessions: new Set<string>(),
  disconnects: [] as string[],
  // a topic whose relay disconnect fails (the relay is unreachable)
  failTopic: null as string | null,
}));

vi.mock("@creit.tech/stellar-wallets-kit/modules/wallet-connect", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@creit.tech/stellar-wallets-kit/modules/wallet-connect")>();
  // follows wallet-connect.module.js in kit 2.7.0 and the sign client's
  // disconnect: the topic is validated, the relay publish is awaited, and only
  // then is the session deleted, so two overlapping disconnects of one topic
  // both pass validation and the later delete throws
  class CountingWalletConnectModule {
    wcParams: { allowedChains?: string[] };
    constructor(params: { allowedChains?: string[] }) {
      wc.constructed++;
      this.wcParams = params;
    }
    async isAvailable() {
      return true;
    }
    async getAddress() {
      return { address: wc.address };
    }
    async closeSession(topic: string) {
      const kit = await import("@creit.tech/stellar-wallets-kit");
      kit.wcSessionPaths.value = kit.wcSessionPaths.value.filter((p) => p.topic !== topic);
      // the real module calls the kit's internal disconnect() here, unawaited,
      // and that calls the selected module's disconnect() unawaited too
      if (kit.wcSessionPaths.value.length === 0) void kit.StellarWalletsKit.disconnect();
      await this.signClientDisconnect(topic);
    }
    async signClientDisconnect(topic: string) {
      wc.disconnects.push(topic);
      if (!wc.sessions.has(topic)) throw new Error(`Session or pairing topic not found: ${topic}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (topic === wc.failTopic) throw new Error("Failed to publish payload, please try again.");
      if (!wc.sessions.has(topic)) throw new Error(`No matching key. session: ${topic}`);
      wc.sessions.delete(topic);
    }
    async disconnect() {
      for (const topic of [...wc.sessions]) await this.closeSession(topic);
    }
  }
  return { ...original, WalletConnectModule: CountingWalletConnectModule };
});

// two stand-in browser wallets instead of the kit's real extension modules,
// which do not load under vitest
const extensionDisconnects = vi.hoisted(() => [] as string[]);

vi.mock("@creit.tech/stellar-wallets-kit/modules/utils", () => {
  const wallet = (productId: string) => ({
    moduleType: "HOT_WALLET",
    productId,
    productName: productId,
    productUrl: "https://example.com",
    productIcon: "https://example.com/icon.png",
    isAvailable: async () => true,
    getAddress: async () => ({ address: "" }),
    signTransaction: async () => ({ signedTxXdr: "" }),
    signAuthEntry: async () => ({ signedAuthEntry: "" }),
    signMessage: async () => ({ signedMessage: "" }),
    getNetwork: async () => ({ network: "", networkPassphrase: "" }),
    disconnect: async () => {
      extensionDisconnects.push(productId);
    },
  });
  return { defaultModules: () => [wallet("freighter"), wallet("xbull")] };
});

const A = Keypair.random().publicKey();
const B = Keypair.random().publicKey();

let kitApi: typeof import("@creit.tech/stellar-wallets-kit");

beforeAll(async () => {
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "test-project-id";
  kitApi = await import("@creit.tech/stellar-wallets-kit");
});

// a fresh page: our kit wrapper is re-imported (its module state starts empty)
// and the kit's session state is what it reads from localStorage on load
async function pageLoad(storage: Record<string, string>) {
  vi.resetModules();
  vi.restoreAllMocks();
  wc.constructed = 0;
  wc.sessions.clear();
  wc.disconnects = [];
  wc.failTopic = null;
  extensionDisconnects.length = 0;
  window.localStorage.clear();
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  // read everything first: the kit mirrors each signal change back to storage
  const keys = kitApi.LocalStorageKeys;
  const address = window.localStorage.getItem(keys.activeAddress) || undefined;
  const moduleId = window.localStorage.getItem(keys.selectedModuleId) || undefined;
  kitApi.activeAddress.value = address;
  kitApi.selectedModuleId.value = moduleId;
  kitApi.hardwareWalletPaths.value = [];
  kitApi.wcSessionPaths.value = [];
  const init = vi.spyOn(kitApi.StellarWalletsKit, "init");
  const kit = await import("@/lib/wallet/kit");
  const connector = await import("@/lib/wallet/connector");
  return { kit, connector, init };
}

const USED = "@StellarWalletsKit/usedWalletsIds";
const ADDRESS = "@StellarWalletsKit/activeAddress";
const MODULE = "@StellarWalletsKit/selectedModuleId";

describe("session restore and WalletConnect start-up (L-105)", () => {
  it("does not touch the kit when only the wallet history is stored (after a disconnect)", async () => {
    const { kit, init } = await pageLoad({
      [USED]: JSON.stringify(["wallet_connect", "freighter"]),
    });
    await expect(kit.restoreKitSession(TESTNET)).resolves.toBeNull();
    expect(init).not.toHaveBeenCalled();
    expect(wc.constructed).toBe(0);
  });

  it("restores a Freighter session without starting WalletConnect", async () => {
    const { kit } = await pageLoad({
      [USED]: JSON.stringify(["freighter"]),
      [ADDRESS]: A,
      [MODULE]: "freighter",
    });
    await expect(kit.restoreKitSession(TESTNET)).resolves.toBe(A);
    expect(wc.constructed).toBe(0);
    // WalletConnect is still offered in the picker
    expect(kitApi.activeModules.value.map((m) => m.productId)).toContain("wallet_connect");
  });

  it("restores a WalletConnect session without starting it until it is used", async () => {
    const { kit } = await pageLoad({ [ADDRESS]: A, [MODULE]: "wallet_connect" });
    await expect(kit.restoreKitSession(MAINNET)).resolves.toBe(A);
    expect(wc.constructed).toBe(0);
  });

  it("starts WalletConnect once, on the chain of the active network, when it is picked", async () => {
    const { kit } = await pageLoad({});
    kit.getKit(TESTNET);
    expect(wc.constructed).toBe(0);
    wc.address = B;
    const picked = kitApi.activeModules.value.find((m) => m.productId === "wallet_connect")!;
    await expect(picked.isAvailable()).resolves.toBe(true);
    await expect(picked.getAddress()).resolves.toEqual({ address: B });
    await picked.getAddress();
    expect(wc.constructed).toBe(1);
  });

  it("leaves WalletConnect out entirely when no project id is configured", async () => {
    const saved = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    try {
      const { kit } = await pageLoad({});
      kit.getKit(TESTNET);
      expect(kitApi.activeModules.value.map((m) => m.productId)).not.toContain("wallet_connect");
    } finally {
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = saved;
    }
  });
});

// what the kit's picker does when the co-signer picks a wallet
function pickInModal(moduleId: string, address: string) {
  kitApi.selectedModuleId.value = moduleId;
  kitApi.activeAddress.value = address;
}

// what the WalletConnect picker leaves behind: the started module, an open sign
// client session, and one more session path for the account the phone approved
async function pickWalletConnect(address: string, topic: string) {
  const mod = kitApi.activeModules.value.find((m) => m.productId === "wallet_connect")!;
  wc.address = address;
  await mod.getAddress();
  wc.sessions.add(topic);
  kitApi.wcSessionPaths.value = [...kitApi.wcSessionPaths.value, { publicKey: address, topic }];
  pickInModal("wallet_connect", address);
}

// the kit fires its module disconnects without awaiting them, so give anything
// they started time to finish (or to fail) before looking
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("co-signing does not replace the app's wallet session (L-106)", () => {
  it("puts the initiator's session back after a co-signer signs with another wallet", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const teardown = vi.fn();
    const result = await connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        expect(window.localStorage.getItem(ADDRESS)).toBe(B);
        return "signed";
      },
      teardown,
    );
    expect(result).toBe("signed");
    expect(teardown).not.toHaveBeenCalled();
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
    expect(window.localStorage.getItem(MODULE)).toBe("freighter");
  });

  it("leaves no session behind when there was none before", async () => {
    const { connector, kit } = await pageLoad({});
    const teardown = vi.fn();
    await connector.withScopedKitSession(TESTNET, async () => pickInModal("xbull", B), teardown);
    expect(teardown).not.toHaveBeenCalled();
    expect(extensionDisconnects).toEqual(["xbull"]);
    expect(kitApi.activeAddress.value).toBeUndefined();
    expect(window.localStorage.getItem(ADDRESS)).toBeNull();
    expect(window.localStorage.getItem(MODULE)).toBeNull();
    // a reload now restores nothing
    await expect(kit.restoreKitSession(TESTNET)).resolves.toBeNull();
  });

  it("restores the session when signing fails and passes the error on", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const boom = new Error("user declined");
    const teardown = vi.fn();
    await expect(
      connector.withScopedKitSession(
        TESTNET,
        async () => {
          pickInModal("xbull", B);
          throw boom;
        },
        teardown,
      ),
    ).rejects.toBe(boom);
    expect(teardown).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
  });
});

describe("the co-signer's own wallet connection is closed afterwards", () => {
  it("disconnects a different extension the co-signer used, not the app's", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    await connector.withScopedKitSession(TESTNET, async () => pickInModal("xbull", B), vi.fn());
    expect(extensionDisconnects).toEqual(["xbull"]);
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
  });

  it("leaves the app's extension alone when the co-signer used the same one", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    await connector.withScopedKitSession(TESTNET, async () => pickInModal("freighter", B), vi.fn());
    expect(extensionDisconnects).toEqual([]);
    expect(kitApi.activeAddress.value).toBe(A);
  });

  it("ends a co-signer's WalletConnect pairing once and keeps the app's extension session", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const teardown = vi.fn();
    await connector.withScopedKitSession(
      TESTNET,
      () => pickWalletConnect(B, "topic-cosigner"),
      teardown,
    );
    await settle();
    expect(wc.disconnects).toEqual(["topic-cosigner"]);
    expect(wc.sessions.size).toBe(0);
    expect(teardown).not.toHaveBeenCalled();
    expect(extensionDisconnects).toEqual([]);
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
    expect(kitApi.wcSessionPaths.value).toEqual([]);
  });

  it("ends a co-signer's WalletConnect pairing once when the app had no session", async () => {
    const { connector } = await pageLoad({});
    const teardown = vi.fn();
    await connector.withScopedKitSession(
      TESTNET,
      () => pickWalletConnect(B, "topic-cosigner"),
      teardown,
    );
    await settle();
    expect(wc.disconnects).toEqual(["topic-cosigner"]);
    expect(wc.sessions.size).toBe(0);
    expect(teardown).not.toHaveBeenCalled();
    expect(kitApi.activeAddress.value).toBeUndefined();
    expect(kitApi.selectedModuleId.value).toBeUndefined();
    expect(kitApi.wcSessionPaths.value).toEqual([]);
  });

  it("closes only the co-signer's WalletConnect session when the app is on WalletConnect too", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "wallet_connect" });
    kitApi.wcSessionPaths.value = [{ publicKey: A, topic: "topic-app" }];
    wc.sessions.add("topic-app");
    await connector.withScopedKitSession(
      TESTNET,
      () => pickWalletConnect(B, "topic-cosigner"),
      vi.fn(),
    );
    await settle();
    expect(wc.disconnects).toEqual(["topic-cosigner"]);
    expect([...wc.sessions]).toEqual(["topic-app"]);
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("wallet_connect");
    expect(kitApi.wcSessionPaths.value).toEqual([{ publicKey: A, topic: "topic-app" }]);
  });
});

describe("a failed wallet teardown never costs the signature or its error", () => {
  async function refusingXbull() {
    const page = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    page.kit.getKit(TESTNET);
    const xbull = kitApi.activeModules.value.find((m) => m.productId === "xbull")!;
    const refused = new Error("extension refused to disconnect");
    vi.spyOn(xbull, "disconnect").mockRejectedValue(refused);
    return { ...page, refused };
  }

  it("returns the signature and reports the teardown failure separately", async () => {
    const { connector, refused } = await refusingXbull();
    const teardown = vi.fn();
    const result = await connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        return "signed";
      },
      teardown,
    );
    expect(result).toBe("signed");
    expect(teardown).toHaveBeenCalledExactlyOnceWith(refused);
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
  });

  it("passes the signing error on, not the teardown failure", async () => {
    const { connector, refused } = await refusingXbull();
    const declined = new Error("user declined");
    const teardown = vi.fn();
    await expect(
      connector.withScopedKitSession(
        TESTNET,
        async () => {
          pickInModal("xbull", B);
          throw declined;
        },
        teardown,
      ),
    ).rejects.toBe(declined);
    expect(teardown).toHaveBeenCalledExactlyOnceWith(refused);
    expect(kitApi.activeAddress.value).toBe(A);
  });

  it("reports a WalletConnect relay failure and still restores the app's session", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    wc.failTopic = "topic-cosigner";
    const teardown = vi.fn();
    const result = await connector.withScopedKitSession(
      TESTNET,
      async () => {
        await pickWalletConnect(B, "topic-cosigner");
        return "signed";
      },
      teardown,
    );
    await settle();
    expect(result).toBe("signed");
    expect(teardown).toHaveBeenCalledOnce();
    expect(String(teardown.mock.calls[0]![0])).toContain("Failed to publish payload");
    expect(wc.disconnects).toEqual(["topic-cosigner"]);
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
  });
});

describe("the wallet picker follows the app theme (L-78)", () => {
  async function openPicker(theme: string | undefined) {
    const { connector } = await pageLoad({});
    if (theme === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    vi.spyOn(kitApi.StellarWalletsKit, "authModal").mockResolvedValue({ address: A });
    await new connector.WalletKitConnector(TESTNET).connect();
    return kitApi.theme.value;
  }

  it("uses the light palette in light mode", async () => {
    const theme = await openPicker("light");
    expect(theme.background).toBe("#ffffff");
    expect(theme["foreground-strong"]).toBe("#15171a");
    expect(theme["foreground-secondary"]).toBe("#646a71");
    expect(theme.primary).toBe("#1f7a52");
    expect(theme.danger).toBe("#b34a3f");
  });

  it("uses the dark palette in dark mode, with the AA-passing secondary text", async () => {
    const theme = await openPicker("dark");
    expect(theme.background).toBe("#141618");
    expect(theme["foreground-secondary"]).toBe("#848a92");
    expect(theme.gray).toBe("#848a92");
  });

  it("defaults to dark, like the page does before the theme is known", async () => {
    const theme = await openPicker(undefined);
    expect(theme.background).toBe("#141618");
  });

  it("switches when the theme changes between two openings", async () => {
    expect((await openPicker("dark")).background).toBe("#141618");
    document.documentElement.dataset.theme = "light";
    vi.spyOn(kitApi.StellarWalletsKit, "authModal").mockResolvedValue({ address: A });
    const { WalletKitConnector } = await import("@/lib/wallet/connector");
    await new WalletKitConnector(TESTNET).connect();
    expect(kitApi.theme.value.background).toBe("#ffffff");
  });
});

beforeEach(() => {
  wc.address = "";
});
