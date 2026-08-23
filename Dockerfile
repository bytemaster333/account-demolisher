# syntax=docker/dockerfile:1
# Reproducible production build of Account Demolisher.
#   docker build -t account-demolisher .
#   docker run -p 3000:3000 -e MEDIATOR_SECRET=S... account-demolisher
# Public config (NEXT_PUBLIC_*) is build-time; defaults to testnet. Server-only
# secrets (MEDIATOR_SECRET, SOROSWAP_API_KEY) are supplied at runtime.

# base image pinned by digest (multi-arch index for node:22-slim, resolved
# 2026-08-23) so the build is reproducible and the base can't drift under the tag.
# Update the digest deliberately when bumping the base.
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable

# full dependency set (incl. devDependencies) — used only to build
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# production-only dependency set — what actually ships in the runtime image
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# non-root runtime
RUN useradd --system --uid 1001 --create-home appuser
# ship prod-only node_modules, not the build stage's devDependencies
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./
USER appuser
EXPOSE 3000
CMD ["pnpm", "start"]
