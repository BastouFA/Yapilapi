# YAPILAPI admin console (Next.js). Build from the repository root: docker build -f infrastructure/docker/admin.Dockerfile -t yapilapi-admin .
# This is @yapilapi/web's Dockerfile with APP's default pinned to "admin" instead of passed via --build-arg,
# because some hosts (Render Blueprints among them) build Docker images without a way to pass --build-arg.
# NEXT_PUBLIC_API_URL is deliberately NOT needed at build time: apps/admin/src/lib/env.ts reads it through a
# computed process.env[key] lookup specifically so Next.js can't inline it into the client bundle, and the
# server reads it fresh at request time. Pass it as a normal runtime env var; one image runs against any API.
FROM node:25-bookworm-slim AS build
ARG APP=admin
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY . .
RUN npm ci && npm run build -w @yapilapi/$APP

FROM node:25-bookworm-slim
ARG APP=admin
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP=$APP
WORKDIR /repo
COPY --from=build /repo /repo
RUN npm prune --omit=dev && useradd --system --uid 10001 yapilapi
USER yapilapi
EXPOSE 3100
CMD ["sh", "-c", "npm run start -w @yapilapi/$APP"]
