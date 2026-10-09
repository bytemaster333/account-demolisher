# Architecture

Account Demolisher closes a Stellar account: it unwinds classic entries and Soroban DeFi
positions, disposes of every balance, and merges the account into a destination, directly or, for
a destination that needs a memo, through a temporary forwarding account (the mediator). The browser
builds, checks and submits every transaction; the account owner's wallet or pasted key signs it.
The server never holds the account owner's key.

The full developer documentation lives in `docs/` and at <https://docs.demolisher.app>. This file
is a map of the code.

## Stack

Next.js 16 (App Router, `next build` then `next start`), React 19, XState 5 for the close flow,
Stellar SDK 17, Stellar Wallets Kit 2.7, Node.js 24 and pnpm 12. The app is supported only behind a
reverse proxy; `docker-compose.yml` runs it behind Caddy.

## Request flow

```
/demolish (React)
  pageFlowMachine                        src/lib/orchestrator/page-flow-machine.ts
    discover                             src/lib/orchestrator/actors/discover.ts
      auditAccount                       Horizon
      scanAllowances, confirmAllowancesOnChain   Soroban RPC events, then allowance() reads
      DirectContractProvider             Blend, Aquarius, Soroswap positions
      discoverHeldTokens                 standalone SEP-41 balances
    preview                              src/lib/orchestrator/actors/preview.ts
      surgeFeeBase, resolveCreditPaths   fee bid, conversion quotes and reference quotes
      generatePlan                       pure plan graph
      hydratePlanTransactions            builds each Soroban step
      simulatePreviewTree                Soroban RPC simulation
      refuseUnsafeSteps                  the sign-time checks, run on every built step
      assessMergeability
    execute                              src/lib/orchestrator/actors/execute.ts
      executePlanTreeOnChain             src/lib/orchestrator/executor.ts
      submitBundle                       a collected shared-account close
```

The machine's states are `idle`, `discovering`, `previewing`, `awaiting_confirmation`, `executing`,
`succeeded`, `prepared`, `failed` and `cancelled`. `prepared` ends a run that only prepares the
close, because a Blend backstop withdrawal stays locked after it.

## Modules

| Area          | Path                    | Responsibility                                                                                                                    |
| ------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Orchestration | `src/lib/orchestrator/` | Flow machine, its actors, the executor, the failure taxonomy, the submission journal                                              |
| Audit         | `src/lib/stellar/`      | Account audit, mergeability, path finding, the classic builder, the allow-list check                                              |
| DeFi adapters | `src/lib/adapters/`     | `blend`, `aquarius`, `soroswap` (discovery and exit builders), `positions` (the provider)                                         |
| Plan          | `src/lib/plan/`         | Generator, tree, classic batcher, hydration, simulator, price impact                                                              |
| Soroban       | `src/lib/soroban/`      | RPC failover, simulation, submission, allowances, held tokens, the authorization-tree guard, revoke and transfer guards, fee caps |
| Safety        | `src/lib/safety/`       | Exchange registry and memo rules, scam heuristics, slippage, the high-value gate                                                  |
| Wallet        | `src/lib/wallet/`       | The connector over Stellar Wallets Kit, the secret-key connector, signed-envelope checks, Ledger errors, the testnet demo account |
| Mediator      | `src/lib/mediator/`     | Flow client, forward builder, envelope validator, recovery records                                                                |
| Multisig      | `src/lib/multisig/`     | Signing requests, signature merging, bundle freshness, the relay client                                                           |
| Metrics       | `src/lib/metrics/`      | The usage beacon, the event schema, the on-chain close marker                                                                     |
| Server        | `src/server/`           | Mediator secret, signing relay, rate limiter, request body caps, metrics store, close verification, startup check                 |
| Config        | `src/lib/config/`       | Networks, pinned contracts, CSP, public environment                                                                               |

## Server surface

