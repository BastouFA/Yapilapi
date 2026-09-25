# YAPILAPI architecture overview

**YAPILAPI: Your social world. One place.**

```
 apps/web (Next.js)   apps/admin (Next.js, staff)   apps/mobile (Expo)
          \                    |                        /
           +----- @yapilapi/api-client (typed, shared) --+
                               |  HTTPS + WebSocket (single-use ticket)
                        apps/api  (Fastify + zod + raw SQL)
     auth | graph | content | feed | messaging | communities | media | moments
     search | discover | events | places | business | commerce | payments
     safety | privacy | notifications | admin | analytics | developer
     ai | creator | studio | live | ads | real | together | memory
                               |
   PostgreSQL 16   Redis (pub/sub, rate limits)   object storage / local disk
   (optional) OpenSearch   payment provider   AI providers   email / push
```

- Shared packages: `shared` (types, errors, constants), `config` (validated env), `database` (pool, migrations), `security`, `recommendations`, `moderation`, `search`, `payments`, `ai`, `api-client`, `design-system`, `ui`.
- Engineering contract for new modules: `module-guide.md`. Decisions: `decisions/`. Domain designs: the other files in this folder. Security notes: `docs/security/`. Operations: `docs/operations/`.
- Originality: YAPILAPI is a composition of its own concepts (For You with visible reasons, Circles, Communities with human-decided rules, Moments, REAL, REAL Together, Memory, Studio, NOW) rather than a clone of any existing network.
