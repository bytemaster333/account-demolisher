import { describe, it, expect } from "vitest";
import {
  Account,
  Address,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { address as scvAddress, i128 as scvI128, u32 as scvU32 } from "@/lib/soroban/scval";
import { assertSafeRevokeInvocation, UnsafeRevokeError } from "@/lib/soroban/revoke-guard";

const CONTRACT = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const OTHER = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const SPENDER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";
const EXPECTED = { contractId: CONTRACT, from: USER, spender: SPENDER };

function approveArgs(from = USER, spender = SPENDER, amount = 0n, ledger = 1000): xdr.ScVal[] {
  return [scvAddress(from), scvAddress(spender), scvI128(amount), scvU32(ledger)];
}

function invokeContractArgs(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(contractId).toScAddress(),
    functionName: fnName,
    args,
  });
}

function hostFn(contractId = CONTRACT, fnName = "approve", args = approveArgs()): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    invokeContractArgs(contractId, fnName, args),
  );
}

function invocation(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invokeContractArgs(contractId, fnName, args),
    ),
    subInvocations: subs,
  });
}

function sourceAuth(inv: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: inv,
  });
}

function addressAuth(inv: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(USER).toScAddress(),
        nonce: new xdr.Int64(1),
        signatureExpirationLedger: 2000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: inv,
  });
}

function buildTx(func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[] = []): Transaction {
  const op = Operation.invokeHostFunction({ func, auth });
  const source = new Account(USER, "0");
  return new TransactionBuilder(source, { fee: "100", networkPassphrase: TESTNET.passphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
}

const okAuth = () => sourceAuth(invocation(CONTRACT, "approve", approveArgs()));

describe("assertSafeRevokeInvocation — accepts a legitimate revoke", () => {
  it("passes approve(0) with a matching source-account auth entry", () => {
    const tx = buildTx(hostFn(), [okAuth()]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).not.toThrow();
  });

  it("passes approve(0) with no auth entries (nothing to smuggle)", () => {
    const tx = buildTx(hostFn(), []);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).not.toThrow();
  });
});

describe("assertSafeRevokeInvocation — rejects tampered invocations", () => {
  it("rejects a non-approve function", () => {
    const tx = buildTx(hostFn(CONTRACT, "transfer", approveArgs()), [okAuth()]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(UnsafeRevokeError);
  });

  it("rejects a non-zero approve amount (not a revoke)", () => {
    const tx = buildTx(hostFn(CONTRACT, "approve", approveArgs(USER, SPENDER, 1_000n)), [okAuth()]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(/amount=/);
  });

  it("rejects a mismatched from (not the user)", () => {
    const tx = buildTx(hostFn(CONTRACT, "approve", approveArgs(SPENDER, SPENDER, 0n)), [okAuth()]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(/from=/);
  });

  it("rejects a different target contract", () => {
    const tx = buildTx(hostFn(OTHER, "approve", approveArgs()), [okAuth()]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(/targets contract/);
  });
});

describe("assertSafeRevokeInvocation — rejects auth-entry smuggling", () => {
  it("rejects an auth entry carrying a nested sub-invocation (smuggled transfer)", () => {
    const smuggledTransfer = invocation(OTHER, "transfer", [
      scvAddress(USER),
      scvAddress(SPENDER),
      scvI128(999_999n),
    ]);
    const entry = sourceAuth(invocation(CONTRACT, "approve", approveArgs(), [smuggledTransfer]));
    const tx = buildTx(hostFn(), [entry]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(/sub-invocation/);
  });

  it("rejects a second auth entry targeting a different contract's transfer", () => {
    const rogue = sourceAuth(
      invocation(OTHER, "transfer", [scvAddress(USER), scvAddress(SPENDER), scvI128(999_999n)]),
    );
    const tx = buildTx(hostFn(), [okAuth(), rogue]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(UnsafeRevokeError);
  });

  it("rejects address credentials (only source-account auth is allowed)", () => {
    const entry = addressAuth(invocation(CONTRACT, "approve", approveArgs()));
    const tx = buildTx(hostFn(), [entry]);
    expect(() => assertSafeRevokeInvocation(tx, EXPECTED)).toThrow(/credentials/);
  });
});
