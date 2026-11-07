# syntax=docker/dockerfile:1.7
# BMStore API image. Two targets:
#   runtime  – slim production image (node dist/main.js), no dev deps, runs as "node"
#   migrate  – same code + dev deps (prisma CLI, ts-node) for `prisma migrate deploy` and seed scripts
# Build context is the repo root (see deploy/docker-compose.prod.yml).
ARG NODE_VERSION=22

# ----------------------------------------------------------------------------- base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
# openssl: Prisma engines; dumb-init: proper PID 1 signal handling
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ----------------------------------------------------------------------------- build (all deps)
FROM base AS build
ENV NODE_ENV=development
# Toolchain only as a fallback for native modules without a prebuilt binary (argon2 ships prebuilds).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --no-audit
COPY apps/api apps/api
# "build" = prisma generate + tsc -p tsconfig.build.json  -> apps/api/dist
RUN npm run build -w apps/api

# ----------------------------------------------------------------------------- migrate / tools
FROM build AS migrate
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/api
ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "prisma", "migrate", "deploy"]

# ----------------------------------------------------------------------------- prod deps only
FROM base AS prod-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev --no-audit --ignore-scripts \
 && npm rebuild argon2 \
 && npm cache clean --force
# Generated Prisma client (+ query engine for this platform) comes from the build stage.
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client /app/node_modules/@prisma/client

# ----------------------------------------------------------------------------- runtime
FROM base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma/schema.prisma ./apps/api/prisma/schema.prisma
USER node
WORKDIR /app/apps/api
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
