import { describe, it, expect } from "vitest";
import {
  Account,
  Address,
  Operation,
  StrKey,
  scValToNative,
  xdr,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import {
  claim,
  getAquariusRouterId,
  readAquariusPoolRewardTokens,
  readAquariusRewardToken,
  type AquariusClientDeps,
  withdraw,
} from "@/lib/adapters/aquarius/client";
import { MAINNET, TESTNET } from "@/lib/config/networks";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
// the network's clock, far from the test machine's, so a bound taken from
// Date.now() fails
const LEDGER_CLOSE = 1_700_000_000;
const TOKEN_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN_B = StrKey.encodeContract(Buffer.alloc(32, 2));
const POOL_INDEX = new Uint8Array(Buffer.alloc(32, 7));

function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "41") as unknown as Horizon.AccountResponse;
}

function captureDeps(): { deps: AquariusClientDeps; captured: () => Transaction } {
  let seen: Transaction | undefined;
  return {
    deps: {
      server: {} as unknown as rpc.Server,
      assemble: async (_server, tx) => {
        seen = tx as Transaction;
        return tx;
      },
    },
    captured: () => {
      if (!seen) throw new Error("assemble was never called");
      return seen;
    },
  };
}

function invokeCall(tx: Transaction) {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = xdr.expectUnionVariant(op.func, "hostFunctionTypeInvokeContract").invokeContract;
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args,
  };
}

describe("aquarius claim", () => {
  // the deployed router (mainnet CBQDHNBF..., testnet CBCFTQSP...) exports
  // claim(user: Address, tokens: Vec<Address>, pool_index: BytesN<32>) -> u128;
  // a 2-arg call traps with Error(WasmVm, UnexpectedSize)
  it("encodes claim(user, tokens, pool_index) in the router's spec order", async () => {
    const { deps, captured } = captureDeps();
    await claim(
      {
        user: USER,
        tokens: [TOKEN_A, TOKEN_B],
        poolIndex: POOL_INDEX,
        sourceAccount: sourceAccount(),
        ledgerCloseTime: LEDGER_CLOSE,
        network: TESTNET,
      },
      deps,
    );
    const { contract, fn, args } = invokeCall(captured());
    expect(contract).toBe(getAquariusRouterId(TESTNET));
    expect(fn).toBe("claim");
    expect(args).toHaveLength(3);
    expect(args[0]!.type).toBe("scvAddress");
    expect(Address.fromScVal(args[0]!).toString()).toBe(USER);
    expect(args[1]!.type).toBe("scvVec");
    expect(
      xdr.expectUnionVariant(args[1]!, "scvVec").vec!.map((t) => Address.fromScVal(t).toString()),
    ).toEqual([TOKEN_A, TOKEN_B]);
    expect(args[2]!.type).toBe("scvBytes");
    expect(Buffer.from(scValToNative(args[2]!) as Uint8Array)).toEqual(Buffer.from(POOL_INDEX));
  });

  it("expires five minutes after the supplied ledger close time", async () => {
    const { deps, captured } = captureDeps();
    const args = {
      user: USER,
      tokens: [TOKEN_A, TOKEN_B],
      poolIndex: POOL_INDEX,
      sourceAccount: sourceAccount(),
      ledgerCloseTime: LEDGER_CLOSE,
      network: TESTNET,
    };
    await claim(args, deps);
    expect(Number(captured().timeBounds?.minTime)).toBe(0);
    expect(Number(captured().timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 300);
    await withdraw({ ...args, shareAmount: 10n, minAmounts: [0n, 0n] }, deps);
    expect(Number(captured().timeBounds?.maxTime)).toBe(LEDGER_CLOSE + 300);
    await expect(claim({ ...args, ledgerCloseTime: 0 }, deps)).rejects.toThrow(/ledger close time/);
  });

  it("refuses to build a claim without the pool's token set", async () => {
    const { deps } = captureDeps();
    await expect(
      claim(
        {
          user: USER,
          tokens: [],
          poolIndex: POOL_INDEX,
          sourceAccount: sourceAccount(),
          ledgerCloseTime: LEDGER_CLOSE,
          network: MAINNET,
        },
        deps,
      ),
    ).rejects.toThrow(/token set/);
  });
});

const AQUA_SAC = "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK";

function storageItem(name: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]), val });
}

// contract instance entries as getLedgerEntries returns them, for the ids it has
function instanceServer(storageById: Record<string, xdr.ScMapEntry[] | null>) {
  const calls: xdr.LedgerKey[][] = [];
  const server = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys);
      const entries = keys.flatMap((key) => {
        const contract = xdr.expectUnionVariant(key, "contractData").contractData.contract;
        const id = Address.fromScAddress(contract).toString();
        if (!(id in storageById)) return [];
        const val = xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: xdr.ExtensionPoint.v0(),
            contract,
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent,
            val: xdr.ScVal.scvContractInstance(
              new xdr.ScContractInstance({
                executable: xdr.ContractExecutable.contractExecutableWasm(
                  new Uint8Array(32).fill(1),
                ),
                storage: storageById[id]!,
              }),
            ),
          }),
        );
        return [{ key, val, lastModifiedLedgerSeq: 1 }];
      });
      return { latestLedger: 1, entries };
    },
  } as unknown as rpc.Server;
  return { server, calls };
}

