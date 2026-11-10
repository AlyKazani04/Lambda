# ---- build stage -------------------------------------------------------
FROM node:26-slim AS builder

RUN npm install -g pnpm@12.6.0

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/dashboard/ ./apps/dashboard/

RUN pnpm install --frozen-lockfile

RUN pnpm -r build

# ---- runtime stage -----------------------------------------------------
FROM node:26-slim AS runner

RUN npm install -g pnpm@12.6.0

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY packages/shared-types/ ./packages/shared-types/
COPY apps/dashboard/package.json ./apps/dashboard/

RUN pnpm install --frozen-lockfile --prod \
    && pnpm store prune

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
