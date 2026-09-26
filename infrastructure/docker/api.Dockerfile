# API image. Build from the repository root:
#   docker build -f infrastructure/docker/api.Dockerfile -t yapilapi-api .
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/auth/package.json packages/auth/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @yapilapi/api...

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production MIGRATE_ON_START=true
# System ffmpeg: the bundled Linux build has no drawtext (editor text, shared-reel watermark).
RUN apk add --no-cache ffmpeg
ENV FFMPEG_PATH=/usr/bin/ffmpeg
RUN addgroup -S ypl && adduser -S ypl -G ypl
COPY --from=deps /app ./
COPY packages/shared packages/shared
COPY packages/auth packages/auth
COPY packages/database packages/database
COPY apps/api apps/api
WORKDIR /app/apps/api
USER ypl
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "--import", "tsx", "src/server.ts"]
