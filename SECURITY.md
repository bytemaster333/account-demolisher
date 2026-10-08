# Security

Account Demolisher signs irreversible transactions: a merged account is gone. This file says how to
report a vulnerability, what the app trusts, what defends each boundary, and the risks that remain.
The full threat model is the
[security model](https://docs.demolisher.app/docs/developers/security/model) page, and the review
history is on the [audit status](https://docs.demolisher.app/docs/developers/security/audit) page.

## Reporting a vulnerability

Do not open a public issue. Email the security contact published as `ORG_OFFICIAL_EMAIL` in the
deployment's SEP-1 file, <https://demolisher.app/.well-known/stellar.toml> (the same file is
`public/stellar.toml` in this repository). Include the affected commit or URL, the network, and the
steps or transaction hashes that show the problem. Do not test against accounts you do not control,
and do not sign anything on mainnet to prove a finding.

## Audit status

An independent external audit has not been performed yet. An internal pre-audit review of commit
`764d808` recorded 261 issues (8 critical, 39 high, 64 medium, 125 low, 25 info). Every critical
issue is fixed; the audit status page lists the counts by severity and status and what remains
open.

## Trust model

- **Non-custodial.** A user's secret key never reaches the server. Wallets sign through Stellar
  Wallets Kit. The pasted-key path keeps the seed in a private class field of
  `SecretKeyConnector` (`src/lib/wallet/secret-key.ts`), held in module scope only
  (`src/lib/wallet/active-connector.ts`), never in a store or browser storage, and no code sends
  it anywhere.
- **The browser builds and submits.** The server never builds a transaction for a user to sign and
  never submits one. The mediator forward is built and submitted by the browser too; the server only
  adds the forwarding account's co-signature.
- **The server is trusted for exchange closes.** `MEDIATOR_SECRET` (`src/server/mediator-secret.ts`,
  `server-only`) is an HMAC master that derives every forwarding account's key and signs flow
  tokens. An honest server co-signs only a forward to the destination, memo and network bound into
  the flow token (`src/lib/mediator/validator.ts`). Whoever controls the server can derive every
  forwarding key and change the code the browser runs, so an exchange close trusts the operator
  with the balance while it is in transit. The merge and the forward run back to back. A direct
  close never uses the forwarding account.
- **Horizon, Soroban RPC and on-chain contracts are untrusted.** They supply the state a plan is
  built from; the checks below decide what is signed.

## Server secrets

| Variable              | Power                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MEDIATOR_SECRET`     | Derives every forwarding key and signs flow tokens. Never logged: the mediator routes redact any seed from their error logs |
| `METRICS_ADMIN_TOKEN` | Reads the aggregate usage metrics (`GET /api/metrics`)                                                                      |
| `SOROSWAP_API_KEY`    | Spends the deployment's Soroswap aggregator quota through `/api/soroswap`                                                   |

## Threats and mitigations

| Threat                                                                | Mitigation                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination substitution (clipboard, a mistyped paste)                | Typed last-four-character confirmation with a four-second timer; the memo is shown on the same screen; a high-value acknowledgement above 1,000 XLM or for any holding the app cannot price                                                                                                                                 |
| A hostile token or RPC adding calls to a simulated authorization tree | Every DeFi step is held to the exact tree its call needs (`src/lib/soroban/defi-auth-guard.ts`); revokes and token transfers to one exact call each (`revoke-guard.ts`, `transfer-guard.ts`)                                                                                                                                |
| A signature steered to an unknown contract                            | A compiled-in, network-specific allow-list of entry points, checked in each adapter and again before signing (`src/lib/stellar/allowlist.ts`, `src/lib/config/contracts.ts`); contract creation and wasm upload are refused, including inside authorization entries                                                         |
| A hostile token or RPC inflating fees or rent                         | A resource-fee and write cap per class of step, checked before signing (`src/lib/soroban/fee-cap.ts`)                                                                                                                                                                                                                       |
| A wallet returning a different envelope                               | `verifySignedEnvelope` requires the built transaction's hash and a valid signature from the connected key (`src/lib/wallet/signed-envelope.ts`)                                                                                                                                                                             |
| A Ledger signing a blind hash                                         | Ledger signs with `nonBlindTx`, so the device shows the operations; there is no hash-signing fallback                                                                                                                                                                                                                       |
| Merging around an open or unreadable DeFi position                    | Positions are discovered again before the merge, and the merge is refused while any is open or any protocol could not be read                                                                                                                                                                                               |
| A sale at a manipulated price                                         | Minimum outputs carry the slippage tolerance (1% by default); a full-size sale more than 2% worse than a reference trade of 1/1000 of the balance, or worse than the reviewed quote, needs the user's decision per token                                                                                                    |
| Lost exchange deposits                                                | A registry or SEP-29 memo-required destination needs a well-formed memo of an accepted type, and routes through the forwarding account; exchange internal wallets are refused                                                                                                                                               |
| A leaked flow token                                                   | It unlocks only a forward to the committed destination, memo and network, with a fee of at most 2,000,000 stroops and no preconditions beyond a time bound of at most one hour                                                                                                                                              |
| A double submission of an irreversible step                           | Submissions are journaled by hash; an unknown outcome is looked up on chain before anything is signed again                                                                                                                                                                                                                 |
| A co-signer slipping in a different transaction                       | The relay merges only signatures that verify over the stored transaction's hash against the account's signers, deduplicated by signer and stopped at the threshold (`src/server/signing-relay.ts`)                                                                                                                          |
| Scam and look-alike tokens                                            | Symbol collision, look-alike symbol, suspicious characters and unrecognized contract checks before the close                                                                                                                                                                                                                |
| Abuse of the API routes                                               | Per-client rate limits keyed through the trusted proxy (`src/server/rate-limit.ts`), request body caps in the routes and at the proxy, and a relay that accepts only a close already signed by one of the account's signers                                                                                                 |
| Script injection                                                      | A Content-Security-Policy set per document response in `src/proxy.ts` (built in `src/lib/config/csp.ts`), no third-party script origin, `object-src 'none'`, `frame-ancestors 'none'`; React escapes rendered text, and the one `dangerouslySetInnerHTML` (`src/app/layout.tsx`) is a fixed theme script with no user input |
| Supply chain                                                          | A committed lockfile installed with `--frozen-lockfile`, `pnpm audit --prod --audit-level high` in CI and the release workflow, and a digest-pinned base image                                                                                                                                                              |

## Content Security Policy

`script-src` is `'self' 'unsafe-inline' 'wasm-unsafe-eval'`. Next's inline hydration scripts are not
nonce-stamped in this deployment, and a nonce-only policy blocks hydration. The policy loads no
third-party script origin, but an injected inline script would run and could reach every origin
`connect-src` allows: Horizon, Soroban RPC, the Aquarius and Soroswap APIs, and the WalletConnect
and Reown hosts. `next.config.ts` adds `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, a `Permissions-Policy`, and HSTS in production.

## Residual risks

- **No external audit yet.**
- **The operator holds funds in transit on an exchange close**, as described above.
- **`'unsafe-inline'` scripts**, as described above.
- **Per-instance state.** The rate limiter and the signing relay live in process memory. A restart
  loses open signing requests, and the deployment is meant to run as one instance.
- **The proxy is load-bearing.** Rate limits key on `X-Forwarded-For` as appended by the trusted
  proxy. Publishing the app's port directly lets a client choose its own key.
- **Seven-day event window.** Allowances and standalone tokens are found from Soroban RPC events,
  which public RPCs keep for about seven days. Older ones are not found by the scan; the app says
  so, and offers a manual entry for standalone tokens.
- **Gauge rewards in pools already left** are out of scope: no RPC-only source lists them.
- **Blend backstop emissions.** On mainnet the backstop emissions claim currently traps inside the
  BLND-USDC comet pool. The close then asks the user to forfeit the accrued BLND explicitly before
  queueing the withdrawal.
- **New Aquarius concentrated pools** are not on the pinned list until it is updated; discovery
  reports such a pool as an error, so the merge stays blocked instead of leaving the position.
- **Third-party telemetry through WalletConnect.** When a user picks WalletConnect, or signs with a
  restored WalletConnect session, Reown AppKit sends its mandatory events, including the page URL,
  to `pulse.walletconnect.org`.
- **First-party metrics.** A completed close sends its merge transaction hash to `/api/metrics`,
  which identifies the closed account on the public ledger. The close count rests on a public
  on-chain marker that anyone can copy into a merge, bounded by daily caps.
- **The mainnet RPC default** is a third-party gateway (`src/lib/config/networks.ts`).
- **Dependencies.** `pnpm audit --prod` reports five low and moderate advisories, all under a wallet
  module the app does not import, with no fix inside the version ranges that pull them in. The
  audit status page lists them.
