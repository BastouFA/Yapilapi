# Web image. Build from the repository root:
#   docker build -f infrastructure/docker/web.Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t yapilapi-web .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4000/v1/realtime
# Public origin of the site (e.g. https://yapilapi.com), used in link previews. Empty: taken from each request.
ARG SITE_URL=
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL SITE_URL=$SITE_URL NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile --filter @yapilapi/web...
RUN pnpm --filter @yapilapi/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S ypl && adduser -S ypl -G ypl
COPY --from=build /app ./
WORKDIR /app/apps/web
USER ypl
EXPOSE 3000
# Next is installed in the web app's own node_modules (pnpm); PORT is honoured when a host sets it.
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start --port ${PORT:-3000}"]
