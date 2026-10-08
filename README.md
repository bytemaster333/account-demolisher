# Account Demolisher

Account Demolisher closes a Stellar account from start to finish. It reads the account, unwinds
its classic entries and Soroban DeFi positions, sells what has a market for XLM, and merges the
account into a wallet or an exchange you choose. Your browser builds every transaction and your
own wallet or key signs it.

Live at https://demolisher.app/ (testnet and mainnet). An independent external audit has not been
performed yet, and the app asks you to acknowledge that before it operates on mainnet.

## What it does

- **Classic close.** Cancels DEX offers, withdraws classic liquidity-pool shares, claims the
  claimable balances the account can claim, sells or returns credit balances, removes trustlines
  and data entries, clears extra signers and thresholds, and merges the account. The classic
  close runs in one transaction, or in a few for a large account or one with pool shares.
- **Soroban DeFi.** Discovers and exits positions in the browser, against the network directly:
  Blend (repay, withdraw, emissions, the backstop queue and its withdrawal after the unlock),
  Aquarius (rewards, gauge rewards, pool shares, concentrated ranges) and Soroswap (LP positions).
  Aquarius positions come from its AMM API and an on-chain event scan, combined. A position that
  cannot be read blocks the merge instead of being merged around. FxDAO is no longer supported,
  because the protocol shut down on chain.
- **Conversions.** Credit balances are sold for XLM through classic path payments, and standalone
  SEP-41 tokens through the pinned Soroswap router, each with a minimum output (1% slippage by
  default). A sale more than 2% worse than a small reference trade, or worse than the quote you
  reviewed, is never made without your decision per token.
- **Exchange destinations.** Exchanges credit payments with a memo, not merges. For a destination
  in the built-in registry, or one that publishes the SEP-29 memo flag, the close routes through a
  temporary forwarding account: your account merges into it, and it pays the exchange with your
  memo. The server co-signs only a forward to the committed destination, memo and network.
- **Shared accounts.** When your key cannot meet the threshold, the app publishes the reviewed
  close to a built-in signing relay and gives you a link for the other signers. No secret key is
  shared.
- **Allowance viewer.** Lists and revokes SEP-41 token allowances for a `G...` account or a
  `C...` contract, without closing anything.

