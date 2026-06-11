// fxdao vault exit builder. produces two unsigned txs per vault:
//   pay_debt(prev_key, vault_key, new_prev_key, amount): with amount == vault.debt
//     and new_prev_key == None, burns the user's synthetic balance and returns all
//     locked collateral. requires the user to hold vault.debt of the synthetic.
//   redeem(caller, denomination, new_prev_key, amount): any synthetic holder can
//     burn and pull collateral from the lowest-indexed vault. equivalent to pay_debt
//     only when the user's vault is the lowest.
//
// prev_key is resolved by the hydrator via findPrevVaultKey before this is called.

import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

import { getAllowlistForNetwork, isAllowedContract } from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";
import { address as scvAddress } from "@/lib/soroban/scval";
import { assertTransactionAllowed } from "@/lib/stellar/allowlist";

import { getFxDAOVaultsContractId } from "./contracts";
import type { FxDAOVault } from "./client";
import { optionalVaultKeyScVal, type VaultKey } from "./prev-key";

// five-minute timeout
const MAX_TIMEOUT_SECONDS = 300;

// the two exit transactions for one fxdao vault; both target the same VaultsContract
export interface FxDAOVaultExit {
  readonly payDebt: Transaction;
  readonly redeem: Transaction;
}

// build the two-step unsigned exit for one vault.
// prevKey must be supplied by the caller (resolved via findPrevVaultKey upstream);
// null means the user's vault is the head of the sorted linked list.
export async function buildVaultExit(
  vault: FxDAOVault,
  userPublicKey: string,
  network: NetworkConfig,
  sourceAccount: Horizon.AccountResponse,
  syntheticAssetIssuer: string,
  prevKey: VaultKey | null,
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
      `FxDAO VaultsContract ${vaultsContractId} is not on the ${network.id} allow-list — refusing to build exit`,
    );
  }

  const payDebt = buildPayDebtTx(
    vault,
    userPublicKey,
    sourceAccount,
    network,
    vaultsContractId,
    prevKey,
  );
  const redeem = buildRedeemTx(vault, userPublicKey, sourceAccount, network, vaultsContractId);

  assertTransactionAllowed(payDebt, network);
  assertTransactionAllowed(redeem, network);

  return { payDebt, redeem };
}

// resolve the VaultsContract id for the target network. fxdao has no futurenet deployment.
function resolveVaultsContractIdForNetwork(network: NetworkConfig): string {
  if (network.id === "mainnet") return getFxDAOVaultsContractId();
  if (network.id === "testnet") {
    const list = getAllowlistForNetwork(network);
    const entry = list.find((c) => c.protocol === "fxdao" && c.name === "FxDAO::VaultsContract");
    if (!entry) {
      throw new Error(
        "FxDAO VaultsContract is not registered in TESTNET_ALLOWLIST — testnet vault address is unverified",
      );
    }
    return entry.id;
  }
  throw new Error(`FxDAO has no published ${network.id} deployment`);
}

// encode OptionalVaultKey::None — scvVec([Symbol("None")])
function optionalVaultKeyNone(): xdr.ScVal {
  return xdr.ScVal.scvVec([nativeToScVal("None", { type: "symbol" })]);
}

// encode a VaultKey struct as scvMap with fields ordered alphabetically (host invariant).
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
    optionalVaultKeyNone(), // new_prev_key — None because amount == debt closes the vault
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

// build redeem(caller, denomination, new_prev_key, amount)
function buildRedeemTx(
  vault: FxDAOVault,
  userPublicKey: string,
  sourceAccount: Horizon.AccountResponse,
  network: NetworkConfig,
  vaultsContractId: string,
): Transaction {
  const contract = new Contract(vaultsContractId);
  const callArgs: xdr.ScVal[] = [
    scvAddress(userPublicKey),
    nativeToScVal(vault.denomination, { type: "symbol" }),
    optionalVaultKeyNone(), // new_prev_key — None when amount == debt of the lowest vault
    nativeToScVal(vault.debt, { type: "u128" }), // burn full debt
  ];

  return new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call("redeem", ...callArgs))
    .setTimeout(MAX_TIMEOUT_SECONDS)
    .build();
}
