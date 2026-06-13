// single entry point for simulateTransaction against an rpc.server

import {
  Account,
  BASE_FEE,
  Contract,
  rpc,
  TransactionBuilder,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@/lib/config/networks";

// success branch carries everything needed for read or assemble
export interface SimulationSuccess {
  readonly ok: true;
  readonly retval: xdr.ScVal | null;
  readonly transactionData: rpc.Api.SimulateTransactionSuccessResponse["transactionData"];
  readonly minResourceFee: string;
  readonly auth: readonly xdr.SorobanAuthorizationEntry[];
  readonly latestLedger: number;
  // present when the simulation reports a restorePreamble
  readonly restorePreamble?: rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"];
}

export interface SimulationFailure {
  readonly ok: false;
  readonly error: string;
  readonly diagnostic: readonly xdr.DiagnosticEvent[];
  readonly latestLedger: number;
}

export type SimulationResult = SimulationSuccess | SimulationFailure;

// normalize the sdk's union response into a discriminated result
export async function simulate(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<SimulationResult> {
  const resp = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(resp)) {
    return {
      ok: false,
      error: resp.error,
      diagnostic: resp.events,
      latestLedger: resp.latestLedger,
    };
  }

  // success or restore — both extend success
  const success = resp as rpc.Api.SimulateTransactionSuccessResponse;
  const retval = success.result?.retval ?? null;
  const auth = success.result?.auth ?? [];

  const out: SimulationSuccess = {
    ok: true,
    retval,
    transactionData: success.transactionData,
    minResourceFee: success.minResourceFee,
    auth,
    latestLedger: success.latestLedger,
    ...(rpc.Api.isSimulationRestore(resp) ? { restorePreamble: resp.restorePreamble } : {}),
  };
  return out;
}

// wraps prepareTransaction. throws on simulation failure per sdk contract
export async function assembleSubmittable(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<Transaction | FeeBumpTransaction> {
  return server.prepareTransaction(tx);
}

// convenience for read-only contract calls. returns the retval scval
export async function simulateRead(
  server: rpc.Server,
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  sourcePublicKey: string,
  network: NetworkConfig,
): Promise<{ retval: xdr.ScVal }> {
  // sequence 0 is fine for read-only simulation
  const account = new Account(sourcePublicKey, "0");
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(contract.call(fnName, ...args))
    .setTimeout(30)
    .build();

  const sim = await simulate(server, tx);
  if (!sim.ok) {
    throw new SimulationError(
      `simulateRead ${contractId}.${fnName} failed: ${sim.error}`,
      sim.error,
      sim.diagnostic,
    );
  }
  if (sim.retval === null) {
    throw new SimulationError(
      `simulateRead ${contractId}.${fnName}: simulation succeeded but no retval was returned`,
      "missing-retval",
      [],
    );
  }
  return { retval: sim.retval };
}

// carries the upstream error string and parsed diagnostic events
export class SimulationError extends Error {
  public readonly errorCode: string;
  public readonly diagnostic: readonly xdr.DiagnosticEvent[];

  constructor(message: string, errorCode: string, diagnostic: readonly xdr.DiagnosticEvent[]) {
    super(message);
    this.name = "SimulationError";
    this.errorCode = errorCode;
    this.diagnostic = diagnostic;
  }
}
