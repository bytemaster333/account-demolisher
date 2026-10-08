// guard the standalone allowance-revoke path against Soroban auth-entry smuggling.
//
// a revoke calls approve(from, spender, 0, ledger) on a contract id taken from an
// on-chain event scan, i.e. an ATTACKER-CONTROLLED contract (a hostile contract
// can emit a fake approve event naming the victim, so it shows up as a revocable
// allowance). assembling the simulation then attaches whatever SorobanAuthorizationEntry
// tree the attacker's simulation returns, and the standalone revoke path is exempt
// from the DeFi allow-list. without this guard a hostile token could smuggle an
// over-broad auth entry (e.g. a nested transfer of the victim's OTHER balances)
// that the victim's single signature would authorize, draining funds during what
// the UI presents as a safety action.
//
// before signing, we assert the built transaction is EXACTLY the intended
// approve(0) and that its auth tree authorizes nothing else: no other contract,
// no other function, no sub-invocations, no address credentials.

import { Address, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";
import { assertExactSingleInvocation } from "@/lib/soroban/single-invocation-guard";

export class UnsafeRevokeError extends Error {
  constructor(reason: string) {
    super(`Refusing to sign revoke: ${reason}`);
    this.name = "UnsafeRevokeError";
  }
}

export interface ExpectedRevoke {
  readonly contractId: string;
  readonly from: string;
  readonly spender: string;
}

// throws UnsafeRevokeError unless `tx` is a single invokeHostFunction calling
// exactly expected.contractId.approve(from, spender, 0, ledger), whose every auth
// entry authorizes only that same approve (source-account credentials, no
// sub-invocations).
export function assertSafeRevokeInvocation(tx: Transaction, expected: ExpectedRevoke): void {
  assertExactSingleInvocation(tx, {
    action: "revoke",
    fail: (reason) => new UnsafeRevokeError(reason),
    checkCall: (call, where) => assertApproveCall(call, expected, where),
  });
}

function assertApproveCall(
  call: xdr.InvokeContractArgs,
  expected: ExpectedRevoke,
  where: string,
): void {
  const addr = Address.fromScAddress(call.contractAddress).toString();
  if (addr !== expected.contractId) {
    throw new UnsafeRevokeError(
      `${where} targets contract ${addr}, expected ${expected.contractId}`,
    );
  }
  const fnName = call.functionName.toString();
  if (fnName !== "approve") {
    throw new UnsafeRevokeError(`${where} calls "${fnName}", expected approve`);
  }
  const args = call.args;
  if (args.length !== 4) {
    throw new UnsafeRevokeError(
      `${where} approve has ${args.length} args, expected 4 (from, spender, amount, ledger)`,
    );
  }
  const from = String(scValToNative(args[0]!));
  const spender = String(scValToNative(args[1]!));
  const amount = scValToNative(args[2]!) as bigint;
  if (from !== expected.from) {
    throw new UnsafeRevokeError(`${where} approve from=${from}, expected ${expected.from}`);
  }
  if (spender !== expected.spender) {
    throw new UnsafeRevokeError(
      `${where} approve spender=${spender}, expected ${expected.spender}`,
    );
  }
  if (typeof amount !== "bigint" || amount !== 0n) {
    throw new UnsafeRevokeError(
      `${where} approve amount=${String(amount)}, a revoke must set it to 0`,
    );
  }
}
