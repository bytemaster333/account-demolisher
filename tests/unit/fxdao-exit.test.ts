import { describe, it, expect } from "vitest";
import {
  Account,
  Operation,
  scValToNative,
  xdr,
  type Horizon,
} from "@stellar/stellar-sdk";

import { buildVaultExit } from "@/lib/adapters/fxdao/exit";
import type { FxDAOVault } from "@/lib/adapters/fxdao/client";
import { TESTNET } from "@/lib/config/networks";

// buildVaultExit encodes two real VaultsContract calls (pay_debt, redeem) whose
// arg shape must match the on-chain host: new_prev_key = None and amount = the
// full vault.debt (u128). A silent regression in either would still build a
// signable-but-doomed tx, so we assert the guard rejections and DECODE the built
// op args rather than trusting the builder.

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const ISSUER = "GAVH5ZWACAY2PHPUG4FL3LHHJIYIHOFPSIUGM2KHK25CJWXHAV6QKDMN";

// TransactionBuilder only reads accountId()/sequenceNumber() off the source, so
// a plain Account stands in for the Horizon.AccountResponse the signature wants.
function sourceAccount(): Horizon.AccountResponse {
  return new Account(USER, "1") as unknown as Horizon.AccountResponse;
}

function vault(debt: bigint): FxDAOVault {
  return { denomination: "USD", debt, collateral: 5_000_0000000n };
}

// pull the contract-call name and args out of a built single-op invoke tx
function invokeArgs(tx: {
  operations: readonly Operation[];
}): { fn: string; args: readonly xdr.ScVal[] } {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const call = op.func.invokeContract();
  return {
    fn: Buffer.from(call.functionName()).toString(),
    args: call.args(),
  };
}

// the None-tagged OptionalVaultKey decodes to a single-element vec ["None"]
function isNoneOptionalVaultKey(v: xdr.ScVal): boolean {
  const native = scValToNative(v);
  return Array.isArray(native) && native.length === 1 && native[0] === "None";
}

describe("buildVaultExit guards", () => {
  it("rejects a non-positive vault.debt", async () => {
    await expect(
      buildVaultExit(vault(0n), USER, TESTNET, sourceAccount(), ISSUER, null),
    ).rejects.toThrow(RangeError);
  });

  it("rejects an empty syntheticAssetIssuer", async () => {
    await expect(
      buildVaultExit(vault(1_000_0000000n), USER, TESTNET, sourceAccount(), "", null),
    ).rejects.toThrow(TypeError);
  });
});

describe("buildVaultExit encoding", () => {
  const DEBT = 1_234_5678900n;

  it("encodes pay_debt with new_prev_key=None and amount=full debt", async () => {
    const { payDebt } = await buildVaultExit(
      vault(DEBT),
      USER,
      TESTNET,
      sourceAccount(),
      ISSUER,
      null,
    );

    const { fn, args } = invokeArgs(payDebt);
    expect(fn).toBe("pay_debt");
    // pay_debt(prev_key, vault_key, new_prev_key, amount)
    expect(args).toHaveLength(4);
    // arg[2] is new_prev_key — must be None for a full-debt close
    expect(isNoneOptionalVaultKey(args[2]!)).toBe(true);
    // arg[3] is the amount — must round-trip to exactly the full vault debt
    expect(scValToNative(args[3]!)).toBe(DEBT);
  });

  it("encodes redeem with new_prev_key=None and amount=full debt", async () => {
    const { redeem } = await buildVaultExit(
      vault(DEBT),
      USER,
      TESTNET,
      sourceAccount(),
      ISSUER,
      null,
    );

    const { fn, args } = invokeArgs(redeem);
    expect(fn).toBe("redeem");
    // redeem(caller, denomination, new_prev_key, amount)
    expect(args).toHaveLength(4);
    // arg[2] is new_prev_key — hard-coded None
    expect(isNoneOptionalVaultKey(args[2]!)).toBe(true);
    // arg[3] is the burn amount — must equal the full vault debt
    expect(scValToNative(args[3]!)).toBe(DEBT);
  });
});
