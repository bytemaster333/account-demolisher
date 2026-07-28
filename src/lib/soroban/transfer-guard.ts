// Guard the auto-drain of standalone SEP-41 tokens against auth-entry smuggling.
//
// Held tokens are discovered by scanning `transfer`-to-the-account events, so the
// list can include a token an ATTACKER airdropped — a fully attacker-controlled
// contract. To sweep one, the close builds contractId.transfer(user, destination,
// amount) and the user signs it. prepareTransaction attaches whatever
// SorobanAuthorizationEntry tree the token's own simulation returns, and this
// drain path is (like the revoke path) exempt from the DeFi allow-list. Without a
// guard a hostile token could smuggle an over-broad auth entry (a nested transfer
// of the victim's OTHER balances, or an approve to the attacker) that the single
// signature would authorize.
//
// Before signing we assert the built transaction is EXACTLY the intended
// transfer to the user's chosen destination and that its auth tree authorizes
// nothing else: no other contract, no other function, no sub-invocations, no
// address credentials. This mirrors assertSafeRevokeInvocation (SEC-02).

import { Address, Operation, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

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

// Throws UnsafeTransferError unless `tx` is a single invokeHostFunction calling
// exactly expected.contractId.transfer(from, to, amount), whose every auth entry
// authorizes only that same transfer (source-account credentials, no
// sub-invocations).
export function assertSafeTransferInvocation(tx: Transaction, expected: ExpectedTransfer): void {
  if (tx.operations.length !== 1) {
    throw new UnsafeTransferError(`expected exactly 1 operation, got ${tx.operations.length}`);
  }
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction") {
    throw new UnsafeTransferError(`operation is "${op.type}", expected invokeHostFunction`);
  }
  const ihf = op as Operation.InvokeHostFunction;

  // 1) the invoked call itself must be exactly the intended transfer
  const func = ihf.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new UnsafeTransferError(
      `host function is "${func.switch().name}", expected invokeContract`,
    );
  }
  assertTransferCall(func.invokeContract(), expected, "invocation");

  // 2) every auth entry must authorize ONLY that same transfer. A hostile token
  //    that tries to move other balances must add either a sub-invocation or a
  //    separate entry targeting a different contract/function — both rejected here.
  const auth = ihf.auth ?? [];
  auth.forEach((entry, i) => {
    const cred = entry.credentials().switch().name;
    if (cred !== "sorobanCredentialsSourceAccount") {
      throw new UnsafeTransferError(
        `auth[${i}] uses "${cred}" credentials; a safe drain is authorized only by the source account`,
      );
    }
    const root = entry.rootInvocation();
    const subs = root.subInvocations();
    if (subs.length !== 0) {
      throw new UnsafeTransferError(
        `auth[${i}] carries ${subs.length} sub-invocation(s); a safe drain authorizes no nested calls`,
      );
    }
    const rootFn = root.function();
    if (rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
      throw new UnsafeTransferError(
        `auth[${i}] root is "${rootFn.switch().name}", expected a contract call`,
      );
    }
    assertTransferCall(rootFn.contractFn(), expected, `auth[${i}]`);
  });
}

function assertTransferCall(
  call: xdr.InvokeContractArgs,
  expected: ExpectedTransfer,
  where: string,
): void {
  const addr = Address.fromScAddress(call.contractAddress()).toString();
  if (addr !== expected.contractId) {
    throw new UnsafeTransferError(
      `${where} targets contract ${addr}, expected ${expected.contractId}`,
    );
  }
  const fnName = Buffer.from(call.functionName()).toString();
  if (fnName !== "transfer") {
    throw new UnsafeTransferError(`${where} calls "${fnName}", expected transfer`);
  }
  const args = call.args();
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
