import { test, expect } from "@playwright/test";
import {
  Asset,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
} from "@stellar/stellar-sdk";

import { PASSPHRASE, SOROBAN_RPC_URL, friendbotFund, horizon } from "./support/chain";
import { connectWithSecret } from "./support/flow";

// the allowance viewer's revoke on testnet: an account approves a spender on the
// XLM token contract, finds the approval on /allowances and revokes it with the
// button on its row. the revoke is checked on chain, by asking the token
// contract for the remaining allowance.

const server = new rpc.Server(SOROBAN_RPC_URL);
const XLM_SAC = Asset.native().contractId(PASSPHRASE);

const address = (a: string) => nativeToScVal(a, { type: "address" });

async function approve(owner: Keypair, spender: string, amount: bigint): Promise<void> {
  const latest = await server.getLatestLedger();
  const tx = new TransactionBuilder(await horizon.loadAccount(owner.publicKey()), {
    fee: "1000000",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      new Contract(XLM_SAC).call(
        "approve",
        address(owner.publicKey()),
        address(spender),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(latest.sequence + 100_000, { type: "u32" }),
      ),
    )
    .setTimeout(120)
    .build();
  const prepared = (await server.prepareTransaction(tx)) as Transaction;
  prepared.sign(owner);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`approve not queued: ${sent.status}`);
  const res = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (res.status !== "SUCCESS") throw new Error(`approve ${sent.hash}: ${res.status}`);
}

async function allowance(owner: string, spender: string): Promise<bigint> {
  const tx = new TransactionBuilder(await horizon.loadAccount(owner), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(new Contract(XLM_SAC).call("allowance", address(owner), address(spender)))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || sim.result === undefined) {
    throw new Error("allowance() did not simulate");
  }
  return BigInt(scValToNative(sim.result.retval) as bigint);
}

test("finds an approval on /allowances and revokes it on chain", async ({ page }) => {
  test.setTimeout(240_000);

  const owner = Keypair.random();
  const spender = Keypair.random().publicKey();
  await friendbotFund(owner.publicKey());
  await approve(owner, spender, 25_0000000n);
  expect(await allowance(owner.publicKey(), spender)).toBe(25_0000000n);

  // connect with the pasted key, then go to the allowance viewer in the app
  await page.goto("/demolish");
  await connectWithSecret(page, owner.secret());
  await page.getByRole("link", { name: "Allowances" }).first().click();
  await expect(page).toHaveURL(/\/allowances/);

  await page.getByTestId("use-wallet-button").click();
  const row = page.getByTestId("allowance-row").filter({ hasText: spender.slice(0, 4) });
  await expect(row).toHaveCount(1, { timeout: 120_000 });

  const revoke = page.getByTestId(`revoke-button-${XLM_SAC}-${spender}`);
  await expect(revoke).toBeEnabled();
  await revoke.click();
  // once the revoke lands the viewer scans again, and the approval is no longer
  // listed as active
  await expect(page.getByText("No active allowances found")).toBeVisible({ timeout: 120_000 });
  await expect(row).toHaveCount(0);

  // on chain: the token contract reports nothing left to spend
  expect(await allowance(owner.publicKey(), spender)).toBe(0n);
});
