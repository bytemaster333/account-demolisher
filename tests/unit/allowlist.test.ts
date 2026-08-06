import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";

import {
  assertTransactionAllowed,
  getViolations,
  AllowlistViolation,
} from "@/lib/stellar/allowlist";
import { getAllowlistForNetwork } from "@/lib/config/contracts";
import { TESTNET } from "@/lib/config/networks";

// The sign-time allow-list gate (executor.ts calls this immediately before
// signing every DeFi node). These lock in that the gate actually FIRES: it blocks
// a non-allow-listed contract, a contract-creation host function, and a wasm
// upload, while passing a classical op and an allow-listed invocation.

const SOURCE = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const ALLOWED_ROUTER = getAllowlistForNetwork(TESTNET).find(
  (c) => c.protocol === "soroswap" && c.name === "SoroswapRouter",
)!.id;
const NOT_ALLOWED = StrKey.encodeContract(Buffer.alloc(32, 42));

function tx(op: xdr.Operation) {
  return new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.passphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
}

describe("assertTransactionAllowed — sign-time allow-list gate fires", () => {
  it("passes a classical-only transaction (no contract invocations)", () => {
    const t = tx(Operation.payment({ destination: SOURCE, asset: Asset.native(), amount: "1" }));
    expect(() => assertTransactionAllowed(t, TESTNET)).not.toThrow();
    expect(getViolations(t, TESTNET)).toEqual([]);
  });

  it("passes an invocation of an allow-listed contract", () => {
    const t = tx(new Contract(ALLOWED_ROUTER).call("noop"));
    expect(getViolations(t, TESTNET)).toEqual([]);
  });

  it("BLOCKS an invocation of a non-allow-listed contract", () => {
    const t = tx(new Contract(NOT_ALLOWED).call("transfer"));
    expect(() => assertTransactionAllowed(t, TESTNET)).toThrow(AllowlistViolation);
    const v = getViolations(t, TESTNET);
    expect(v).toHaveLength(1);
    expect(v[0]!.contractId).toBe(NOT_ALLOWED);
    expect(v[0]!.reason).toMatch(/TESTNET_ALLOWLIST/);
  });

  it("BLOCKS a contract-creation host function", () => {
    const t = tx(Operation.createStellarAssetContract({ asset: new Asset("SCAM", SOURCE) }));
    expect(() => assertTransactionAllowed(t, TESTNET)).toThrow(/not permitted/);
    expect(getViolations(t, TESTNET)[0]!.contractId).toBe("<create-contract>");
  });

  it("BLOCKS a WASM-upload host function", () => {
    const t = tx(Operation.uploadContractWasm({ wasm: Buffer.from([0, 1, 2, 3]) }));
    expect(() => assertTransactionAllowed(t, TESTNET)).toThrow(/WASM-upload/);
    expect(getViolations(t, TESTNET)[0]!.contractId).toBe("<upload-wasm>");
  });

  it("reports EVERY violation across a multi-op transaction", () => {
    const t = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(new Contract(NOT_ALLOWED).call("a"))
      .addOperation(Operation.uploadContractWasm({ wasm: Buffer.from([9]) }))
      .setTimeout(60)
      .build();
    expect(getViolations(t, TESTNET)).toHaveLength(2);
  });
});
