import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from "vitest";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { MAINNET, TESTNET, type NetworkConfig } from "@/lib/config/networks";
import {
  FRIENDBOT_TIMEOUT_MS,
  assertDemoSorobanTx,
  friendbotFund,
  isDemoNetwork,
  runDemoSetup,
  sizeLiquidityDeposit,
  submitAndPollSoroban,
} from "@/lib/wallet/demo-account";

const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const NATIVE_SAC = Asset.native().contractId(Networks.TESTNET);
const demo = Keypair.random();

afterEach(() => {
  vi.unstubAllGlobals();
});

function invoke(
  source: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  extraOps: xdr.Operation[] = [],
): Transaction {
  const b = new TransactionBuilder(new Account(source, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(new Contract(contractId).call(fn, ...args));
  for (const op of extraOps) b.addOperation(op);
  return b.setTimeout(60).build();
}

const addr = (a: string) => new Address(a).toScVal();
const swapArgs = (to: string) => [
  nativeToScVal(500_000_000n, { type: "i128" }),
  nativeToScVal(1n, { type: "i128" }),
  xdr.ScVal.scvVec([addr(NATIVE_SAC), addr(NATIVE_SAC)]),
  addr(to),
  nativeToScVal(1n, { type: "u64" }),
];

describe("demo network gate (L-108)", () => {
  it("is testnet only", () => {
    expect(isDemoNetwork(TESTNET)).toBe(true);
    expect(isDemoNetwork(MAINNET)).toBe(false);
  });

  it("refuses any other network before touching it, even one with a friendbot", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const futurenet: NetworkConfig = {
      id: "futurenet" as NetworkConfig["id"],
      horizon: "https://horizon-futurenet.stellar.org",
      rpc: "https://rpc-futurenet.stellar.org",
      passphrase: Networks.FUTURENET,
      friendbot: "https://friendbot-futurenet.stellar.org",
    };
    await expect(
      runDemoSetup({ network: futurenet, onStart: () => {}, onFinish: () => {} }),
    ).rejects.toThrow(/testnet only/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("friendbot that never answers (L-77)", () => {
  // a real socket that accepts the request and then says nothing, which is what
  // a hung friendbot looks like to fetch
  let server: Server;
  let url: string;
  const open = new Set<Socket>();

  beforeAll(async () => {
    server = createServer(() => {});
    server.on("connection", (s) => {
      open.add(s);
      s.on("close", () => open.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    for (const s of open) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it("gives up after the timeout with a clear error instead of waiting forever", async () => {
    const started = Date.now();
    await expect(friendbotFund(url, demo.publicKey(), 300)).rejects.toThrow(
      "Friendbot did not respond within 0.3 seconds.",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("waits 20 seconds by default", () => {
    expect(FRIENDBOT_TIMEOUT_MS).toBe(20_000);
  });
});

describe("demo signing guard (L-107)", () => {
  const expected = { contractId: ROUTER, fn: "swap_exact_tokens_for_tokens" };

  it("accepts the router swap built for the demo account", () => {
    const tx = invoke(demo.publicKey(), ROUTER, expected.fn, swapArgs(demo.publicKey()));
    expect(() => assertDemoSorobanTx(tx, demo.publicKey(), TESTNET, expected)).not.toThrow();
  });

  it("refuses a transaction with a foreign source", () => {
    const other = Keypair.random().publicKey();
    const tx = invoke(other, ROUTER, expected.fn, swapArgs(demo.publicKey()));
    expect(() => assertDemoSorobanTx(tx, demo.publicKey(), TESTNET, expected)).toThrow(/source/);
  });

  it("refuses an extra operation (e.g. a smuggled signer)", () => {
    const tx = invoke(demo.publicKey(), ROUTER, expected.fn, swapArgs(demo.publicKey()), [
      Operation.setOptions({
        signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 1 },
      }),
    ]);
    expect(() => assertDemoSorobanTx(tx, demo.publicKey(), TESTNET, expected)).toThrow(
      /2 operations/,
    );
  });

  it("refuses a call to a contract off the allow-list", () => {
    const rogue = Keypair.random().publicKey();
    const rogueContract = new Address(Asset.native().contractId(Networks.PUBLIC)).toString();
    const tx = invoke(demo.publicKey(), rogueContract, "transfer", [
      addr(demo.publicKey()),
      addr(rogue),
    ]);
    expect(() =>
      assertDemoSorobanTx(tx, demo.publicKey(), TESTNET, {
        contractId: rogueContract,
        fn: "transfer",
      }),
    ).toThrow(/Allow-list violation/);
  });

  it("refuses a different function than the step expects", () => {
    const tx = invoke(demo.publicKey(), ROUTER, "remove_liquidity", swapArgs(demo.publicKey()));
    expect(() => assertDemoSorobanTx(tx, demo.publicKey(), TESTNET, expected)).toThrow(
      /different contract or function/,
    );
  });

  it("refuses an allowance granted from another account", () => {
    const other = Keypair.random().publicKey();
    const tx = invoke(demo.publicKey(), NATIVE_SAC, "approve", [
      addr(other),
      addr(Keypair.random().publicKey()),
      nativeToScVal(100n, { type: "i128" }),
      nativeToScVal(1, { type: "u32" }),
    ]);
    expect(() =>
      assertDemoSorobanTx(tx, demo.publicKey(), TESTNET, { contractId: NATIVE_SAC, fn: "approve" }),
    ).toThrow(/not granted from the demo account/);
  });

  it("refuses an authorization signed by another address", () => {
    const tx = invoke(demo.publicKey(), ROUTER, expected.fn, swapArgs(demo.publicKey()));
    const op = tx.operations[0] as Operation.InvokeHostFunction;
    const foreign = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(Keypair.random().publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString("1"),
          signatureExpirationLedger: 1,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(ROUTER).toScAddress(),
            functionName: expected.fn,
            args: swapArgs(demo.publicKey()),
          }),
        ),
        subInvocations: [],
      }),
    });
    const rebuilt = new TransactionBuilder(new Account(demo.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.invokeHostFunction({ func: op.func, auth: [foreign] }))
      .setTimeout(60)
      .build();
    expect(() => assertDemoSorobanTx(rebuilt, demo.publicKey(), TESTNET, expected)).toThrow(
      /signed by another address/,
    );
  });
});

describe("demo liquidity sizing (L-109)", () => {
  // testnet XLM/USDC soroswap reserves read on 2026-10-02 (router get_reserves)
  const reserveXlm = 39_346_508_790_686n;
  const reserveUsdc = 4_172_572_294_650n;

  it("sizes the USDC side from the pool ratio, not a fixed 2:1 price", () => {
    const d = sizeLiquidityDeposit(200_000_000n, 52_863_672n, reserveXlm, reserveUsdc);
    expect(d.xlm).toBe(200_000_000n);
    expect(d.usdc).toBe((200_000_000n * reserveUsdc) / reserveXlm);
    // the router's acceptance rule: the optimal other side must reach its minimum
    const optimalUsdc = (d.xlm * reserveUsdc) / reserveXlm;
    expect(optimalUsdc).toBeGreaterThanOrEqual(d.usdcMin);
    expect(optimalUsdc).toBeLessThanOrEqual(d.usdc);
  });

  it("scales the XLM side down when the USDC on hand can't match it", () => {
    const d = sizeLiquidityDeposit(200_000_000n, 10_000_000n, reserveXlm, reserveUsdc);
    expect(d.usdc).toBe(10_000_000n);
    expect(d.xlm).toBe((10_000_000n * reserveXlm) / reserveUsdc);
    expect(d.xlm).toBeLessThan(200_000_000n);
  });

  it("refuses with no USDC to pair", () => {
    expect(() => sizeLiquidityDeposit(200_000_000n, 0n, reserveXlm, reserveUsdc)).toThrow(
      /No USDC/,
    );
  });
});

describe("demo soroban submission (L-110)", () => {
  const tx = invoke(
    demo.publicKey(),
    ROUTER,
    "swap_exact_tokens_for_tokens",
    swapArgs(demo.publicKey()),
  );
  const fast = { timeoutMs: 50, intervalMs: 1 };

  it("fails at once with the real status when the RPC says TRY_AGAIN_LATER", async () => {
    const getTransaction = vi.fn();
    const server = {
      sendTransaction: vi.fn(async () => ({ status: "TRY_AGAIN_LATER", hash: "ab".repeat(32) })),
      getTransaction,
    };
    await expect(submitAndPollSoroban(server as never, tx, "soroswap-swap", fast)).rejects.toThrow(
      /did not accept the transaction \(TRY_AGAIN_LATER\)/,
    );
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it("polls a queued transaction to success", async () => {
    const server = {
      sendTransaction: vi.fn(async () => ({ status: "PENDING", hash: "cd".repeat(32) })),
      getTransaction: vi
        .fn()
        .mockResolvedValueOnce({ status: "NOT_FOUND" })
        .mockResolvedValueOnce({ status: "SUCCESS" }),
    };
    await expect(submitAndPollSoroban(server as never, tx, "step", fast)).resolves.toBe(
      "cd".repeat(32),
    );
  });

  it("accepts DUPLICATE as already queued", async () => {
    const server = {
      sendTransaction: vi.fn(async () => ({ status: "DUPLICATE", hash: "ef".repeat(32) })),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    };
    await expect(submitAndPollSoroban(server as never, tx, "step", fast)).resolves.toBe(
      "ef".repeat(32),
    );
  });
});
