// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { MAINNET, TESTNET } from "@/lib/config/networks";

// counts real WalletConnect constructions: building that module opens a relay
// socket and makes AppKit report the page url to WalletConnect, so it must only
// happen when the user actually uses WalletConnect
const wc = vi.hoisted(() => ({ constructed: 0, address: "" }));

vi.mock("@creit.tech/stellar-wallets-kit/modules/wallet-connect", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@creit.tech/stellar-wallets-kit/modules/wallet-connect")>();
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
    async disconnect() {}
  }
  return { ...original, WalletConnectModule: CountingWalletConnectModule };
});

// two stand-in browser wallets instead of the kit's real extension modules,
// which do not load under vitest
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

describe("co-signing does not replace the app's wallet session (L-106)", () => {
  // what the kit's picker does when the co-signer picks a wallet
  function pickInModal(moduleId: string, address: string) {
    kitApi.selectedModuleId.value = moduleId;
    kitApi.activeAddress.value = address;
  }

  it("puts the initiator's session back after a co-signer signs with another wallet", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const result = await connector.withScopedKitSession(TESTNET, async () => {
      pickInModal("xbull", B);
      expect(window.localStorage.getItem(ADDRESS)).toBe(B);
      return "signed";
    });
    expect(result).toBe("signed");
    expect(kitApi.activeAddress.value).toBe(A);
    expect(kitApi.selectedModuleId.value).toBe("freighter");
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
    expect(window.localStorage.getItem(MODULE)).toBe("freighter");
  });

  it("leaves no session behind when there was none before", async () => {
    const { connector, kit } = await pageLoad({});
    await connector.withScopedKitSession(TESTNET, async () => {
      pickInModal("xbull", B);
    });
    expect(kitApi.activeAddress.value).toBeUndefined();
    expect(window.localStorage.getItem(ADDRESS)).toBeNull();
    expect(window.localStorage.getItem(MODULE)).toBeNull();
    // a reload now restores nothing
    await expect(kit.restoreKitSession(TESTNET)).resolves.toBeNull();
  });

  it("restores the session when signing fails and passes the error on", async () => {
    const { connector } = await pageLoad({ [ADDRESS]: A, [MODULE]: "freighter" });
    const boom = new Error("user declined");
    await expect(
      connector.withScopedKitSession(TESTNET, async () => {
        pickInModal("xbull", B);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(window.localStorage.getItem(ADDRESS)).toBe(A);
  });
});

beforeEach(() => {
  wc.address = "";
});
