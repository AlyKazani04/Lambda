# ---- build stage -------------------------------------------------------
# node:26-slim, NOT alpine: @audc/pcap ships a linux-x64 (glibc) prebuild and
# alpine is musl, so the binary will not load there.
FROM node:26-slim AS builder

# Node 25+ dropped Corepack from the distribution, so pnpm must be installed
# explicitly. Pinned to match packageManager in the root package.json.
RUN npm install -g pnpm@12.6.0

# @audc/pcap falls back to compiling from source when no prebuild matches the
# platform, and that needs libpcap headers + a toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpcap-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Build context is the repo root (see docker-compose.yml) because pnpm needs
# pnpm-workspace.yaml + pnpm-lock.yaml + the root package.json alongside the
# workspace packages. Copying only apps/proxy gives no lockfile, and
# `pnpm ci` requires one.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY apps/proxy/ ./apps/proxy/

# --frozen-lockfile: fail rather than silently mutate the lockfile.
RUN pnpm install --frozen-lockfile

RUN pnpm --filter proxy run build

# ---- runtime stage -----------------------------------------------------
FROM node:26-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpcap0.8 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Re-resolve production deps from the same lockfile. pnpm's symlinked
# node_modules layout cannot be copied wholesale between stages, so a second
# install is the reliable way to get a correct prod-only tree.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY apps/proxy/package.json ./apps/proxy/

RUN npm install -g pnpm@12.6.0 \
    && pnpm install --frozen-lockfile --prod \
    && pnpm store prune

COPY --from=builder --chown=node:node /repo/apps/proxy/dist ./apps/proxy/dist

# Drop root. The container still gets NET_ADMIN via cap_add in compose, which
# is a capability rather than a uid — see the notes in that file.
USER node

EXPOSE 8080

CMD ["node", "apps/proxy/dist/index.js"]
