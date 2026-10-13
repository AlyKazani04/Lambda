# ---- build stage -------------------------------------------------------
FROM node:26-slim AS builder

RUN npm install -g pnpm@12.6.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpcap-dev build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY apps/proxy/ ./apps/proxy/

# --frozen-lockfile: fail rather than silently mutate the lockfile.
RUN pnpm install --frozen-lockfile

RUN pnpm --filter proxy run build

# ---- runtime stage -----------------------------------------------------
FROM node:26-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends libpcap0.8 iproute2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Re-resolve production deps from the same lockfile
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY apps/proxy/package.json ./apps/proxy/

RUN npm install -g pnpm@12.6.0 \
    && pnpm install --frozen-lockfile --prod \
    && pnpm store prune

COPY --from=builder --chown=node:node /repo/apps/proxy/dist ./apps/proxy/dist

# Drop root
USER node

EXPOSE 8080

CMD ["node", "apps/proxy/dist/index.js"]
