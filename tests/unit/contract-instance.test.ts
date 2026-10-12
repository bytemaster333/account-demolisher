import { Address, Asset, Keypair, Networks, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  contractInstanceKey,
  instanceStorageValue,
  isStellarAssetInstance,
  readContractInstances,
} from "@/lib/soroban/contract-instance";

const SAC = new Asset("USD", Keypair.random().publicKey()).contractId(Networks.TESTNET);

function contractId(n: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, n));
}

function storageItem(name: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]), val });
}

function instance(sac: boolean, storage: xdr.ScMapEntry[] = []): xdr.ScContractInstance {
  return new xdr.ScContractInstance({
    executable: sac
      ? xdr.ContractExecutable.contractExecutableStellarAsset()
      : xdr.ContractExecutable.contractExecutableWasm(new Uint8Array(32).fill(1)),
    storage,
  });
}

// answers like stellar-rpc: only the keys whose contract is listed come back
function server(instances: Record<string, xdr.ScContractInstance>) {
  const calls: xdr.LedgerKey[][] = [];
  const s = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys);
      const entries = keys.flatMap((key) => {
        const cd = xdr.expectUnionVariant(key, "contractData").contractData;
        const id = Address.fromScAddress(cd.contract).toString();
        const inst = instances[id];
        if (inst === undefined) return [];
        const val = xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: xdr.ExtensionPoint.v0(),
            contract: cd.contract,
            key: cd.key,
            durability: cd.durability,
            val: xdr.ScVal.scvContractInstance(inst),
          }),
        );
        return [{ key, val, lastModifiedLedgerSeq: 1 }];
      });
      return { latestLedger: 1, entries };
    },
  } as unknown as rpc.Server;
  return { server: s, calls };
}

describe("contractInstanceKey", () => {
  it("names the persistent instance entry of the contract", () => {
    const id = contractId(7);
    const cd = xdr.expectUnionVariant(contractInstanceKey(id), "contractData").contractData;
    expect(Address.fromScAddress(cd.contract).toString()).toBe(id);
    expect(cd.key.type).toBe("scvLedgerKeyContractInstance");
    expect(cd.durability).toEqual(xdr.ContractDataDurability.persistent);
  });
});

describe("readContractInstances", () => {
  it("reads every instance, once per id, in batches the rpc accepts", async () => {
    const ids = [1, 2, 3, 4, 5].map(contractId);
    const { server: s, calls } = server(
      Object.fromEntries(ids.map((id, i) => [id, instance(i === 0)])),
    );
    const out = await readContractInstances(s, [...ids, ids[0]!], 2);
    expect([...out.keys()].sort()).toEqual([...ids].sort());
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(isStellarAssetInstance(out.get(ids[0]!)!)).toBe(true);
    expect(isStellarAssetInstance(out.get(ids[1]!)!)).toBe(false);
  });

  it("names every contract the rpc did not return instead of leaving it out", async () => {
    const [a, b, c] = [1, 2, 3].map(contractId);
    const { server: s } = server({ [a!]: instance(false) });
    await expect(readContractInstances(s, [a!, b!, c!])).rejects.toThrow(
      `contract instances not returned by the rpc: ${b}, ${c}`,
    );
  });

  it("makes no call for no ids", async () => {
    const { server: s, calls } = server({});
    expect((await readContractInstances(s, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("isStellarAssetInstance", () => {
  it("is true only for the built-in asset executable", () => {
    expect(isStellarAssetInstance(instance(true))).toBe(true);
    expect(isStellarAssetInstance(instance(false))).toBe(false);
  });
});

describe("instanceStorageValue", () => {
  it("finds the value under a one-symbol key and nothing else", () => {
    const token = new Address(SAC).toScVal();
    const inst = instance(false, [
      storageItem("Other", xdr.ScVal.scvU32(1)),
      storageItem("RewardToken", token),
      // a two-element key is a different entry, even when it starts with the name
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Gauge"), xdr.ScVal.scvU32(1)]),
        val: xdr.ScVal.scvU32(2),
      }),
      // a bare symbol key is not the soroban-sdk enum key layout
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("Gauge"), val: xdr.ScVal.scvU32(3) }),
    ]);
    expect(instanceStorageValue(inst, "RewardToken")?.toXDR("base64")).toBe(token.toXDR("base64"));
    expect(instanceStorageValue(inst, "Gauge")).toBeUndefined();
    expect(instanceStorageValue(instance(false), "RewardToken")).toBeUndefined();
  });
});
