# Account Demolisher

A tool for cleanly closing Stellar accounts. It unwinds classic entries and
Soroban DeFi positions, converts remaining balances to XLM, and merges the
account to a destination wallet or exchange — with all signing done client-side.

Live at https://demolisher.saliht.xyz/

## What it does

- **Classic closure** — cancel DEX offers, remove trustlines and data entries,
  clear extra signers + reset thresholds, optionally claim claimable balances,
  and `account_merge` to a destination.
- **Soroban DeFi** — discover and close positions on **Blend, Aquarius, Soroswap,
  and FxDAO** entirely on-chain (no third-party position API), then convert the
  proceeds to XLM.
- **Balance conversion** — non-XLM balances are converted to XLM via best-path
  routing; anything un-routable is left in place unless the user explicitly
  consents to return it to the issuer (never done silently).
- **CEX destinations** — because major exchanges reject `ACCOUNT_MERGE`, funds are
  routed through a temporary **mediator** account that forwards them, with strict
  server-side envelope validation and enforced deposit memos.
- **Multisig** — accounts requiring multiple signatures are closed by gathering
  signer keys until the account's threshold is met.
- **Allowance viewer** — inspect and revoke active SEP-41 token allowances without
  closing the account.

Safety: a dry-run plan tree with real simulations, a typed last-4-character +
timed confirmation, high-value and scam-token warnings, and a hard-coded contract
allow-list checked before every Soroban signature. See [SECURITY.md](./SECURITY.md).

## Requirements

- Node 22 (see `.nvmrc`)
- pnpm 10

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev            # http://localhost:3000
```

## Run with Docker

```bash
docker compose up --build         # http://localhost:3000
# or:
docker build -t account-demolisher .
docker run -p 3000:3000 -e MEDIATOR_SECRET=S... account-demolisher
```

Public config (`NEXT_PUBLIC_*`) is baked at build time and defaults to testnet;
server-only secrets are supplied at runtime.

## Environment variables

Server-only (never exposed to the client):

- `MEDIATOR_SECRET` — the mediator account secret (`S...`). Required only for CEX
  destinations, which use the server-side co-signing mediator.
- `SOROSWAP_API_KEY` — optional, for the swap aggregator used when converting
  non-XLM balances to XLM.

Public:

- `NEXT_PUBLIC_STELLAR_NETWORK` — `mainnet` | `testnet` | `futurenet` (default `testnet`)

Horizon / Soroban RPC endpoints are pinned per network. DeFi positions are
discovered on-chain, so no position-API key is required.

## Testing

```bash
pnpm test              # unit tests (Vitest) — pure logic, no network
pnpm test:integration  # live testnet round-trips (Horizon + Soroban RPC)
pnpm test:e2e          # Playwright (requires: pnpm exec playwright install chromium)
```

The integration suite funds real testnet accounts and closes them end-to-end
(classic close, multisig 2-of-2 close, and Soroswap discovery against the live
factory), so it needs outbound network access.

## Scripts

| Command                                       | Purpose                  |
| --------------------------------------------- | ------------------------ |
| `pnpm dev`                                    | Next.js dev server       |
| `pnpm build` / `pnpm start`                   | production build / serve |
| `pnpm typecheck`                              | `tsc --noEmit` (strict)  |
| `pnpm lint` / `pnpm format`                   | ESLint / Prettier        |
| `pnpm test` / `test:integration` / `test:e2e` | tests                    |

## Routes

- `/demolish` — main flow: connect, audit, review plan, execute.
- `/allowances` — view and revoke active SEP-41 token allowances.
- `/plan/[id]` — Refractor-linked multisig coordination status view.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — request flow, modules, closure invariants.
- [SECURITY.md](./SECURITY.md) — trust model, threat table, residual risks.

## License

Apache 2.0
