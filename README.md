# Account Demolisher

A tool for cleanly closing Stellar accounts. Drains the account, unwinds any Soroban DeFi positions, and merges what's left to a destination wallet or exchange.

Supports both classic Stellar ops (offers, trustlines, data entries, signers, claimable balances) and Soroban DeFi (Blend, Aquarius, Soroswap, FxDAO).

Live at https://demolisher.saliht.xyz/

## Requirements

- Node 22 (see `.nvmrc`)
- pnpm 10

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open http://localhost:3000

## Environment variables

Required for the mediator backend (used when sending to a centralized exchange):

- `MEDIATOR_SECRET` — the mediator account's secret key (`S...`)

Optional:

- `NEXT_PUBLIC_STELLAR_NETWORK` — `mainnet` | `testnet` | `futurenet` (default `testnet`)
- `NEXT_PUBLIC_HORIZON_URL` — override Horizon endpoint
- `NEXT_PUBLIC_RPC_URL` — override Soroban RPC endpoint
- `SOROSWAP_API_KEY` — for the swap aggregator
- `ORION_API_URL`, `ORION_API_KEY` — DeFi positions provider
- `OCTOPOS_API_URL`, `OCTOPOS_API_KEY` — DeFi positions provider (fallback)

## Scripts

| Command          | Purpose              |
| ---------------- | -------------------- |
| `pnpm dev`       | Next.js dev server   |
| `pnpm build`     | Production build     |
| `pnpm start`     | Run production build |
| `pnpm typecheck` | `tsc --noEmit`       |
| `pnpm lint`      | ESLint               |
| `pnpm format`    | Prettier `--write`   |

## Routes

- `/demolish` — main flow: connect wallet, audit account, review plan, execute.
- `/allowances` — view and revoke active SEP-41 token allowances.
- `/plan/[id]` — Refractor-linked multisig coordination view.

## License

Apache 2.0
