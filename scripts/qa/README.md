# QA seeders (testnet)

Two Node scripts that create real state on Stellar testnet, so the `/allowances` page and the
shared-account close in `/demolish` have live data to test against. The pages cannot create this
state themselves.

Every key is a freshly generated testnet throwaway. Never run these against mainnet or with a key
that holds real value.

The scripts hold no keys: each run generates new accounts and funds them from friendbot.

Run from the repository root, so `@stellar/stellar-sdk` resolves from `node_modules`:

```bash
node scripts/qa/seed-allowance.mjs
node scripts/qa/seed-multisig-account.mjs
```

Set the app's header network to **TESTNET** before you use what they print.

## seed-allowance.mjs

Funds a throwaway owner account and calls `approve(...)` on the native asset's Stellar Asset
Contract, a real SEP-41 token, creating one live allowance. It prints the owner address and secret,
the spender, and the token contract.

- **Read-only:** paste the owner address into `/allowances` and select **Scan**. The allowance
  appears once the RPC has indexed the `approve` event, which takes a few seconds.
- **Revoke:** connect the owner first: on `/demolish`, open **Advanced: paste a secret key**,
  paste the owner secret and select **Continue with secret key**. The connection survives
  client-side navigation, so then go to `/allowances`, select **Scan my own address**, and revoke
  the row.

## seed-multisig-account.mjs

Builds a connectable 2-of-2 testnet account that still holds a non-XLM balance (a `DEMO` trustline
and tokens), so the close has to clean up before it merges. It prints both signer secrets (master
and co-signer), the merge destination, and the `DEMO` issuer.

1. On `/demolish`, open **Advanced: paste a secret key** and connect with the **master** secret.
   A **Shared account** bar shows the signing weight the close needs.
2. Enter the printed destination and continue. On a shared account nothing is sold on the market:
   in **Fix issues**, return `DEMO` to its issuer.
3. At the bottom of Review, select **Create signing request**. The **Signatures** step opens with a
   link for the other signers.
4. Add the co-signer's signature, either by pasting the **co-signer** secret under
   **SIGN A KEY LOCALLY** and selecting **Sign**, or by opening the link (`/sign?id=...`) in another
   browser and signing there. The weight bar updates live.
5. With the threshold met, continue to the final confirmation, type the last four characters of the
   destination, and submit the close.
