#!/usr/bin/env node
// operator tool: finish an exchange forward whose recovery record holds a flow
// token from a build before memo and network were bound into tokens (four
// parts: nonce.expiry.destination.mac). the app refuses to renew those, since
// renewing would let whoever holds the token pick the memo. the operator can
// finish it: MEDIATOR_SECRET and the nonce derive the mediator key.
//
// the token's mac proves the destination. it does not prove the memo, so
// confirm the deposit memo with the user out of band (the exchange account
// page, a deposit screenshot) before running with --submit. an exchange
// deposit almost always needs one, so sending without a memo has to be asked
// for with --no-memo.
//
// usage:
//   MEDIATOR_SECRET=S... node scripts/mediator-legacy-forward.mjs \
//     --network mainnet|testnet --token <legacy flow token> \
//     (--memo-id <n> | --memo-text <s> | --memo-hash <h> | --memo-return <h> | --no-memo) \
//     [--closed-account G...] [--submit]
//
// a hash or return memo is 32 bytes as 64 hex characters or base64, the same
// forms the app accepts, so the value the recovery banner shows can be pasted.
//
// without --submit it only prints what it would send.

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";

import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  NotFoundError,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// the labels the v1 server used; the key label is the same in v2
const KEY_DERIVATION_LABEL = "mediator-flow-key";
const V1_TOKEN_MAC_LABEL = "mediator-flow-token";
const HORIZON = {
  mainnet: { url: "https://horizon.stellar.org", passphrase: Networks.PUBLIC },
  testnet: { url: "https://horizon-testnet.stellar.org", passphrase: Networks.TESTNET },
};
const FEE_PER_OP = 10_000;

function die(message) {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    network: { type: "string" },
    token: { type: "string" },
    "memo-id": { type: "string" },
    "memo-text": { type: "string" },
    "memo-hash": { type: "string" },
    "memo-return": { type: "string" },
    "no-memo": { type: "boolean", default: false },
    "closed-account": { type: "string" },
    submit: { type: "boolean", default: false },
  },
  strict: true,
});

const network = HORIZON[values.network ?? ""];
if (network === undefined) die("--network must be mainnet or testnet.");

const seed = process.env.MEDIATOR_SECRET;
if (seed === undefined || !StrKey.isValidEd25519SecretSeed(seed)) {
  die("MEDIATOR_SECRET must be set to the deployment's S... seed.");
}
const master = Keypair.fromSecret(seed).rawSecretKey();
const hmac = (msg) => createHmac("sha256", master).update(msg).digest();

const parts = (values.token ?? "").split(".");
if (parts.length !== 4) die("--token must be a legacy flow token (nonce.expiry.destination.mac).");
const [nonce, expiry, destination, mac] = parts;
if (!/^[0-9a-f]{32}$/u.test(nonce) || !/^[0-9a-f]{64}$/u.test(mac)) {
  die("--token is malformed.");
}
const expected = hmac(`${V1_TOKEN_MAC_LABEL}:${nonce}.${expiry}.${destination}`);
const given = Buffer.from(mac, "hex");
if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
  die("--token was not issued with this MEDIATOR_SECRET.");
}
if (!StrKey.isValidEd25519PublicKey(destination))
  die("the token's destination is not a G address.");
const closedAccount = values["closed-account"];
if (closedAccount !== undefined && !StrKey.isValidEd25519PublicKey(closedAccount)) {
  die("--closed-account must be a G address.");
}

const memoFlags = ["memo-id", "memo-text", "memo-hash", "memo-return"].filter(
  (k) => values[k] !== undefined,
);
if (values["no-memo"]) memoFlags.push("no-memo");
if (memoFlags.length !== 1) {
  die(
    "give exactly one of --memo-id, --memo-text, --memo-hash, --memo-return or --no-memo. " +
      "the deposit memo is in the user's recovery banner; confirm it with the user.",
  );
}
// same rule as memoHashBytes in src/lib/stellar/memo.ts. Memo.hash and
// Memo.return only take hex or raw bytes, so a base64 value is decoded here
function hashMemoBytes(value) {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(v)) return Buffer.from(v, "hex");
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(v) && v.length % 4 === 0) {
    const bytes = Buffer.from(v, "base64");
    if (bytes.length === 32) return bytes;
  }
  throw new Error("expected 32 bytes as 64 hex characters or base64");
}

