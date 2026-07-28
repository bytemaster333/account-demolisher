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
import { address as scvAddress, i128 as scvI128 } from "@/lib/soroban/scval";
import { assertSafeTransferInvocation, UnsafeTransferError } from "@/lib/soroban/transfer-guard";

const CONTRACT = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const OTHER = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const DEST = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";
const AMOUNT = 500n;
const EXPECTED = { contractId: CONTRACT, from: USER, to: DEST, amount: AMOUNT };

function transferArgs(from = USER, to = DEST, amount = AMOUNT): xdr.ScVal[] {
  return [scvAddress(from), scvAddress(to), scvI128(amount)];
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

function hostFn(
  contractId = CONTRACT,
  fnName = "transfer",
  args = transferArgs(),
): xdr.HostFunction {
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

const okAuth = () => sourceAuth(invocation(CONTRACT, "transfer", transferArgs()));

describe("assertSafeTransferInvocation — accepts a legitimate drain", () => {
  it("passes transfer(user, destination, amount) with a matching source-account auth entry", () => {
    const tx = buildTx(hostFn(), [okAuth()]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).not.toThrow();
  });

  it("passes transfer with no auth entries (nothing to smuggle)", () => {
    const tx = buildTx(hostFn(), []);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).not.toThrow();
  });
});

describe("assertSafeTransferInvocation — rejects tampered invocations", () => {
  it("rejects a non-transfer function", () => {
    const tx = buildTx(hostFn(CONTRACT, "approve", transferArgs()), [okAuth()]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(UnsafeTransferError);
  });

  it("rejects a mismatched recipient (not the chosen destination)", () => {
    const tx = buildTx(hostFn(CONTRACT, "transfer", transferArgs(USER, OTHER_G(), AMOUNT)), [
      okAuth(),
    ]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(/to=/);
  });

  it("rejects a mismatched from (not the user)", () => {
    const tx = buildTx(hostFn(CONTRACT, "transfer", transferArgs(DEST, DEST, AMOUNT)), [okAuth()]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(/from=/);
  });

  it("rejects an amount that does not match the intended drain", () => {
    const tx = buildTx(hostFn(CONTRACT, "transfer", transferArgs(USER, DEST, AMOUNT + 1n)), [
      okAuth(),
    ]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(/amount=/);
  });

  it("rejects a different target contract", () => {
    const tx = buildTx(hostFn(OTHER, "transfer", transferArgs()), [okAuth()]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(/targets contract/);
  });
});

describe("assertSafeTransferInvocation — rejects auth-entry smuggling", () => {
  it("rejects an auth entry carrying a nested sub-invocation (smuggled second transfer)", () => {
    const smuggled = invocation(OTHER, "transfer", [
      scvAddress(USER),
      scvAddress(OTHER_G()),
      scvI128(999_999n),
    ]);
    const entry = sourceAuth(invocation(CONTRACT, "transfer", transferArgs(), [smuggled]));
    const tx = buildTx(hostFn(), [entry]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(/sub-invocation/);
  });

  it("rejects a second auth entry targeting a different contract's transfer", () => {
    const rogue = sourceAuth(
      invocation(OTHER, "transfer", [scvAddress(USER), scvAddress(OTHER_G()), scvI128(999_999n)]),
    );
    const tx = buildTx(hostFn(), [okAuth(), rogue]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(UnsafeTransferError);
  });

  it("rejects address credentials (only source-account auth is allowed)", () => {
    const entry = addressAuth(invocation(CONTRACT, "transfer", transferArgs()));
    const tx = buildTx(hostFn(), [entry]);
    expect(() => assertSafeTransferInvocation(tx, EXPECTED)).toThrow(/credentials/);
  });
});

// a second G-address used as a rogue recipient in tampered cases
function OTHER_G(): string {
  return "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
}
