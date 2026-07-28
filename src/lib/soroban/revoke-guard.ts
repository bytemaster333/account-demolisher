// Guard the standalone allowance-revoke path against Soroban auth-entry smuggling.
//
// A revoke calls approve(from, spender, 0, ledger) on a contract id taken from an
// on-chain event scan — i.e. an ATTACKER-CONTROLLED contract (a hostile contract
// can emit a fake approve event naming the victim, so it shows up as a revocable
// allowance). prepareTransaction then attaches whatever SorobanAuthorizationEntry
// tree the attacker's simulation returns, and the standalone revoke path is exempt
// from the DeFi allow-list. Without this guard a hostile token could smuggle an
// over-broad auth entry (e.g. a nested transfer of the victim's OTHER balances)
// that the victim's single signature would authorize — draining funds during what
// the UI presents as a safety action.
//
// Before signing, we assert the built transaction is EXACTLY the intended
// approve(0) and that its auth tree authorizes nothing else: no other contract,
// no other function, no sub-invocations, no address credentials.

import { Address, Operation, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk";

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

// Throws UnsafeRevokeError unless `tx` is a single invokeHostFunction calling
// exactly expected.contractId.approve(from, spender, 0, ledger), whose every auth
// entry authorizes only that same approve (source-account credentials, no
// sub-invocations).
export function assertSafeRevokeInvocation(tx: Transaction, expected: ExpectedRevoke): void {
  if (tx.operations.length !== 1) {
    throw new UnsafeRevokeError(`expected exactly 1 operation, got ${tx.operations.length}`);
  }
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction") {
    throw new UnsafeRevokeError(`operation is "${op.type}", expected invokeHostFunction`);
  }
  const ihf = op as Operation.InvokeHostFunction;

  // 1) the invoked call itself must be exactly the intended approve(0)
  const func = ihf.func;
  if (func.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new UnsafeRevokeError(
      `host function is "${func.switch().name}", expected invokeContract`,
    );
  }
  assertApproveCall(func.invokeContract(), expected, "invocation");

  // 2) every auth entry must authorize ONLY that same approve. A hostile token
  //    that tries to move other balances must add either a sub-invocation or a
  //    separate entry targeting a different contract/function — both rejected here.
  const auth = ihf.auth ?? [];
  auth.forEach((entry, i) => {
    const cred = entry.credentials().switch().name;
    if (cred !== "sorobanCredentialsSourceAccount") {
      throw new UnsafeRevokeError(
        `auth[${i}] uses "${cred}" credentials; a safe revoke is authorized only by the source account`,
      );
    }
    const root = entry.rootInvocation();
    const subs = root.subInvocations();
    if (subs.length !== 0) {
      throw new UnsafeRevokeError(
        `auth[${i}] carries ${subs.length} sub-invocation(s); a safe revoke authorizes no nested calls`,
      );
    }
    const rootFn = root.function();
    if (rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
      throw new UnsafeRevokeError(
        `auth[${i}] root is "${rootFn.switch().name}", expected a contract call`,
      );
    }
    assertApproveCall(rootFn.contractFn(), expected, `auth[${i}]`);
  });
}

function assertApproveCall(
  call: xdr.InvokeContractArgs,
  expected: ExpectedRevoke,
  where: string,
): void {
  const addr = Address.fromScAddress(call.contractAddress()).toString();
  if (addr !== expected.contractId) {
    throw new UnsafeRevokeError(
      `${where} targets contract ${addr}, expected ${expected.contractId}`,
    );
  }
  const fnName = Buffer.from(call.functionName()).toString();
  if (fnName !== "approve") {
    throw new UnsafeRevokeError(`${where} calls "${fnName}", expected approve`);
  }
  const args = call.args();
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