let memo;
try {
  memo =
    values["memo-id"] !== undefined
      ? Memo.id(values["memo-id"])
      : values["memo-text"] !== undefined
        ? Memo.text(values["memo-text"])
        : values["memo-hash"] !== undefined
          ? Memo.hash(hashMemoBytes(values["memo-hash"]))
          : values["memo-return"] !== undefined
            ? Memo.return(hashMemoBytes(values["memo-return"]))
            : Memo.none();
} catch (err) {
  die(`--${memoFlags[0]} is not a valid memo: ${err instanceof Error ? err.message : String(err)}`);
}

const mediator = Keypair.fromRawEd25519Seed(hmac(`${KEY_DERIVATION_LABEL}:${nonce}`));
const server = new Horizon.Server(network.url);

let account;
try {
  account = await server.loadAccount(mediator.publicKey());
} catch (err) {
  if (err instanceof NotFoundError) {
    die(`mediator ${mediator.publicKey()} does not exist; its forward may already have gone out.`);
  }
  throw err;
}

// the forward only makes sense once the closed account was merged in. the
// whole history is read, page by page, since the merge need not be early in it
const isMergeIn = (op) =>
  op.type === "account_merge" &&
  op.into === mediator.publicKey() &&
  (closedAccount === undefined || op.account === closedAccount);
let page = await server
  .operations()
  .forAccount(mediator.publicKey())
  .order("asc")
  .limit(200)
  .call();
let mergeIn = page.records.find(isMergeIn);
while (mergeIn === undefined && page.records.length > 0) {
  page = await page.next();
  mergeIn = page.records.find(isMergeIn);
}
if (mergeIn === undefined) {
  die(
    `no merge into mediator ${mediator.publicKey()}` +
      (closedAccount === undefined ? "" : ` from ${closedAccount}`) +
      " in its whole history; nothing of the user's is there.",
  );
}

const latest = (await server.ledgers().order("desc").limit(1).call()).records[0];
if (latest === undefined) die("horizon returned no ledgers, so the base reserve is unknown.");
const reserve = BigInt(latest.base_reserve_in_stroops);
const native = account.balances.find((b) => b.asset_type === "native");
if (native === undefined)
  die(`horizon returned no XLM balance for mediator ${mediator.publicKey()}.`);
const toStroops = (s) => {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
};
const entries =
  2n +
  BigInt(account.subentry_count) +
  BigInt(account.num_sponsoring) -
  BigInt(account.num_sponsored);
const fee = BigInt(FEE_PER_OP) * 2n;
const amount =
  toStroops(native.balance) -
  toStroops(native.selling_liabilities ?? "0") -
  entries * reserve -
  fee;
if (amount <= 0n) die(`mediator balance ${native.balance} XLM does not cover its reserve and fee.`);
const amountText = `${amount / 10_000_000n}.${(amount % 10_000_000n).toString().padStart(7, "0")}`;

const tx = new TransactionBuilder(account, {
  fee: String(FEE_PER_OP),
  networkPassphrase: network.passphrase,
  memo,
})
  .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: amountText }))
  .addOperation(Operation.accountMerge({ destination }))
  .setTimeout(180)
  .build();
tx.sign(mediator);

console.log(`mediator     ${mediator.publicKey()}`);
console.log(`merged in by ${mergeIn.account} (tx ${mergeIn.transaction_hash})`);
console.log(`destination  ${destination}`);
const memoValue =
  memo.value === null || memo.value === undefined
    ? ""
    : typeof memo.value === "string"
      ? ` ${memo.value}`
      : ` ${Buffer.from(memo.value).toString("hex")}`;
console.log(`memo         ${memo.type}${memoValue}`);
console.log(`payment      ${amountText} XLM, then merge of the rest`);
console.log(`tx hash      ${Buffer.from(tx.hash()).toString("hex")}`);

if (!values.submit) {
  console.log("dry run: pass --submit to send it.");
  process.exit(0);
}
try {
  const res = await server.submitTransaction(tx);
  console.log(`submitted in ledger ${res.ledger}`);
} catch (err) {
  const codes = err?.response?.data?.extras?.result_codes;
  die(`submit failed: ${codes ? JSON.stringify(codes) : String(err)}`);
}
