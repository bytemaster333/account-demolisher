// fxdao vault discovery. the on-chain contract only exposes get_vault(caller, denomination),
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

// one open fxdao vault
export interface FxDAOVault {
  readonly denomination: string;
  readonly debt: bigint;
  readonly collateral: bigint;
  readonly healthFactor?: number;
}

// pluggable deps. tests inject server and may inject simulate
export interface FxDAOClientDeps {
  readonly server?: rpc.Server;
  readonly simulate?: typeof simulate;
  // override the denomination list. production should not pass this
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
  // sequence 0 is fine. simulation is read-only
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
  // FxDAO's get_vault panics when the caller holds no vault for this denomination,
  // so a host error (sim.ok === false) is a GENUINE absence — skip it quietly. (A
  // transport/RPC failure throws from simulate() and propagates up as a hard
  // discovery error, so it never lands here as a silent "no vault".)
  if (!sim.ok) return null;
  // A successful simulation that returns nothing, or a struct we cannot decode,
  // means the contract/ABI drifted. Reading that as "no vault" would silently
  // strand the vault's collateral once the account is merged, so FAIL CLOSED:
  // throw, which surfaces a discovery error and blocks a clean close.
  if (sim.retval === null) {
    throw new Error(
      `FxDAO get_vault(${denomination}) returned no value; cannot confirm vault state`,
    );
  }
  const result = decodeVault(sim.retval, denomination);
  if (result.kind === "undecodable") {
    throw new Error(
      `FxDAO get_vault(${denomination}) returned an undecodable vault struct; the contract or ABI ` +
        `may have changed. Refusing to treat this as "no vault" to avoid stranding collateral.`,
    );
  }
  return result.kind === "vault" ? result.vault : null;
}

// A get_vault result: a real open vault, a positively-decoded absence (zero-debt),
// or a struct we could not decode (contract/ABI drift — must NOT be read as "no
// vault", which would silently strand collateral).
type VaultDecode =
  | { readonly kind: "vault"; readonly vault: FxDAOVault }
  | { readonly kind: "empty" }
  | { readonly kind: "undecodable" };

// decode the vault ScVal returned by get_vault
function decodeVault(retval: xdr.ScVal, fallbackDenomination: string): VaultDecode {
  const decoded: unknown = scValToNative(retval);
  if (decoded === null || typeof decoded !== "object") return { kind: "undecodable" };
  const obj = decoded as Record<string, unknown>;

  const totalDebt = obj.total_debt;
  const totalCollateral = obj.total_collateral;
  const denomination = obj.denomination;

  if (typeof totalDebt !== "bigint" || typeof totalCollateral !== "bigint") {
    return { kind: "undecodable" };
  }
  // the contract removes a vault on full repay, so a zero-debt vault is a genuine
  // "nothing to close" absence, not a decode failure
  if (totalDebt === 0n) return { kind: "empty" };

  return {
    kind: "vault",
    vault: {
      denomination: typeof denomination === "string" ? denomination : fallbackDenomination,
      debt: totalDebt,
      collateral: totalCollateral,
    },
  };
}
