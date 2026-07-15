// fxdao vault exit builder

import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Horizon,
  type rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

import { getAllowlistForNetwork, isAllowedContract } from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress } from "@/lib/soroban/scval";
import { assembleSubmittable } from "@/lib/soroban/simulate";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";

import { getFxDAOVaultsContractId } from "./contracts";
import type { FxDAOVault } from "./client";
import { optionalVaultKeyScVal, type VaultKey } from "./prev-key";

// five-minute timeout
const MAX_TIMEOUT_SECONDS = 300;

// the unsigned exit for one fxdao vault. A single pay_debt(amount == total_debt)
// closes the vault: the VaultsContract burns the caller's stablecoin AND releases
// the full collateral back to the owner in that one call. (There is no separate
// "redeem the collateral" step. redeem() is an unrelated protocol feature that
// burns stablecoin against the LOWEST vault in the list, not the caller's.)
export interface FxDAOVaultExit {
  readonly payDebt: Transaction;
}

export interface FxDAOExitDeps {
  // Soroban RPC used to prepare (attach footprint + resource fee) the pay_debt
  // invocation. Required for a real, submittable transaction.
  readonly server?: rpc.Server;
  // override for tests; defaults to server.prepareTransaction
  readonly assemble?: typeof assembleSubmittable;
}

// build the unsigned close for one vault. The pay_debt call is a Soroban host
// invocation, so it MUST be prepared (footprint + resource fee attached) or the
// network rejects it as malformed; every other adapter prepares its calls too.
export async function buildVaultExit(
  vault: FxDAOVault,
  userPublicKey: string,
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
  syntheticAssetIssuer: string,
  prevKey: VaultKey | null,
  deps: FxDAOExitDeps = {},
): Promise<FxDAOVaultExit> {
  if (vault.debt <= 0n) {
    throw new RangeError(
      `FxDAO buildVaultExit: vault.debt must be > 0; got ${vault.debt.toString()}`,
    );
  }
  if (typeof syntheticAssetIssuer !== "string" || syntheticAssetIssuer.length === 0) {
    throw new TypeError(
      "FxDAO buildVaultExit: syntheticAssetIssuer is required (classical-asset issuer G... strkey)",
    );
  }

  const vaultsContractId = resolveVaultsContractIdForNetwork(network);
  if (!isAllowedContract(vaultsContractId, network)) {
    throw new Error(
      `FxDAO VaultsContract ${vaultsContractId} is not on the ${network.id} allow-list: refusing to build exit`,
    );
  }

  const built = buildPayDebtTx(
    vault,
    userPublicKey,
    sourceAccount,
    network,
    vaultsContractId,
    prevKey,
  );

  const assemble = deps.assemble ?? assembleSubmittable;
  if (deps.assemble === undefined && deps.server === undefined) {
    throw new Error(
      "FxDAO buildVaultExit: an rpc server is required to prepare the pay_debt transaction " +
        "(a Soroban call submitted without a prepared footprint is rejected on-chain)",
    );
  }
  const prepared = await assemble(deps.server as rpc.Server, built);
  if ("innerTransaction" in prepared) {
    throw new Error("FxDAO buildVaultExit: prepareTransaction returned a FeeBumpTransaction unexpectedly");
  }

  assertTransactionAllowed(prepared, network);

  return { payDebt: prepared };
}

// resolve the VaultsContract id for the target network. fxdao has no futurenet deployment
function resolveVaultsContractIdForNetwork(network: NetworkConfig): string {
  if (network.id === "mainnet") return getFxDAOVaultsContractId();
  if (network.id === "testnet") {
    const list = getAllowlistForNetwork(network);
    const entry = list.find((c) => c.protocol === "fxdao" && c.name === "FxDAO::VaultsContract");
    if (!entry) {
      throw new Error(
        "FxDAO VaultsContract is not registered in TESTNET_ALLOWLIST: testnet vault address is unverified",
      );
    }
    return entry.id;
  }
  throw new Error(`FxDAO has no published ${network.id} deployment`);
}

// encode OptionalVaultKey::none: scvVec([symbol("None")])
function optionalVaultKeyNone(): xdr.ScVal {
  return xdr.ScVal.scvVec([nativeToScVal("None", { type: "symbol" })]);
}

// encode a VaultKey struct as scvMap with fields ordered alphabetically (host invariant)
function vaultKeyScVal(account: string, denomination: string, index: bigint = 0n): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("account", { type: "symbol" }),
      val: scvAddress(account),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("denomination", { type: "symbol" }),
      val: nativeToScVal(denomination, { type: "symbol" }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal("index", { type: "symbol" }),
      val: nativeToScVal(index, { type: "u128" }),
    }),
  ]);
}

// build pay_debt(prev_key, vault_key, new_prev_key, amount)
function buildPayDebtTx(
  vault: FxDAOVault,
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  vaultsContractId: string,
  prevKey: VaultKey | null,
): Transaction {
  const contract = new Contract(vaultsContractId);
  const callArgs: xdr.ScVal[] = [
    optionalVaultKeyScVal(prevKey), // prev_key resolved by hydration via findPrevVaultKey
    vaultKeyScVal(userPublicKey, vault.denomination),
    optionalVaultKeyNone(), // new_prev_key: None because amount == debt closes the vault
    nativeToScVal(vault.debt, { type: "u128" }), // full debt
  ];

  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call("pay_debt", ...callArgs))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
}
