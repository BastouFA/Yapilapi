# YAPILAPI API. Build from the repository root:  docker build -f infrastructure/docker/api.Dockerfile -t yapilapi-api .
# The API runs TypeScript directly with tsx (see docs/architecture/decisions/003-typescript-source-packages.md).
# tsx is a real *dependency* of @yapilapi/api (not just a root devDependency) precisely so `npm ci --omit=dev
# --workspace @yapilapi/api` below installs it: a separate `npm install tsx` in the runtime stage was tried
# before and silently produced an empty install (npm's workspace reconciliation pruned it as "not declared by
# any package.json" the moment --no-save was used), so don't reintroduce that pattern.
FROM node:25-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY packages packages
RUN npm ci --omit=dev --workspace @yapilapi/api --include-workspace-root=false

FROM node:25-bookworm-slim
ENV NODE_ENV=production
# ffmpeg powers the media transcoding and slideshow features; the API degrades (503 processing_unavailable) without it.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
COPY scripts scripts
RUN useradd --system --uid 10001 yapilapi && mkdir -p /repo/storage && chown -R yapilapi /repo/storage
USER yapilapi
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
