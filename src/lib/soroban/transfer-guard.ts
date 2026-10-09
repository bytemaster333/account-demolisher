// guard the auto-drain of standalone SEP-41 tokens against auth-entry smuggling.
//
// held tokens are discovered by scanning `transfer`-to-the-account events, so the
// list can include a token an attacker airdropped, a fully attacker-controlled
// contract. to sweep one, the close builds contractId.transfer(user, destination,
// amount) and the user signs it. assembling the simulation attaches whatever
// SorobanAuthorizationEntry tree the token's own simulation returns, and this
// drain path is (like the revoke path) exempt from the DeFi allow-list. without a
// guard a hostile token could smuggle an over-broad auth entry (a nested transfer
// of the victim's other balances, or an approve to the attacker) that the single
// signature would authorize.
//
// before signing we assert the built transaction is exactly the intended
// transfer to the user's chosen destination and that its auth tree authorizes
// nothing else: no other contract, no other function, no sub-invocations, no
// address credentials. this mirrors assertSafeRevokeInvocation.

import { Address, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";
import { assertExactSingleInvocation } from "@/lib/soroban/single-invocation-guard";

export class UnsafeTransferError extends Error {
  constructor(reason: string) {
    super(`Refusing to sign token transfer: ${reason}`);
    this.name = "UnsafeTransferError";
  }
}

export interface ExpectedTransfer {
  readonly contractId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

// throws UnsafeTransferError unless `tx` is a single invokeHostFunction calling
// exactly expected.contractId.transfer(from, to, amount), whose every auth entry
// authorizes only that same transfer (source-account credentials, no
// sub-invocations).
export function assertSafeTransferInvocation(tx: Transaction, expected: ExpectedTransfer): void {
  assertExactSingleInvocation(tx, {
    action: "drain",
    fail: (reason) => new UnsafeTransferError(reason),
    checkCall: (call, where) => assertTransferCall(call, expected, where),
  });
}

function assertTransferCall(
  call: xdr.InvokeContractArgs,
  expected: ExpectedTransfer,
  where: string,
): void {
  const addr = Address.fromScAddress(call.contractAddress).toString();
  if (addr !== expected.contractId) {
    throw new UnsafeTransferError(
      `${where} targets contract ${addr}, expected ${expected.contractId}`,
    );
  }
  const fnName = call.functionName.toString();
  if (fnName !== "transfer") {
    throw new UnsafeTransferError(`${where} calls "${fnName}", expected transfer`);
  }
  const args = call.args;
  if (args.length !== 3) {
    throw new UnsafeTransferError(
      `${where} transfer has ${args.length} args, expected 3 (from, to, amount)`,
    );
  }
  const from = String(scValToNative(args[0]!));
  const to = String(scValToNative(args[1]!));
  const amount = scValToNative(args[2]!) as bigint;
  if (from !== expected.from) {
    throw new UnsafeTransferError(`${where} transfer from=${from}, expected ${expected.from}`);
  }
  if (to !== expected.to) {
    throw new UnsafeTransferError(`${where} transfer to=${to}, expected ${expected.to}`);
  }
  if (typeof amount !== "bigint" || amount !== expected.amount) {
    throw new UnsafeTransferError(
      `${where} transfer amount=${String(amount)}, expected ${expected.amount.toString()}`,
    );
  }
}
