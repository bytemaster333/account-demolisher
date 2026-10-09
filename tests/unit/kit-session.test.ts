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
  // false while the relay handshake has not finished: the module has no sign
  // client yet and isAvailable() says so
  relayUp: true,
  // when set, every relay disconnect waits for it, so a test can act while a
  // teardown is still in flight
  hold: null as Promise<void> | null,
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
    readonly #client: {
      session: { keys: string[] };
      disconnect: (p: { topic: string }) => Promise<void>;
    };
    // the real module assigns its sign client once SignClient.init resolves
    get signClient() {
      return wc.relayUp ? this.#client : undefined;
    }
    constructor(params: { allowedChains?: string[] }) {
      wc.constructed++;
      this.wcParams = params;
      this.#client = {
        session: {
          get keys() {
            return [...wc.sessions];
          },
        },
        disconnect: async ({ topic }) => {
          wc.disconnects.push(topic);
          if (!wc.sessions.has(topic)) {
            throw new Error(`Session or pairing topic not found: ${topic}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (wc.hold) await wc.hold;
          if (topic === wc.failTopic)
            throw new Error("Failed to publish payload, please try again.");
          if (!wc.sessions.has(topic)) throw new Error(`No matching key. session: ${topic}`);
          wc.sessions.delete(topic);
        },
      };
    }
    async isAvailable() {
      return wc.relayUp;
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
      await this.#client.disconnect({ topic });
    }
    async disconnect() {
      for (const topic of [...wc.sessions]) await this.closeSession(topic);
    }
    // the sign client's own session list, which outlives a failed close
    async getSessions() {
      return [...wc.sessions].map((topic) => ({ topic }));
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
  // transform our wrappers once here, so the first test is not the one that pays
  // for it (on a loaded machine that alone ran past the 5s test timeout)
  await import("@/lib/wallet/kit");
  await import("@/lib/wallet/connector");
}, 60_000);

// a fresh page: our kit wrapper is re-imported (its module state starts empty)
// and the kit's session state is what it reads from localStorage on load
async function pageLoad(storage: Record<string, string>) {
  vi.resetModules();
  vi.restoreAllMocks();
  wc.constructed = 0;
  wc.sessions.clear();
  wc.disconnects = [];
  wc.failTopic = null;
  wc.relayUp = true;
  wc.hold = null;
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// the co-signer can close or leave /sign while the wallet is still open: the
// restore after run() then never happens, so leaving has to do it
describe("leaving /sign mid-signing does not keep the co-signer's wallet (L-106)", () => {
  it("puts the initiator's session back when the tab is closed", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const wallet = deferred<string>();
    const teardown = vi.fn();
    const signing = connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        return wallet.promise;
      },
      teardown,
    );
    expect(window.localStorage.getItem(ADDRESS)).toBe(B);

    window.dispatchEvent(new Event("pagehide"));
    // written before anything is awaited, so it lands even while the page unloads
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
    expect(window.localStorage.getItem(MODULE)).toBe("freighter");

    // the next page load brings back the initiator, not the co-signer
    const stored = {
      [ADDRESS]: window.localStorage.getItem(ADDRESS)!,
      [MODULE]: window.localStorage.getItem(MODULE)!,
    };
    wallet.resolve("signed");
    await expect(signing).resolves.toBe("signed");
    await settle();
    expect(teardown).not.toHaveBeenCalled();
    const next = await pageLoad(stored);
    await expect(next.kit.restoreKitSession(TESTNET)).resolves.toBe(A);
  });

  it("leaves no session when there was none and the tab is closed", async () => {
    const { connector } = await pageLoad({});
    const wallet = deferred<string>();
    const signing = connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        return wallet.promise;
      },
      vi.fn(),
    );
    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(ADDRESS)).toBeNull();
    expect(window.localStorage.getItem(MODULE)).toBeNull();
    wallet.resolve("signed");
    await signing;
    await settle();
    const next = await pageLoad({});
    await expect(next.kit.restoreKitSession(TESTNET)).resolves.toBeNull();
  });

  it("stops listening for the tab closing once the session settled", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    await connector.withScopedKitSession(TESTNET, async () => pickInModal("xbull", B), vi.fn());
    // the app's own wallet changes afterwards; a late pagehide must not undo it
    pickInModal("xbull", B);
    window.dispatchEvent(new Event("pagehide"));
    expect(window.localStorage.getItem(ADDRESS)).toBe(B);
  });

  it("puts the initiator's session back when the page is left in the app", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const left = new AbortController();
    const wallet = deferred<string>();
    const signing = connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        return wallet.promise;
      },
      vi.fn(),
      left.signal,
    );
    left.abort();
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");

    // the app connects another wallet before the co-signer's wallet answers;
    // that late answer must not put the old session back over it
    pickInModal("xbull", B);
    wallet.resolve("signed");
    await expect(signing).resolves.toBe("signed");
    await settle();
    expect(window.localStorage.getItem(ADDRESS)).toBe(B);
  });

  it("lets go of a wallet picked after the page was left", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const left = new AbortController();
    const picker = deferred<{ address: string }>();
    vi.spyOn(kitApi.StellarWalletsKit, "authModal").mockImplementation(async () => {
      const picked = await picker.promise;
      pickInModal("xbull", picked.address);
      return picked;
    });
    const signing = connector.withScopedKitSession(
      TESTNET,
      async (c) => {
        await c.connect();
        return "signed";
      },
      vi.fn(),
      left.signal,
    );
    left.abort();
    picker.resolve({ address: B });
    await expect(signing).rejects.toThrow(/left before the wallet was picked/);
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
    expect(window.localStorage.getItem(MODULE)).toBe("freighter");
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

describe("a teardown report that throws does not cost the signature", () => {
  it("returns the signature and logs the reporter's own failure", async () => {
    const page = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    page.kit.getKit(TESTNET);
    const xbull = kitApi.activeModules.value.find((m) => m.productId === "xbull")!;
    const refused = new Error("extension refused to disconnect");
    vi.spyOn(xbull, "disconnect").mockRejectedValue(refused);
    const reporterBroke = new Error("setState after unmount");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await page.connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        return "signed";
      },
      () => {
        throw reporterBroke;
      },
    );
    expect(result).toBe("signed");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]).toContain(reporterBroke);
    expect(logged.mock.calls[0]).toContain(refused);
    expect(kitApi.activeAddress.value).toBe(A);
  });
});

describe("a user disconnect closes the wallet and reports what failed", () => {
  function emptySession() {
    expect(kitApi.activeAddress.value).toBeUndefined();
    expect(kitApi.selectedModuleId.value).toBeUndefined();
    expect(kitApi.wcSessionPaths.value).toEqual([]);
    expect(window.localStorage.getItem(ADDRESS)).toBeNull();
    expect(window.localStorage.getItem(MODULE)).toBeNull();
  }

  it("waits for the extension to disconnect and rejects with its failure", async () => {
    const { kit } = await pageLoad({ [ADDRESS]: A, [MODULE]: "xbull" });
    kit.getKit(TESTNET);
    const xbull = kitApi.activeModules.value.find((m) => m.productId === "xbull")!;
    const refused = new Error("extension refused to disconnect");
    vi.spyOn(xbull, "disconnect").mockRejectedValue(refused);
    await expect(kit.disconnectKit()).rejects.toBe(refused);
    emptySession();
  });

  it("disconnects the extension through the connector too", async () => {
    const { kit, connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "xbull" });
    kit.getKit(TESTNET);
    await new connector.WalletKitConnector(TESTNET).disconnect();
    expect(extensionDisconnects).toEqual(["xbull"]);
    emptySession();
  });

  it("ends a WalletConnect session restored from the last visit", async () => {
    const { kit } = await pageLoad({ [ADDRESS]: A, [MODULE]: "wallet_connect" });
    await kit.restoreKitSession(MAINNET);
    kitApi.wcSessionPaths.value = [{ publicKey: A, topic: "topic-app" }];
    wc.sessions.add("topic-app");
    expect(wc.constructed).toBe(0);
    await kit.disconnectKit();
    await settle();
    expect(wc.constructed).toBe(1);
    expect(wc.disconnects).toEqual(["topic-app"]);
    expect(wc.sessions.size).toBe(0);
    emptySession();
  });

  it("rejects when the WalletConnect relay refuses the disconnect", async () => {
    const { kit } = await pageLoad({ [ADDRESS]: A, [MODULE]: "wallet_connect" });
    await kit.restoreKitSession(MAINNET);
    kitApi.wcSessionPaths.value = [{ publicKey: A, topic: "topic-app" }];
    wc.sessions.add("topic-app");
    wc.failTopic = "topic-app";
    await expect(kit.disconnectKit()).rejects.toThrow("Failed to publish payload");
    await settle();
    emptySession();
  });

  it("ends a co-signer's WalletConnect pairing whose earlier close failed", async () => {
    const { kit, connector } = await pageLoad({});
    wc.failTopic = "topic-cosigner";
    const teardown = vi.fn();
    await connector.withScopedKitSession(
      TESTNET,
      () => pickWalletConnect(B, "topic-cosigner"),
      teardown,
    );
    await settle();
    expect(teardown).toHaveBeenCalledOnce();
    expect([...wc.sessions]).toEqual(["topic-cosigner"]);
    wc.failTopic = null;
    await kit.disconnectKit();
    await settle();
    expect(wc.sessions.size).toBe(0);
    emptySession();
  });

  it("tells the kit's listeners, as the kit's own disconnect does", async () => {
    const { kit, connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    kit.getKit(TESTNET);
    const heard = vi.fn();
    const unsubscribe = kitApi.StellarWalletsKit.on(kitApi.KitEventType.DISCONNECT, heard);
    try {
      await kit.disconnectKit();
      expect(heard).toHaveBeenCalledOnce();
      // a co-signature with no app session before also ends disconnected
      await connector.withScopedKitSession(TESTNET, async () => pickInModal("xbull", B), vi.fn());
      expect(heard).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
});

// AppShell, DemolishFlow and the connect button clear the app first and let the
// kit teardown finish in the background, so the user can already be connecting
// again while a slow extension or the walletconnect relay is still closing
describe("a teardown never undoes a wallet connected while it ran", () => {
  function held() {
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    return { until, release };
  }

  async function onWalletConnect() {
    const page = await pageLoad({ [ADDRESS]: A, [MODULE]: "wallet_connect" });
    await page.kit.restoreKitSession(MAINNET);
    kitApi.wcSessionPaths.value = [{ publicKey: A, topic: "topic-app" }];
    wc.sessions.add("topic-app");
    return page;
  }

  it("keeps a wallet picked while the old extension was still disconnecting", async () => {
    const { kit } = await pageLoad({ [ADDRESS]: A, [MODULE]: "xbull" });
    kit.getKit(TESTNET);
    const xbull = kitApi.activeModules.value.find((m) => m.productId === "xbull")!;
    const slow = held();
    vi.spyOn(xbull, "disconnect").mockReturnValue(slow.until);
    const teardown = kit.disconnectKit();
    await settle();
    pickInModal("freighter", B);
    slow.release();
    await teardown;
    await settle();
    expect(kitApi.selectedModuleId.value).toBe("freighter");
    expect(kitApi.activeAddress.value).toBe(B);
    expect(window.localStorage.getItem(MODULE)).toBe("freighter");
    expect(window.localStorage.getItem(ADDRESS)).toBe(B);
  });

  it("keeps a wallet picked while a WalletConnect session was still closing", async () => {
    const { kit } = await onWalletConnect();
    const slow = held();
    wc.hold = slow.until;
    const teardown = kit.disconnectKit();
    await settle();
    pickInModal("freighter", B);
    slow.release();
    await teardown;
    await settle();
    expect(wc.disconnects).toEqual(["topic-app"]);
    expect(wc.sessions.size).toBe(0);
    expect(extensionDisconnects).toEqual([]);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
    expect(kitApi.activeAddress.value).toBe(B);
    expect(window.localStorage.getItem(ADDRESS)).toBe(B);
  });

  it("leaves a new WalletConnect pairing open while the old one was still closing", async () => {
    const { kit } = await onWalletConnect();
    const slow = held();
    wc.hold = slow.until;
    const teardown = kit.disconnectKit();
    await settle();
    await pickWalletConnect(B, "topic-new");
    slow.release();
    await teardown;
    await settle();
    expect(wc.disconnects).toEqual(["topic-app"]);
    expect([...wc.sessions]).toEqual(["topic-new"]);
    expect(kitApi.wcSessionPaths.value).toEqual([{ publicKey: B, topic: "topic-new" }]);
    expect(kitApi.selectedModuleId.value).toBe("wallet_connect");
    expect(kitApi.activeAddress.value).toBe(B);
  });

  it("keeps a wallet picked while a co-signer's extension was still disconnecting", async () => {
    const { kit, connector } = await pageLoad({});
    kit.getKit(TESTNET);
    const xbull = kitApi.activeModules.value.find((m) => m.productId === "xbull")!;
    const slow = held();
    vi.spyOn(xbull, "disconnect").mockReturnValue(slow.until);
    const signed = connector.withScopedKitSession(
      TESTNET,
      async () => {
        pickInModal("xbull", B);
        return "signed";
      },
      vi.fn(),
    );
    await settle();
    pickInModal("freighter", A);
    slow.release();
    await expect(signed).resolves.toBe("signed");
    await settle();
    expect(kitApi.selectedModuleId.value).toBe("freighter");
    expect(kitApi.activeAddress.value).toBe(A);
  });

  it("closes a WalletConnect session once when two disconnects overlap", async () => {
    const { kit } = await onWalletConnect();
    await expect(Promise.all([kit.disconnectKit(), kit.disconnectKit()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await settle();
    expect(wc.disconnects).toEqual(["topic-app"]);
    expect(wc.sessions.size).toBe(0);
    expect(kitApi.selectedModuleId.value).toBeUndefined();
  });

  it("does not wait for a WalletConnect relay that never came up when nothing is open on it", async () => {
    const { kit } = await pageLoad({});
    kit.getKit(TESTNET);
    // the user picked WalletConnect, its relay never answered, and they connected
    // Freighter instead
    wc.relayUp = false;
    const walletConnect = kitApi.activeModules.value.find((m) => m.productId === "wallet_connect")!;
    const abandoned = walletConnect.getAddress();
    await settle();
    expect(wc.constructed).toBe(1);
    pickInModal("freighter", A);
    const outcome = await Promise.race([
      kit.disconnectKit().then(() => "disconnected"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(outcome).toBe("disconnected");
    expect(kitApi.selectedModuleId.value).toBeUndefined();
    // let the abandoned pick finish so nothing keeps polling after the test
    wc.relayUp = true;
    await abandoned;
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
