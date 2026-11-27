# syntax=docker/dockerfile:1.7

FROM node:26-slim AS base
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

# Only manifests here: a source edit must leave the install layer cached.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/stub/package.json ./apps/stub/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY packages/config/ ./packages/config/
COPY apps/stub/ ./apps/stub/
RUN pnpm --filter stub run build

FROM deps AS dev
COPY packages/config/ ./packages/config/
COPY apps/stub/ ./apps/stub/
USER node
WORKDIR /repo/apps/stub
CMD ["./node_modules/.bin/tsx", "watch", "src/index.ts"]

FROM base AS runner
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/stub/package.json ./apps/stub/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod
COPY --from=builder --chown=node:node /repo/apps/stub/dist ./apps/stub/dist
USER node
EXPOSE 3001
CMD ["node", "apps/stub/dist/index.js"]
