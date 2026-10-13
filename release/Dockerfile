# syntax=docker/dockerfile:1
# runs a release artifact from .github/workflows/release.yml instead of building
# from source. the artifact is the built app (.next, public, package.json,
# next.config.ts, the lockfile) carrying a signed slsa provenance attestation,
# so the code this image serves is the code that workflow built from the tagged
# commit. scripts/deploy-release.sh verifies the attestation, copies the
# artifact next to this file and passes its sha256 in, and the build refuses
# any other file under that name.
#
# NEXT_PUBLIC_* settings are baked into the artifact when release.yml builds it,
# so there are no build args for them here. runtime settings are the same as the
# source image (see docker-compose.yml).

# same pinned base as the root Dockerfile; bump both together
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node

FROM node AS unpack
ARG ARTIFACT
ARG ARTIFACT_SHA256
WORKDIR /artifact
COPY ${ARTIFACT} /tmp/artifact.tar.gz
RUN test -n "$ARTIFACT_SHA256" \
  && echo "$ARTIFACT_SHA256  /tmp/artifact.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/artifact.tar.gz -C /artifact

# production dependencies from the artifact's own lockfile; pnpm is needed to
# install, never to run
FROM node AS prod-deps
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app
COPY --from=unpack /artifact/package.json /artifact/pnpm-lock.yaml /artifact/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# the runner matches the root Dockerfile's: plain node, a non-root user, and
# /app/data as the only writable directory
FROM node AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV METRICS_DB_DIR=/app/data
RUN useradd --system --uid 1001 --create-home appuser \
  && mkdir -p /app/data \
  && chown appuser:appuser /app/data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=unpack /artifact/.next ./.next
COPY --from=unpack /artifact/public ./public
COPY --from=unpack /artifact/package.json /artifact/next.config.ts ./
VOLUME /app/data
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "node_modules/next/dist/bin/next", "start"]
