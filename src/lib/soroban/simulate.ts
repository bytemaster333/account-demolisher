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

// inclusion fee (stroops) for submitted soroban transactions. the sdk's BASE_FEE
// (100) is below mainnet's soroban fee-lane clearing rate (observed p50..p99 = 200
// via getFeeStats), so a tx bidding the minimum loses the fee auction, sits PENDING,
// and drops without ever being included in a ledger. we bid well above the clearing
// rate so a defi-exit step lands reliably on mainnet; at ~0.01 XLM per step this is
// negligible against the reserves an account close recovers, and a dropped exit would
// strand the close. assembleSubmittable adds the simulated resource fee on top.
export const SOROBAN_INCLUSION_FEE = "100000";

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

  // success or restore: both extend success
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

// cpu instruction headroom asked of the simulation (stellar-rpc's
// resourceConfig.instructionLeeway; preflight declares the measured count plus
// max(leeway, its own 50,000 default)). a call whose cost depends on ledger time,
// like a blend pool accruing interest, can need more instructions when it lands
// than when it was simulated: on testnet a blend withdraw declared 2,051,375 and
// used 2,051,391, failing with exceeded_limit, and every rebuild re-simulated
// the same tight budget. measured on mainnet 2026-10-06 for an XLM SAC transfer,
// 500,000 moved the declared count from 210,361 to 660,361 and the resource fee
// from 23,481 to 23,796 stroops.
export const SOROBAN_INSTRUCTION_LEEWAY = 500_000;

// simulate with instruction headroom and assemble the result. this is what
// server.prepareTransaction does, except that one sends no leeway. throws on a
// simulation failure.
export async function assembleSubmittable(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
): Promise<Transaction | FeeBumpTransaction> {
  const sim = await server.simulateTransaction(tx, {
    cpuInstructions: SOROBAN_INSTRUCTION_LEEWAY,
  });
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return rpc.assembleTransaction(tx, sim).build();
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
