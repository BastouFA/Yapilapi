# ADR 003: internal packages ship TypeScript source; the API runs with tsx

Status: accepted. Scope: `packages/*`, `apps/api`

## Decision

Workspace packages (`@yapilapi/shared`, `security`, `payments`, `ai`, `search`, ...) export `.ts` source directly. Node runs it through `tsx`; Next.js transpiles the ones it imports; mobile maps them via `tsconfig` paths (ADR 001). `npm run build` for the API is a strict typecheck (`tsc --noEmit`).

## Why

No build graph to keep in sync, instant edit-run loops, one TypeScript configuration, identical code in tests and production.

## Trade-offs

Cold start is slightly slower than plain JavaScript and the production image carries `tsx`. If start-up time or image size become a problem, add a `tsc`/`esbuild` emit step to the API Dockerfile; no source change is needed.
