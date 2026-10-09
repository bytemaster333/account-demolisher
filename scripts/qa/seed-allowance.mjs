// qa seeder: creates a real, live SEP-41 allowance on stellar testnet so the
// /allowances viewer has something to list and revoke. the page cannot create
// one itself.
//
// it funds a throwaway testnet account, then calls approve(from, spender,
// amount, expiration_ledger) on the native asset's stellar asset contract (a
// real SEP-41 token). the viewer finds allowances by scanning soroban approve
// events, so a few seconds after this runs the allowance shows up under the
// printed owner address.
//
// every key is freshly generated, a zero-value testnet throwaway. never point
// this at mainnet or at a key that holds real value.
//
//   node scripts/qa/seed-allowance.mjs
//
// then in the app (testnet):
//   - read-only: paste the owner address into /allowances and scan
//   - revoke:    /demolish -> "Advanced: paste a secret key" -> the owner secret,
//                then /allowances -> "Scan my own address" -> revoke the row

import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;

// arbitrary non-zero allowance: 10.0000000 units at 7 decimals
const APPROVE_AMOUNT = 100_000_000n;
// the viewer finds an allowance by its approve event, scanning about the last 7
// days (120,960 ledgers, the rpc event retention window). 200,000 ledgers (about
// 11.5 days at 5s a ledger) keeps the allowance live past the whole time its
// approve event can still be found
const EXPIRATION_LEDGERS_AHEAD = 200_000;

async function friendbotFund(pk) {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) {
    throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const owner = Keypair.random();
  const spender = Keypair.random();
  const sacId = Asset.native().contractId(PASSPHRASE); // native SAC = real SEP-41 token

  console.log("Seeding a SEP-41 allowance on testnet...\n");
  console.log("  Owner (scan this in /allowances) :", owner.publicKey());
  console.log("  Owner secret (to connect + revoke):", owner.secret());
  console.log("  Spender (the approved address)    :", spender.publicKey());
  console.log("  Token (native SAC contract)       :", sacId);
  console.log("");

  await friendbotFund(owner.publicKey());
  console.log("  funded owner via friendbot");

  const server = new rpc.Server(RPC_URL, { allowHttp: false });
  const horizon = new Horizon.Server(HORIZON_URL);

  const { sequence: currentLedger } = await server.getLatestLedger();
  const expiration = currentLedger + EXPIRATION_LEDGERS_AHEAD;

  const source = await horizon.loadAccount(owner.publicKey());
  const contract = new Contract(sacId);
  const approveOp = contract.call(
    "approve",
    new Address(owner.publicKey()).toScVal(),
    new Address(spender.publicKey()).toScVal(),
    nativeToScVal(APPROVE_AMOUNT, { type: "i128" }),
    nativeToScVal(expiration, { type: "u32" }),
  );

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(approveOp)
    .setTimeout(120)
    .build();

  // simulate + assemble the Soroban footprint/resource fee, then sign & submit
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(owner);

  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new Error(`RPC did not enqueue approve (status: ${sent.status})`);
  }

  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== "SUCCESS") {
    throw new Error(`approve did not confirm (status: ${result.status})`);
  }

  console.log("  approve confirmed:", sent.hash);
  console.log(`  allowance live until ledger ${expiration} (current ~${currentLedger})`);
  console.log("\nDone. Scan the owner address in /allowances (give the RPC ~30s to index).");
}

main().catch((err) => {
  console.error("\nSeeding failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
