# Web app (or admin, via --build-arg). Build from the repository root:
#   docker build -f infrastructure/docker/web.Dockerfile --build-arg APP=web   -t yapilapi-web .
#   docker build -f infrastructure/docker/web.Dockerfile --build-arg APP=admin -t yapilapi-admin .
# On a host that can't pass --build-arg (Render Blueprints among them), use this file for @yapilapi/web (its
# APP default) and infrastructure/docker/admin.Dockerfile — the same file with the default pinned to "admin" —
# for @yapilapi/admin.
# NEXT_PUBLIC_API_URL does NOT need to be set at build time despite the ARG below: apps/web/src/lib/env.ts reads
# it through a computed process.env[key] lookup specifically so Next.js can't inline it into the client bundle,
# and the server reads it fresh at request time. Pass it as a normal runtime env var; one image runs against any
# API. The ARG/ENV pair here only exists for callers that still prefer to bake a default in at build time.
FROM node:25-bookworm-slim AS build
ARG APP=web
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY . .
RUN npm ci && npm run build -w @yapilapi/$APP

FROM node:25-bookworm-slim
ARG APP=web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP=$APP
WORKDIR /repo
COPY --from=build /repo /repo
RUN npm prune --omit=dev && useradd --system --uid 10001 yapilapi
USER yapilapi
EXPOSE 3000 3100
CMD ["sh", "-c", "npm run start -w @yapilapi/$APP"]
