# syntax=docker/dockerfile:1
# Reproducible production build of Account Demolisher.
#   docker build -t account-demolisher .
#   docker run -p 3000:3000 -e MEDIATOR_SECRET=S... account-demolisher
# Public config (NEXT_PUBLIC_*) is build-time; defaults to testnet. Server-only
# secrets (MEDIATOR_SECRET, SOROSWAP_API_KEY) are supplied at runtime.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

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
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.ts ./
USER appuser
EXPOSE 3000
CMD ["pnpm", "start"]
