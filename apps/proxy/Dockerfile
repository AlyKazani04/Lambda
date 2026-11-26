# syntax=docker/dockerfile:1.7

# ---- base: pin the toolchain once ---------------------------------------
FROM node:26-slim AS base
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

# ---- deps: keyed on manifests only --------------------------------------
# Source files are deliberately absent here. A code edit must not invalidate
# the install layer; only a package.json or lockfile change should.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/proxy/package.json ./apps/proxy/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

# ---- builder ------------------------------------------------------------
FROM deps AS builder
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends libpcap-dev build-essential
COPY packages/config/ ./packages/config/
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/proxy/ ./apps/proxy/
RUN pnpm --filter shared-types run build && pnpm --filter proxy run build

# ---- dev: source is bind-mounted by compose.dev.yml ---------------------
FROM deps AS dev
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/proxy/ ./apps/proxy/
RUN pnpm --filter shared-types run build
USER node
WORKDIR /repo/apps/proxy
CMD ["./node_modules/.bin/tsx", "watch", "src/index.ts"]

# ---- runtime ------------------------------------------------------------
FROM base AS runner
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends libpcap0.8 iproute2
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/proxy/package.json ./apps/proxy/
# Cached until a manifest changes; a source edit never reinstalls here.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod
COPY --from=builder --chown=node:node /repo/apps/proxy/dist ./apps/proxy/dist
COPY --from=builder --chown=node:node /repo/packages/shared-types/dist ./packages/shared-types/dist
USER node
EXPOSE 8080
CMD ["node", "apps/proxy/dist/index.js"]
