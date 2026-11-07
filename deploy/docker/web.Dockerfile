# syntax=docker/dockerfile:1.7
# Generic image for the Node frontends (storefront / admin / console) living in apps/<APP>.
# Assumptions (adjust when the apps land): the workspace has `npm run build` and `npm start`,
# and `npm start` listens on $PORT (3000). Next.js, Remix, Nuxt and plain Express all fit.
ARG NODE_VERSION=22
ARG APP

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG APP
ENV NODE_ENV=development NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/${APP}/package.json apps/${APP}/package.json
RUN npm ci --no-audit
COPY apps/${APP} apps/${APP}
RUN npm run build -w apps/${APP} \
 && npm prune --omit=dev --no-audit

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production PORT=3000 APP_NAME=${APP}
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/${APP} ./apps/${APP}
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "npm start -w apps/${APP_NAME}"]
