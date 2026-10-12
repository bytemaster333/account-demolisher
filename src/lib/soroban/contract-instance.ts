// contract instance entries read straight from the ledger. no contract code runs
// to answer, so a hostile contract can't shape the result: the executable type
// is set by the host, and the storage is only what the contract itself wrote.

import { Address, xdr, type rpc } from "@stellar/stellar-sdk";

// ledger keys per getLedgerEntries call (the rpc accepts at most 200)
export const INSTANCE_BATCH_SIZE = 190;

export function contractInstanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

// the instance of every given contract, keyed by id. throws naming each one the
// rpc did not return, so a caller never reads an unread contract as an answer.
export async function readContractInstances(
  server: rpc.Server,
  contractIds: readonly string[],
  batchSize: number = INSTANCE_BATCH_SIZE,
): Promise<Map<string, xdr.ScContractInstance>> {
  const ids = [...new Set(contractIds)];
  const out = new Map<string, xdr.ScContractInstance>();
  for (let i = 0; i < ids.length; i += batchSize) {
    const resp = await server.getLedgerEntries(
      ...ids.slice(i, i + batchSize).map(contractInstanceKey),
    );
    for (const entry of resp.entries) {
      const cd = xdr.expectUnionVariant(entry.val, "contractData").contractData;
      out.set(
        Address.fromScAddress(cd.contract).toString(),
        xdr.expectUnionVariant(cd.val, "scvContractInstance").instance,
      );
    }
  }
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    throw new Error(`contract instances not returned by the rpc: ${missing.join(", ")}`);
  }
  return out;
}

// a stellar asset contract runs the host's built-in asset code, no wasm, so its
// events and allowances are the asset's own
export function isStellarAssetInstance(instance: xdr.ScContractInstance): boolean {
  return instance.executable.type === "contractExecutableStellarAsset";
}

// the value stored under the one-symbol key [name], the way soroban-sdk writes a
// unit enum variant used as a key, or undefined when there is none
export function instanceStorageValue(
  instance: xdr.ScContractInstance,
  name: string,
): xdr.ScVal | undefined {
  for (const item of instance.storage ?? []) {
    const key = item.key.type === "scvVec" ? item.key.vec : null;
    if (key?.length === 1 && key[0]!.type === "scvSymbol" && key[0]!.sym.toString() === name) {
      return item.val;
    }
  }
  return undefined;
}
