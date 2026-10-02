FROM node:26-slim AS builder

RUN npm install -g pnpm@12.6.0

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY apps/stub/ ./apps/stub/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter stub run build

FROM node:26-slim AS runner

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/ ./packages/config/
COPY apps/stub/package.json ./apps/stub/

RUN npm install -g pnpm@12.6.0 \
    && pnpm install --frozen-lockfile --prod \
    && pnpm store prune

COPY --from=builder --chown=node:node /repo/apps/stub/dist ./apps/stub/dist

USER node

EXPOSE 3001

CMD ["node", "apps/stub/dist/index.js"]