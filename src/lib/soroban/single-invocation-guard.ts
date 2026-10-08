// the shape every guarded single-call soroban path shares (the standalone revoke
// and the held-token drain): one invokeHostFunction calling one contract, and
// auth entries that each authorize exactly that same call, with the source
// account's credentials and no nested calls. a hostile contract that wants the
// user's signature to cover more has to add a sub-invocation, another root call
// or address credentials, and each of those is refused here. the caller checks
// the call itself (contract, function, arguments) through checkCall.

import { Operation, xdr, type Transaction } from "@stellar/stellar-sdk";

export interface SingleInvocationRules {
  // the action named in the refusal ("revoke", "drain")
  readonly action: string;
  // the caller's own error type, so each path keeps its refusal class
  readonly fail: (reason: string) => Error;
  // throws (through fail) unless the call is exactly the intended one
  readonly checkCall: (call: xdr.InvokeContractArgs, where: string) => void;
}

export function assertExactSingleInvocation(tx: Transaction, rules: SingleInvocationRules): void {
  const { action, fail, checkCall } = rules;
  if (tx.operations.length !== 1) {
    throw fail(`expected exactly 1 operation, got ${tx.operations.length}`);
  }
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction") {
    throw fail(`operation is "${op.type}", expected invokeHostFunction`);
  }
  const ihf = op as Operation.InvokeHostFunction;

  // 1) the invoked call itself must be exactly the intended one
  const func = ihf.func;
  if (func.type !== "hostFunctionTypeInvokeContract") {
    throw fail(`host function is "${func.type}", expected invokeContract`);
  }
  checkCall(func.invokeContract, "invocation");

  // 2) every auth entry must authorize only that same call
  const auth = ihf.auth ?? [];
  auth.forEach((entry, i) => {
    const cred = entry.credentials.type;
    if (cred !== "sorobanCredentialsSourceAccount") {
      throw fail(
        `auth[${i}] uses "${cred}" credentials; a safe ${action} is authorized only by the source account`,
      );
    }
    const root = entry.rootInvocation;
    const subs = root.subInvocations;
    if (subs.length !== 0) {
      throw fail(
        `auth[${i}] carries ${subs.length} sub-invocation(s); a safe ${action} authorizes no nested calls`,
      );
    }
    const rootFn = root.function;
    if (rootFn.type !== "sorobanAuthorizedFunctionTypeContractFn") {
      throw fail(`auth[${i}] root is "${rootFn.type}", expected a contract call`);
    }
    checkCall(rootFn.contractFn, `auth[${i}]`);
  });
}
