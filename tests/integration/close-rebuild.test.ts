import { describe, it, expect, afterEach } from "vitest";
import { Asset, Keypair, Operation } from "@stellar/stellar-sdk";

import { TESTNET } from "@/lib/config/networks";
import { SecretKeyConnector } from "@/lib/wallet/secret-key";

import {
  confirm,
  friendbotFund,
  nativeBalance,
  outcomeSummary,
  startFlow,
  toStroops,
  waitForOutcome,
  type FlowActor,
} from "../helpers/headless-close";
import { fundedPair, rebuildToSuccess, reviewed, ScriptedWallet } from "../helpers/retry-flow";
import { horizon, submitClassicAs } from "../helpers/testnet-seed";

// RETRY after the failures that rebuild the plan, on testnet through the app's
// own state machine and executor: the account changed under the signed merge,
// and the market for a balance the close sells moved after the review. RETRY
// runs discovery again and stops at a new review, which the test confirms.

let actor: FlowActor | null = null;
afterEach(() => {
  actor?.stop();
  actor = null;
});

describe("integration: RETRY that rebuilds a failed close (testnet)", () => {
  it("not_mergeable: another device adds an entry while the merge is signed, a retry rebuilds and closes", async () => {
    const f = await fundedPair();
    const other = Keypair.random();
    await friendbotFund(TESTNET, other.publicKey());
    actor = startFlow();
    // the other device pays for its own transaction, so the account's sequence
    // stays put and only its entries change under the signed merge. it adds one
    // at every signature, so the executor's own rebuilds after the refused merge
    // (op_has_sub_entries) run out and the close fails
    let entries = 0;
    let racing = true;
    const raced = new ScriptedWallet(f.kp.secret(), async () => {
      if (!racing) return;
      entries += 1;
      await submitClassicAs(
        other,
        (b) =>
          b.addOperation(
            Operation.manageData({
              name: `other-device-${entries}`,
              value: "1",
              source: f.kp.publicKey(),
            }),
          ),
        [f.kp],
      );
    });
    await reviewed(actor, f, raced);
    confirm(actor);
    const failed = await waitForOutcome(actor);
    expect(failed.matches("failed"), outcomeSummary(failed)).toBe(true);
    expect(failed.context.failureKind).toBe("not_mergeable");
    expect(entries).toBeGreaterThan(0);
    const account = await horizon.loadAccount(f.kp.publicKey());
    expect(Object.keys(account.data_attr)).toHaveLength(entries);

    // the retry rebuilds the plan from what is on chain now, entries included
    racing = false;
    const rebuilt = await rebuildToSuccess(actor, f);
    // the rebuilt plan saw, and removed, the entries the other device added
    expect(rebuilt.context.audit?.data).toHaveLength(entries);
  }, 270_000);

  it("conversion_refused: the market moves after the review, nothing is signed, the rebuilt plan sells at the new price", async () => {
    const f = await fundedPair();
    const issuer = Keypair.random();
    const maker = Keypair.random();
    await friendbotFund(TESTNET, issuer.publicKey());
    await friendbotFund(TESTNET, maker.publicKey());
    const tst = new Asset("RTRY", issuer.publicKey());

    // the account holds 100 RTRY; the only market for it is one offer that
    // buys RTRY at 2 XLM each
    await submitClassicAs(f.kp, (b) => b.addOperation(Operation.changeTrust({ asset: tst })));
    await submitClassicAs(maker, (b) => b.addOperation(Operation.changeTrust({ asset: tst })));
    await submitClassicAs(issuer, (b) =>
      b.addOperation(
        Operation.payment({ destination: f.kp.publicKey(), asset: tst, amount: "100" }),
      ),
    );
    await submitClassicAs(maker, (b) =>
      b.addOperation(
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: tst,
          amount: "1000",
          price: "0.5",
        }),
      ),
    );

    actor = startFlow();
    const review = await reviewed(actor, f, new SecretKeyConnector(f.kp.secret()));
    // the review sells the RTRY on that market rather than asking about it
    expect(review.context.unroutableCredits).toEqual([]);

    // between the review and the confirm the maker halves its bid
    const offers = await horizon.offers().forAccount(maker.publicKey()).call();
    expect(offers.records).toHaveLength(1);
    await submitClassicAs(maker, (b) =>
      b.addOperation(
        Operation.manageSellOffer({
          selling: Asset.native(),
          buying: tst,
          amount: "1000",
          price: "1",
          offerId: offers.records[0]!.id,
        }),
      ),
    );

    const sequenceBefore = (await horizon.loadAccount(f.kp.publicKey())).sequence;
    confirm(actor);
    const failed = await waitForOutcome(actor);
    expect(failed.matches("failed"), outcomeSummary(failed)).toBe(true);
    expect(failed.context.failureKind).toBe("conversion_refused");
    expect(failed.context.error).toContain("Nothing was signed");
    // nothing was sold or sent: the account still holds the RTRY at the same sequence
    const untouched = await horizon.loadAccount(f.kp.publicKey());
    expect(untouched.sequence).toBe(sequenceBefore);
    const line = untouched.balances.find(
      (b) => "asset_code" in b && b.asset_code === "RTRY" && b.asset_issuer === issuer.publicKey(),
    );
    expect(line?.balance).toBe("100.0000000");

    // the retry rebuilds the plan and reviews the sale at the price the market
    // pays now; confirming it sells there and closes
    const destinationBefore = await nativeBalance(horizon, f.destination);
    await rebuildToSuccess(actor, f);

    // the maker bought all 100 RTRY at 1 XLM each, and the destination got the
    // account's XLM plus those 100 XLM, less fees
    const makerAccount = await horizon.loadAccount(maker.publicKey());
    const makerLine = makerAccount.balances.find(
      (b) => "asset_code" in b && b.asset_code === "RTRY",
    );
    expect(makerLine?.balance).toBe("100.0000000");
    const received = (await nativeBalance(horizon, f.destination)) - destinationBefore;
    const expected =
      toStroops(untouched.balances.find((b) => b.asset_type === "native")!.balance) + 100_0000000n;
    expect(received).toBeLessThanOrEqual(expected);
    expect(received).toBeGreaterThan(expected - 1_0000000n);
  });
});
