// qa seeder: creates a real, connectable 2-of-2 multisig account on stellar
// testnet that still holds a non-XLM balance (a trustline and tokens), so the
// whole shared-account close in /demolish can be walked through:
//
//   1. run this; it prints both signer secrets (master and co-signer)
//   2. /demolish -> "Advanced: paste a secret key" -> the master secret
//   3. pick a destination, return DEMO to its issuer when asked, review, and
//      "Create signing request" -> the signatures step opens with a share link
//   4. either paste the co-signer secret in that step to sign locally, or open
//      the share link (/sign?id=...) and sign there; the page updates live to
//      2 of 2, then submit the close
//
// the close has to return the token to its issuer and remove the trustline
// before it can merge, so this exercises the cleanup-in-a-bundle path, not
// just a bare account.
//
// every key is freshly generated, a zero-value testnet throwaway. never point
// this at mainnet or at a key that holds real value.
//
//   node scripts/qa/seed-multisig-account.mjs

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const horizon = new Horizon.Server(HORIZON_URL);

async function friendbotFund(pk) {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(pk)}`);
  if (!res.ok) {
    throw new Error(`friendbot funding failed for ${pk}: HTTP ${res.status} ${await res.text()}`);
  }
}

async function submit(signer, build) {
  const source = await horizon.loadAccount(signer.publicKey());
  const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE });
  build(builder);
  const tx = builder.setTimeout(120).build();
  tx.sign(signer);
  await horizon.submitTransaction(tx);
}

async function main() {
  const master = Keypair.random();
  const cosigner = Keypair.random();
  const destination = Keypair.random();
  const issuer = Keypair.random();
  const asset = new Asset("DEMO", issuer.publicKey());

  console.log("Seeding a connectable 2-of-2 multisig account (with a token balance)...\n");

  await Promise.all([
    friendbotFund(master.publicKey()),
    friendbotFund(destination.publicKey()),
    friendbotFund(issuer.publicKey()),
  ]);
  console.log("  funded master + destination + issuer via friendbot");

  // master trusts DEMO and receives 10 of it (a real blocking balance the close
  // must clear before it can merge)
  await submit(master, (b) => b.addOperation(Operation.changeTrust({ asset })));
  await submit(issuer, (b) =>
    b.addOperation(Operation.payment({ destination: master.publicKey(), asset, amount: "10" })),
  );
  console.log("  master now holds 10 DEMO on a trustline");

  // make master a real 2-of-2: both keys have to sign anything it does
  await submit(master, (b) =>
    b.addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: cosigner.publicKey(), weight: 1 },
        lowThreshold: 2,
        medThreshold: 2,
        highThreshold: 2,
      }),
    ),
  );
  console.log("  account is now 2-of-2\n");

  console.log("Done. Connect the MASTER secret in /demolish to try the shared-account close.\n");
  console.log("  Master secret (paste into /demolish):", master.secret());
  console.log("  Master public key                   :", master.publicKey());
  console.log("  Co-signer secret (second signer)     :", cosigner.secret());
  console.log("  Destination (merge target)           :", destination.publicKey());
  console.log("  Issuer of DEMO (token returns here)  :", issuer.publicKey());
  console.log("");
  console.log("  In /demolish: paste the master secret, pick the destination above, choose");
  console.log("  'return DEMO to issuer' when prompted, review, then 'Create signing request'.");
  console.log("  In the Signatures step, either paste the co-signer secret to sign locally, or");
  console.log("  open the share link and sign there; once it reaches 2/2, confirm the close.");
}

main().catch((err) => {
  console.error("\nSeeding failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
