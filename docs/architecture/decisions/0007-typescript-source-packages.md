# 0007: Workspace packages ship TypeScript source

**Status:** accepted, 2026-09-25

**Decision.** Internal packages export `.ts` source. The API runs with `tsx`; Next.js compiles them via `transpilePackages`.

**Why.** No build step between packages, instant type feedback, one source of truth for types.

**Consequences.** Production images include `tsx`. If startup time matters, add a bundling step for the API image later.
