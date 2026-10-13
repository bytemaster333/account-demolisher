# syntax=docker/dockerfile:1
# production build of the documentation site, served behind the same caddy
# proxy as the app (docker-compose.hosted.yml). the build context is docs/.
#   docker build -t account-demolisher-docs docs

# same pinned base as the app image (see the Dockerfile at the repo root)
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node

FROM node AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /docs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS prod-deps
WORKDIR /docs
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
WORKDIR /docs
COPY --from=deps /docs/node_modules ./node_modules
COPY . .
RUN pnpm build

# started with plain node for the same reason as the app: pnpm would try to
# download itself into the read-only image at every start
FROM node AS runner
WORKDIR /docs
ENV NODE_ENV=production PORT=3020
RUN useradd --system --uid 1001 appuser
COPY --from=prod-deps /docs/node_modules ./node_modules
COPY --from=build /docs/.next ./.next
COPY package.json next.config.mjs ./
USER appuser
EXPOSE 3020
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3020/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start"]
