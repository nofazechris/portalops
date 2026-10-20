# PortalOps: one image for both the API (which also serves the built web app) and the worker.
#   API:    docker run … portalops                       (default command)
#   Worker: docker run … portalops node apps/worker/main.ts
# NOTE: written without Docker available on the authoring machine; the CI workflow builds it on every push.

# ---- build the web app --------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# ---- runtime ------------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORTALOPS_STATIC_DIR=dist \
    PORTALOPS_API_HOST=0.0.0.0 \
    PORTALOPS_API_PORT=8787 \
    PORTALOPS_DB_PATH=/data/portalops.sqlite
WORKDIR /app

# production dependencies only (no vite, typescript tooling, or solc)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Node 24 runs TypeScript directly by stripping types, so the server code ships as source.
COPY apps ./apps
COPY packages ./packages
COPY scripts/backup-db.mjs scripts/start-all.mjs scripts/db-check.mjs ./scripts/
COPY --from=build /app/dist ./dist

# SQLite lives on a volume; the app never needs to write anywhere else.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORTALOPS_API_PORT||8787)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "apps/api/main.ts"]
