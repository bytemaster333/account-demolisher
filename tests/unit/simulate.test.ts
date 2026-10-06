import { describe, expect, it } from "vitest";
import {
  Account,
  Contract,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import {
  SOROBAN_INCLUSION_FEE,
  SOROBAN_INSTRUCTION_LEEWAY,
  assembleSubmittable,
} from "@/lib/soroban/simulate";

// assembleSubmittable runs on a real rpc.Server; only its http client is stood
// in for, so the json-rpc request the sdk actually sends is what gets checked

const SOURCE = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

interface JsonRpcCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function serverAnswering(answer: (call: JsonRpcCall) => unknown) {
  const calls: JsonRpcCall[] = [];
  const server = new rpc.Server("https://rpc.example");
  server.httpClient.post = (async (_url: string, body: JsonRpcCall) => {
    calls.push(body);
    return { data: { jsonrpc: "2.0", id: 1, result: answer(body) } };
  }) as unknown as typeof server.httpClient.post;
  return { server, calls };
}

function unpreparedCall(): Transaction {
  return new TransactionBuilder(new Account(SOURCE, "41"), {
    fee: SOROBAN_INCLUSION_FEE,
    networkPassphrase: TESTNET.passphrase,
  })
    .addOperation(new Contract(CONTRACT).call("withdraw"))
    .setTimeout(300)
    .build();
}

// what stellar-rpc returns: the instruction count already includes any
// requested leeway
function rawSimulation(instructions: number, resourceFee: number) {
  const data = new SorobanDataBuilder()
    .setResources(instructions, 1_000, 500)
    .setResourceFee(resourceFee)
    .build();
  return {
    latestLedger: 1_000,
    minResourceFee: String(resourceFee),
    transactionData: data.toXdr("base64"),
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXdr("base64") }],
    events: [],
  };
}

describe("assembleSubmittable", () => {
  it("asks the rpc for instruction headroom so a ledger-time-dependent call does not run out", async () => {
    const { server, calls } = serverAnswering(() => rawSimulation(2_551_375, 60_000));
    await assembleSubmittable(server, unpreparedCall());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("simulateTransaction");
    expect(calls[0]!.params["resourceConfig"]).toEqual({
      instructionLeeway: SOROBAN_INSTRUCTION_LEEWAY,
    });
  });

  it("assembles the simulated resources and charges the resource fee once", async () => {
    const { server } = serverAnswering(() => rawSimulation(2_551_375, 60_000));
    const prepared = (await assembleSubmittable(server, unpreparedCall())) as Transaction;
    const env = prepared.toEnvelope();
    if (env.type !== "envelopeTypeTx") throw new Error(env.type);
    const ext = env.v1.tx.ext;
    if (ext.type !== "sorobanData") throw new Error("no soroban data");
    expect(ext.sorobanData.resources.instructions).toBe(2_551_375);
    expect(prepared.fee).toBe(String(BigInt(SOROBAN_INCLUSION_FEE) + 60_000n));
    expect(prepared.sequence).toBe("42");
  });

  it("throws the simulation error instead of returning an unprepared tx", async () => {
    const { server } = serverAnswering(() => ({
      latestLedger: 1_000,
      error: "HostError: Error(Contract, #1205)",
      events: [],
    }));
    await expect(assembleSubmittable(server, unpreparedCall())).rejects.toThrow(/#1205/);
  });
});
