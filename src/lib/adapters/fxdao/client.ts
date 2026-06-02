/**
 * fxdao vault discovery. the on-chain contract only exposes get_vault(caller, denomination),
 * so we enumerate FXDAO_KNOWN_DENOMINATIONS (USD/EUR/GBP) and call once each.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { getRpc } from "@/lib/soroban/rpc-client";
import { address as scvAddress } from "@/lib/soroban/scval";
import { simulate } from "@/lib/soroban/simulate";

import { FXDAO_KNOWN_DENOMINATIONS, getFxDAOVaultsContractId } from "./contracts";

/**
 * one open fxdao vault.
 *  - denomination: on-chain Symbol (USD/EUR/GBP), not the Xx-suffixed asset code
 *  - debt: total_debt field, in the synthetic stablecoin's smallest units
 *  - collateral: total_collateral field, in collateral-asset smallest units (XLM stroops on mainnet)
 *  - healthFactor: optional; computing it requires an oracle read, left undefined here
 */
export interface FxDAOVault {
  readonly denomination: string;
  readonly debt: bigint;
  readonly collateral: bigint;
  readonly healthFactor?: number;
}

// pluggable deps. tests inject server and may inject simulate.
export interface FxDAOClientDeps {
  readonly server?: rpc.Server;
  readonly simulate?: typeof simulate;
  // override the denomination list. production should not pass this.
  readonly denominations?: readonly string[];
}

// legacy alias preserved so old instanceof checks remain syntactically valid
export class FxDAOClientNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxDAOClientNotConfigured";
  }
}

// discover every open vault for the user across known denominations
export async function getUserVaults(
  userPublicKey: string,
  network: NetworkConfig,
  deps: FxDAOClientDeps = {},
): Promise<FxDAOVault[]> {
  const server = deps.server ?? getRpc(network);
  const simulateFn = deps.simulate ?? simulate;
  const denominations = deps.denominations ?? FXDAO_KNOWN_DENOMINATIONS;
  const vaultsContractId = getFxDAOVaultsContractId();

  const vaults: FxDAOVault[] = [];
  for (const denomination of denominations) {
    const vault = await tryGetVault(
      server,
      simulateFn,
      vaultsContractId,
      userPublicKey,
      denomination,
      network,
    );
    if (vault !== null) vaults.push(vault);
  }

  return vaults;
}

// simulate get_vault and return the decoded result, or null on simulation error (no vault)
async function tryGetVault(
  server: rpc.Server,
  simulateFn: typeof simulate,
  vaultsContractId: string,
  userPublicKey: string,
  denomination: string,
  network: NetworkConfig,
): Promise<FxDAOVault | null> {
  // sequence 0 is fine — simulation is read-only
  const sourceAccount = new Account(userPublicKey, "0");
  const contract = new Contract(vaultsContractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(
      contract.call(
        "get_vault",
        scvAddress(userPublicKey),
        nativeToScVal(denomination, { type: "symbol" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await simulateFn(server, tx);
  if (!sim.ok || sim.retval === null) return null;
  return decodeVault(sim.retval, denomination);
}

// decode the Vault ScVal returned by get_vault
function decodeVault(retval: xdr.ScVal, fallbackDenomination: string): FxDAOVault | null {
  const decoded: unknown = scValToNative(retval);
  if (decoded === null || typeof decoded !== "object") return null;
  const obj = decoded as Record<string, unknown>;

  const totalDebt = obj.total_debt;
  const totalCollateral = obj.total_collateral;
  const denomination = obj.denomination;

  if (typeof totalDebt !== "bigint" || typeof totalCollateral !== "bigint") return null;
  // contract removes vaults on full repay, so zero-debt shouldn't appear; defensive skip anyway
  if (totalDebt === 0n) return null;

  return {
    denomination: typeof denomination === "string" ? denomination : fallbackDenomination,
    debt: totalDebt,
    collateral: totalCollateral,
  };
}