describe("readAquariusRewardToken", () => {
  // the router's instance entry as getLedgerEntries returns it
  function routerServer(storage: xdr.ScMapEntry[] | null, present = true) {
    const routerId = getAquariusRouterId(MAINNET);
    const { server, calls } = instanceServer(present ? { [routerId]: storage } : {});
    return { server, calls, routerId };
  }

  // mainnet router CBQDHNBF... instance storage read 2026-10-07: RewardToken is
  // the AQUA SAC, next to InitPoolPaymentToken and RewardBoostToken
  it("reads the reward token from the router's instance storage", async () => {
    const { server, calls, routerId } = routerServer([
      storageItem("InitPoolPaymentToken", new Address(TOKEN_A).toScVal()),
      storageItem("RewardBoostToken", new Address(TOKEN_B).toScVal()),
      storageItem("RewardToken", new Address(AQUA_SAC).toScVal()),
    ]);
    await expect(readAquariusRewardToken(server, MAINNET)).resolves.toBe(AQUA_SAC);
    const cd = xdr.expectUnionVariant(calls[0]![0]!, "contractData").contractData;
    expect(Address.fromScAddress(cd.contract).toString()).toBe(routerId);
    expect(cd.key.type).toBe("scvLedgerKeyContractInstance");
  });

  it("refuses to guess when the router has no reward token or the rpc drops it", async () => {
    await expect(
      readAquariusRewardToken(
        routerServer([storageItem("RewardBoostToken", new Address(TOKEN_B).toScVal())]).server,
        MAINNET,
      ),
    ).rejects.toThrow(/RewardToken/);
    await expect(readAquariusRewardToken(routerServer(null).server, MAINNET)).rejects.toThrow(
      /RewardToken/,
    );
    await expect(
      readAquariusRewardToken(
        routerServer([storageItem("RewardToken", new Address(USER).toScVal())]).server,
        MAINNET,
      ),
    ).rejects.toThrow(/RewardToken/);
    await expect(readAquariusRewardToken(routerServer([], false).server, MAINNET)).rejects.toThrow(
      /not returned/,
    );
  });
});

describe("readAquariusPoolRewardTokens", () => {
  const POOL_A = StrKey.encodeContract(Buffer.alloc(32, 31));
  const POOL_B = StrKey.encodeContract(Buffer.alloc(32, 32));
  const OTHER = StrKey.encodeContract(Buffer.alloc(32, 33));
  const registry = (ids: string[]) =>
    storageItem(
      "RewardTokenRegistry",
      xdr.ScVal.scvVec(ids.map((id) => new Address(id).toScVal())),
    );

  // mainnet 2026-10-08: a router claim on standard pool CAUCGD... for GDD34D...
  // is paid by the pool (transfer CAUCGD -> GDD34D of the token in the pool's
  // own RewardToken). every one of the 365 pools stores the router's token
  // today, and each concentrated pool's RewardTokenRegistry lists only it.
  it("reads each pool's own reward token in one ledger read", async () => {
    const { server, calls } = instanceServer({
      [POOL_A]: [
        storageItem("RewardBoostToken", new Address(TOKEN_B).toScVal()),
        storageItem("RewardToken", new Address(AQUA_SAC).toScVal()),
      ],
      [POOL_B]: [storageItem("RewardToken", new Address(AQUA_SAC).toScVal()), registry([AQUA_SAC])],
    });
    const got = await readAquariusPoolRewardTokens(server, [POOL_A, POOL_B, POOL_A]);
    expect(got).toEqual(
      new Map([
        [POOL_A, [AQUA_SAC]],
        [POOL_B, [AQUA_SAC]],
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
  });

  it("lists every token a pool's registry names besides its reward token", async () => {
    const { server } = instanceServer({
      [POOL_A]: [
        storageItem("RewardToken", new Address(AQUA_SAC).toScVal()),
        registry([AQUA_SAC, OTHER]),
      ],
    });
    await expect(readAquariusPoolRewardTokens(server, [POOL_A])).resolves.toEqual(
      new Map([[POOL_A, [AQUA_SAC, OTHER]]]),
    );
  });

  it("refuses a pool the rpc does not return or that stores no reward token", async () => {
    await expect(readAquariusPoolRewardTokens(instanceServer({}).server, [POOL_A])).rejects.toThrow(
      /not returned/,
    );
    await expect(
      readAquariusPoolRewardTokens(instanceServer({ [POOL_A]: [registry([AQUA_SAC])] }).server, [
        POOL_A,
      ]),
    ).rejects.toThrow(/RewardToken/);
    await expect(
      readAquariusPoolRewardTokens(
        instanceServer({
          [POOL_A]: [
            storageItem("RewardToken", new Address(AQUA_SAC).toScVal()),
            storageItem("RewardTokenRegistry", xdr.ScVal.scvU32(1)),
          ],
        }).server,
        [POOL_A],
      ),
    ).rejects.toThrow(/RewardTokenRegistry/);
  });
});