| Route                                                                         | Purpose                                                                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/mediator/sign`                                                      | Mints a forward flow bound to a destination, network and memo                |
| `POST /api/mediator/sign`                                                     | Co-signs one forward envelope that meets the flow's terms                    |
| `POST /api/mediator/reissue`                                                  | Renews a flow token, expired or not, while its forwarding account exists     |
| `/api/plan`, `/api/plan/[id]`, `/api/plan/[id]/sign`, `/api/plan/[id]/events` | The shared-account signing relay, in process memory, with Server-Sent Events |
| `POST /api/metrics`, `GET /api/metrics`                                       | First-party usage events, and the aggregate behind a bearer token            |

`src/proxy.ts` sets the Content-Security-Policy on document responses (it skips `/api`, so the
routes' streaming body caps apply). `src/instrumentation.ts` refuses to start the server when
`TRUSTED_PROXY_HOPS` is not a whole number of at least 1.

## The plan graph

`generatePlan(audit, positions, allowances, destination, options)` in `src/lib/plan/generator.ts`
is pure; its only impurity is reading the clock for a backstop unlock estimate. It emits a directed
acyclic graph of twenty node kinds (`src/lib/plan/tree.ts`): allowance revokes, a classic unwind of
offers and pools that lock a repay asset, Blend repays, withdrawals and emission claims, the BLND
and payout trustlines, Aquarius standard and concentrated withdrawals, reward, fee and gauge
claims, Soroswap LP withdrawals, backstop emission claims, queueing and withdrawal, standalone
token conversion or transfer, the batched classic close (`FinalClassicTx`), and the exchange
forward (`MediatorForward`). Cycles are refused when the tree is built, and the executor walks it in
topological order. The classic close waits on every other node except the forward.

## The classic close

`batchClassicDemolition` in `src/lib/plan/classic-batcher.ts` is a pure function from an audit to
ordered batches, at most 100 operations each:

1. withdraw classic pool shares,
2. cancel offers,
3. claim the selected claimable balances,
4. dispose of each credit balance (to the destination or the issuer as chosen, or a path payment
   to XLM within the price-impact cap),
5. remove trustlines,
6. delete data entries,
7. the merge group: threshold reset, signer removal, the close marker (a `manageData` set and
   delete of `account-demolisher.close`), the forwarding account's funding on an exchange close,
   and the `account_merge`.

Pool withdrawals and claims of assets that are then sold run in a leading phase, and the executor
audits the account again after each phase and rebuilds the rest. The batches attached to the plan
are what the review shows; the executor re-audits, re-quotes, re-discovers DeFi positions and
re-batches before every phase.

## Checks before every signature

Every DeFi-protocol Soroban transaction passes `checkRequiredSorobanStep`
(`src/lib/orchestrator/executor.ts`) before it is signed, and the preview runs the same checks on
each built step:

- `assertTransactionAllowed` (`src/lib/stellar/allowlist.ts`): the root call targets an entry point
  on the network's compiled-in list (`src/lib/config/contracts.ts`), and no authorization entry
  creates a contract or uploads wasm.
- `assertDefiAuthTree` (`src/lib/soroban/defi-auth-guard.ts`): the authorization tree is exactly
  the one that call needs.
- `assertSorobanFeeWithinCap` (`src/lib/soroban/fee-cap.ts`): the resource fee and declared writes
  are within the step's class.

Allowance revokes and standalone-token transfers target the account owner's own token contracts
and are held to exactly `approve(user, spender, 0, ledger)` and `transfer(user, destination,
amount)` instead.
Whatever the wallet returns is checked by `verifySignedEnvelope` (`src/lib/wallet/signed-envelope.ts`):
same transaction hash, valid signature from the connected key.

## DeFi discovery

`DirectContractProvider` (`src/lib/adapters/positions/direct.ts`) runs in the browser. Blend loads
each pinned pool through the Blend SDK and reads each pool's own backstop; Aquarius combines its AMM
API with an on-chain scan of the router's events, and reads the pinned concentrated pools; Soroswap
walks the factory's pairs and probes each LP balance. A protocol that cannot be read records an
error, and the merge is refused while any error or open position remains.

## Exchange closes

For a destination in the exchange registry, or one that publishes the SEP-29 memo flag, the close
funds a forwarding account derived for that one close from `MEDIATOR_SECRET` (an HMAC master that
never signs or holds funds), merges into it, and then the browser builds a two-operation forward
(payment with the memo, then merge, both to the destination) that the server co-signs after
`validateMediatorForwardEnvelope` checks it against the flow token's terms. A recovery record in
browser storage, and token renewal through `/api/mediator/reissue`, let an interrupted forward be
finished later.

## Shared accounts

When the connected key cannot meet the close threshold, the reviewed close is built as one
transaction, signed by the initiator and published to the signing relay
(`src/server/signing-relay.ts`). Co-signers open `/sign?id=<hash>` and sign on their own device;
the relay verifies each signature over the transaction hash against the account's signers, merges
it, stops at the threshold, and streams the envelope over Server-Sent Events. The initiator's page
checks the bundle against the live account before submitting it.

## Tests

- `tests/unit`: Vitest, no network.
- `tests/integration`: live testnet closes and read-only mainnet checks.
- `tests/e2e`: Playwright against a built app.

## The docs site

`docs/` is a separate Fumadocs (Next.js) app, tracked in this repository, that builds the published
documentation.
