# syntax=docker/dockerfile:1
# reproducible production build of account demolisher.
#   docker build -t account-demolisher \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://close.example.com .
# the app is supported only behind a reverse proxy that sets X-Forwarded-For
# (docker-compose.yml ships one). server-only settings (MEDIATOR_SECRET,
# SOROSWAP_API_KEY, TRUSTED_PROXY_HOPS, METRICS_ADMIN_TOKEN, ...) are supplied at
# runtime; NEXT_PUBLIC_* settings are build args because next build inlines them.

# base image pinned by digest (multi-arch index for node:24-slim, node 24.21.0,
# resolved 2026-10-02) so the build is reproducible and the base can't drift under
# the tag. update the digest deliberately when bumping the base.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node

# pnpm is needed to install and build, never to run
FROM node AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable

# full dependency set (incl. devDependencies), used only to build
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# production-only dependency set, what actually ships in the runtime image
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
WORKDIR /app
# next build inlines NEXT_PUBLIC_* into the client bundle, so they are fixed per
# image. an arg left unset stays unset and the app's own default applies.
ARG NEXT_PUBLIC_STELLAR_NETWORK
ARG NEXT_PUBLIC_DEPLOYMENT_MODE
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SLIPPAGE_BPS
ARG NEXT_PUBLIC_MIN_MARKET_OUT_STROOPS
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# the runner starts from plain node: no corepack, no pnpm. starting through pnpm
# made pnpm 12 download itself and write a lockfile into the read-only /app at
# every container start, which fails as the non-root user.
FROM node AS runner
WORKDIR /app
ENV NODE_ENV=production
# the durable metrics store (closes ledger + counters). the only path the runtime
# user may write to; mount a volume here so it survives a container recreate.
ENV METRICS_DB_DIR=/app/data
RUN useradd --system --uid 1001 --create-home appuser \
  && mkdir -p /app/data \
  && chown appuser:appuser /app/data
# ship prod-only node_modules, not the build stage's devDependencies
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./
VOLUME /app/data
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start"]
