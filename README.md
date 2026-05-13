# account demolisher

a tool for cleanly closing stellar accounts. drains the account, unwinds any soroban defi positions, and merges what's left to a destination wallet or exchange.

supports both classic stellar ops (offers, trustlines, data entries, signers, claimable balances) and soroban defi (blend, aquarius, soroswap, fxdao).

## requirements

- node 22 (see `.nvmrc`)
- pnpm 10

## setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

open http://localhost:3000

## env vars

required for the mediator backend (used when sending to a cex):

- `MEDIATOR_SECRET` — the mediator account's secret key (`S...`)

optional:

- `NEXT_PUBLIC_STELLAR_NETWORK` — `mainnet` | `testnet` | `futurenet` (default `testnet`)
- `NEXT_PUBLIC_HORIZON_URL` — override horizon endpoint
- `NEXT_PUBLIC_RPC_URL` — override soroban rpc endpoint
- `SOROSWAP_API_KEY` — for the swap aggregator
- `ORION_API_URL`, `ORION_API_KEY` — defi positions provider
- `OCTOPOS_API_URL`, `OCTOPOS_API_KEY` — defi positions provider (fallback)

## scripts

| command          | purpose              |
| ---------------- | -------------------- |
| `pnpm dev`       | next.js dev server   |
| `pnpm build`     | production build     |
| `pnpm start`     | run production build |
| `pnpm typecheck` | tsc --noEmit         |
| `pnpm lint`      | eslint               |
| `pnpm format`    | prettier --write     |

## routes

- `/demolish` — main flow: connect wallet, audit account, review plan, execute
- `/allowances` — view and revoke active sep-41 token allowances
- `/plan/[id]` — refractor-linked multisig coordination view

## license

apache-2.0
