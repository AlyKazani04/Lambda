# syntax=docker/dockerfile:1.7

FROM node:26-slim AS base
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/dashboard/package.json ./apps/dashboard/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY packages/config/ ./packages/config/
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/dashboard/ ./apps/dashboard/
RUN pnpm -r build

FROM base AS runner
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/dashboard/package.json ./apps/dashboard/
# Cached until a manifest changes; a source edit never reinstalls here.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod
COPY --from=builder --chown=node:node /repo/apps/dashboard/.next ./apps/dashboard/.next
COPY --from=builder --chown=node:node /repo/apps/dashboard/server.ts ./apps/dashboard/server.ts
COPY --from=builder --chown=node:node /repo/apps/dashboard/lib ./apps/dashboard/lib
COPY --from=builder --chown=node:node /repo/apps/dashboard/app ./apps/dashboard/app
COPY --from=builder --chown=node:node /repo/apps/dashboard/next-env.d.ts ./apps/dashboard/next-env.d.ts
COPY --from=builder --chown=node:node /repo/packages/shared-types/dist ./packages/shared-types/dist

USER node
EXPOSE 3000

# Run tsx directly: pnpm as the node user would try to remove the root-owned
# node_modules/.pnpm (ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR).
ENV NODE_ENV=production
CMD ["apps/dashboard/node_modules/.bin/tsx", "apps/dashboard/server.ts"]