Before anything is signed: a simulated plan you review step by step, a typed confirmation of the
destination with a short timer, high-value and scam-token warnings, and, for every DeFi step, a
compiled-in contract allow-list, an exact authorization-tree check and a fee cap. The wallet's
signed envelope has to be the transaction the app built. See the
[security model](https://docs.demolisher.app/docs/developers/security/model).

## Requirements

- Node.js 24 (`.nvmrc` pins 24.21.0)
- pnpm 12 (`packageManager` pins 12.8.1)

## Local development

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev            # http://localhost:3000
```

The network starts on testnet. The header switches between testnet and mainnet at runtime, and the
choice persists in the browser.

## Run with Docker

The app is supported only behind a reverse proxy. `docker-compose.yml` runs it behind Caddy:

```bash
docker compose up --build -d        # http://localhost (set SITE_ADDRESS for HTTPS on your domain)
```

Caddy is the only published service. The app's `NEXT_PUBLIC_*` settings are build arguments
(rebuild after changing them), and its server settings are passed at runtime. Compose builds in
`self-hosted` mode by default, which leaves exchange closes off until you set
`NEXT_PUBLIC_DEPLOYMENT_MODE=reference` and `MEDIATOR_SECRET`. See
[Self-hosting](https://docs.demolisher.app/docs/developers/operations/self-hosting).

## Environment variables

Every variable is documented in `.env.example` and in
[Configuration](https://docs.demolisher.app/docs/developers/reference/configuration).

Server-only:

- `MEDIATOR_SECRET`: a Stellar seed (`S...`) used only as the HMAC master that derives a
  throwaway forwarding key for each exchange close. It is never an account; do not fund it.
  Needed only in `reference` mode.
- `MEDIATOR_ALLOWED_ORIGIN`: comma-separated origins allowed to call the mediator routes
  cross-origin. Unset means same-origin only.
- `TRUSTED_PROXY_HOPS`: how many reverse proxies in front of the app append to `X-Forwarded-For`,
  for per-client rate limiting. A whole number of at least 1: `1` (the default) for the shipped
  Caddy proxy, more when a CDN or another proxy sits in front of it. The server refuses to start
  on `0` or a non-integer (`src/instrumentation.ts`).
- `METRICS_ADMIN_TOKEN`: the bearer token for reading `GET /api/metrics` (at least 16
  characters).
- `METRICS_DB_DIR`: the writable directory for the metrics store. Defaults to `data/` under the
  working directory; the Docker image uses `/app/data`.
- `SOROSWAP_API_URL` / `SOROSWAP_API_KEY`: the Soroswap aggregator behind the `/api/soroswap`
  proxy. No code in the app calls that proxy: closes convert through the Soroswap router on chain.

Public (inlined at build time):

- `NEXT_PUBLIC_STELLAR_NETWORK`: `mainnet` or `testnet` (default `testnet`), the starting network.
- `NEXT_PUBLIC_DEPLOYMENT_MODE`: `reference` (default) runs the exchange mediator;
  `self-hosted` refuses closes that need it.
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`: adds WalletConnect to the wallet picker when set.
- `NEXT_PUBLIC_SITE_URL`: the canonical origin for metadata, the sitemap and `robots.txt`.
- `NEXT_PUBLIC_SLIPPAGE_BPS`: slippage tolerance, 10 to 500 basis points (default 100). A bad
  value fails the build.
- `NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS`: a floor for a conversion's XLM output (default 0). A bad
  value fails the build.

Horizon and Soroban RPC endpoints are pinned per network in `src/lib/config/networks.ts`.

## Routes

Pages:

- `/demolish`: the close: connect, configure, review the plan, confirm, execute. Shared accounts
  collect signatures inside this flow.
- `/allowances`: view and revoke SEP-41 token allowances.
- `/sign?id=<tx-hash>`: the link a co-signer opens to review and sign a shared-account close.

API:

- `GET`, `POST /api/mediator/sign` and `POST /api/mediator/reissue`: mint an exchange-forward flow,
  co-sign its forward, and renew its token.
- `POST /api/plan`, `GET /api/plan/[id]`, `POST /api/plan/[id]/sign`, `GET /api/plan/[id]/events`:
  the shared-account signing relay, with live updates over Server-Sent Events.
- `POST /api/metrics`, `GET /api/metrics`: first-party usage events and the aggregate behind a
  bearer token.
- `POST /api/soroswap`: a same-origin proxy to the Soroswap aggregator.

## Testing

```bash
pnpm test              # unit tests (Vitest)
pnpm test:integration  # live testnet and read-only mainnet checks
pnpm test:e2e          # Playwright (pnpm exec playwright install chromium first)
```

The integration suite funds real testnet accounts and closes them, and reads mainnet state
read-only, so it needs outbound network access.

## Scripts

| Command                                       | Purpose                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `pnpm dev`                                    | Next.js dev server                                          |
| `pnpm build` / `pnpm start`                   | Production build and server                                 |
| `pnpm typecheck`                              | `tsc --noEmit`                                              |
| `pnpm lint` / `pnpm format`                   | ESLint and Prettier                                         |
| `pnpm test` / `test:integration` / `test:e2e` | Tests                                                       |
| `pnpm mediator:legacy-forward`                | Operator tool to finish a forward saved by an earlier build |

## Documentation

Full documentation is at <https://docs.demolisher.app>, built from the `docs/` folder:

- [How a close works](https://docs.demolisher.app/docs/developers/concepts/closure-lifecycle)
- [Security model](https://docs.demolisher.app/docs/developers/security/model) and
  [audit status](https://docs.demolisher.app/docs/developers/security/audit)
- [Self-hosting](https://docs.demolisher.app/docs/developers/operations/self-hosting)

[SECURITY.md](SECURITY.md) covers reporting a vulnerability, and
[ARCHITECTURE.md](ARCHITECTURE.md) gives a map of the code.

## License

Apache 2.0
