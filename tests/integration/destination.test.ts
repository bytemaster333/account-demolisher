import { describe, it, expect } from "vitest";
import { BASE_FEE, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { checkDestination } from "@/lib/stellar/destination";
import { destinationRequiresMediator, requireMemoEnforcement } from "@/lib/safety/cex-registry";
import { describeSubmitError } from "@/lib/errors";
import { getHorizon } from "@/lib/stellar/horizon-client";
import { TESTNET } from "@/lib/config/networks";

// a live SEP-29 destination: the up-front check must see the flag, and a
// memo-less merge into it must fail with a message that names the cause

const server = getHorizon(TESTNET);

async function friendbotFund(pk: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbot}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status}`);
}

describe("integration: SEP-29 destination (testnet)", () => {
  it("detects config.memo_required and explains a memo-less merge refusal", async () => {
    const exchange = Keypair.random();
    const user = Keypair.random();
    await friendbotFund(exchange.publicKey());
    await friendbotFund(user.publicKey());

    const ex = await server.loadAccount(exchange.publicKey());
    const flagTx = new TransactionBuilder(ex, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.manageData({ name: "config.memo_required", value: "1" }))
      .setTimeout(120)
      .build();
    flagTx.sign(exchange);
    await server.submitTransaction(flagTx);

    const check = await checkDestination(exchange.publicKey(), TESTNET);
    expect(check).toEqual({ state: "exists", sep29MemoRequired: true });
    expect(destinationRequiresMediator(exchange.publicKey(), true)).toBe(true);
    expect(
      requireMemoEnforcement(exchange.publicKey(), undefined, { sep29MemoRequired: true }).ok,
    ).toBe(false);

    const missing = await checkDestination(Keypair.random().publicKey(), TESTNET);
    expect(missing).toEqual({ state: "missing" });

    const src = await server.loadAccount(user.publicKey());
    const mergeTx = new TransactionBuilder(src, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.passphrase,
    })
      .addOperation(Operation.accountMerge({ destination: exchange.publicKey() }))
      .setTimeout(120)
      .build();
    mergeTx.sign(user);
    let message = "";
    try {
      await server.submitTransaction(mergeTx);
    } catch (err) {
      message = describeSubmitError(err);
    }
    expect(message).toContain(exchange.publicKey());
    expect(message).toContain("memo");
  });
});
