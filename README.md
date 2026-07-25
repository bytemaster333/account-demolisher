# Account Demolisher

A tool for cleanly closing Stellar accounts. It unwinds classic entries and
Soroban DeFi positions, converts remaining balances to XLM, and merges the
account to a destination wallet or exchange. All signing is done client-side.

Live at https://demolisher.app/

## What it does

- **Classic closure.** Cancel DEX offers, remove trustlines and data entries,
  clear extra signers and reset thresholds, optionally claim claimable balances,
  and `account_merge` to a destination.
- **Soroban DeFi.** Discover and close positions on **Blend, Aquarius, Soroswap,
  and FxDAO** client-side against the live network (Blend, Soroswap, and FxDAO read
  directly on chain; Aquarius via its AMM API with an on-chain fallback), with no
  server-side positions proxy, then convert the proceeds to XLM.
- **Balance conversion.** Non-XLM balances are converted to XLM via best-path
  routing. Anything un-routable is left in place unless the user explicitly
  consents to return it to the issuer (never done silently).
- **CEX destinations.** Because major exchanges reject `ACCOUNT_MERGE`, funds are
  routed through a temporary **mediator** account that forwards them, with strict
  server-side envelope validation and enforced deposit memos.
- **Multisig.** Accounts that need more than one signature are closed by
  collecting signatures until the account's high threshold is met. You can sign
  locally by pasting several signer keys in one session, or coordinate across
  people by sharing a signing link that a built-in relay merges signatures
  through. There is no third-party signature service.
- **Allowance viewer.** Inspect and revoke active SEP-41 token allowances without
  closing the account. It accepts both `G...` account and `C...` contract
  addresses.

Safety: a dry-run plan tree with real simulations, a typed last-four-character
plus timed confirmation, high-value and scam-token warnings, and a hard-coded
contract allow-list checked before every Soroban signature. See the
[security overview](https://docs.demolisher.app/docs/security).

## Requirements

- Node 22 (see `.nvmrc`)
- pnpm 10

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev            # http://localhost:3000
```

The network defaults to testnet. Once the app is running, the top navigation bar
has a runtime switcher between testnet and mainnet; your choice persists in the
browser.

## Run with Docker

```bash
docker compose up --build         # http://localhost:3000
# or:
docker build -t account-demolisher .
docker run -p 3000:3000 -e MEDIATOR_SECRET=S... account-demolisher
```

Public config (`NEXT_PUBLIC_*`) is baked at build time and defaults to testnet.
Server-only secrets are supplied at runtime.

## Environment variables

Server-only (never exposed to the client):

- `MEDIATOR_SECRET`: a Stellar seed (`S...`). It is not a funded, standing
  account: it is used only as a master key to derive a fresh, throwaway mediator
  keypair for each closure. Required only for CEX destinations, which use the
  server-side signing mediator (`reference` deployment mode).
- `MEDIATOR_ALLOWED_ORIGIN`: comma-separated CORS origins allowed to call the
  mediator endpoint from another origin. Unset means same-origin only.
- `TRUSTED_PROXY_HOPS`: reverse-proxy hops in front of the app, used to read the
  real client IP for rate limiting. `0` when directly exposed. Defaults to `1`.
- `SOROSWAP_API_URL` / `SOROSWAP_API_KEY`: the swap aggregator used when
  converting non-XLM balances to XLM. The URL defaults to
  `https://api.soroswap.finance`; the key is optional and kept server-side.

Public:

- `NEXT_PUBLIC_STELLAR_NETWORK`: `mainnet` | `testnet` | `futurenet` (default
  `testnet`). This is only the starting network; users switch between testnet and
  mainnet at runtime in the UI.
- `NEXT_PUBLIC_DEPLOYMENT_MODE`: `reference` | `self-hosted` (default
  `reference`). In `self-hosted` mode the mediator is not run, so a close routed
  to a known exchange is refused early.

Horizon and Soroban RPC endpoints are pinned per network (edit
`src/lib/config/networks.ts` to change them). DeFi positions are discovered
client-side and need no position-API key.

## Testing

```bash
pnpm test              # unit tests (Vitest): pure logic, no network
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

- `/demolish`: the main flow (connect, audit, review the plan, execute). Multisig
  accounts coordinate signature collection inside this flow.
- `/allowances`: view and revoke active SEP-41 token allowances.
- `/sign?id=<tx-hash>`: the signing link a multisig co-signer opens to review and
  sign a pending closure. Progress streams live over Server-Sent Events.

## Documentation

Full documentation is at <https://docs.demolisher.app>:

- [How it works](https://docs.demolisher.app/docs/how-it-works): the audit, the plan graph, the simulator, and the executor.
- [Security](https://docs.demolisher.app/docs/security): trust model, threat model, and the contract allow-list.
- [Self host](https://docs.demolisher.app/docs/self-host): running it on your own infrastructure.

## License

Apache 2.0
