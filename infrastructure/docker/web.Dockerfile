# Web image. Build from the repository root:
#   docker build -f infrastructure/docker/web.Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t yapilapi-web .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4000/v1/realtime
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile --filter @yapilapi/web...
RUN pnpm --filter @yapilapi/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S ypl && adduser -S ypl -G ypl
COPY --from=build /app ./
USER ypl
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "apps/web", "--port", "3000"]
