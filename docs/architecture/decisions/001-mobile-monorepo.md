# ADR 001: the mobile app lives in the repo but outside the npm workspaces

Status: accepted
Scope: `apps/mobile`

## Context

The repo is an npm-workspaces monorepo (`apps/api`, `apps/web`, `apps/admin`, `packages/*`) with one hoisted `node_modules` and one lockfile. The mobile app is Expo / React Native and must share code with the rest:

- `@yapilapi/api-client` (typed API client, error model, realtime event types)
- `@yapilapi/design-system` (design tokens)

React Native has strict, version-locked peer requirements (one `react`, one `react-native`, native modules pinned per Expo SDK) and Metro resolves modules differently from Vite and Node. Web and admin run a different React than the mobile app needs.

## Options considered

1. **Add `apps/mobile` to root `workspaces`.** One install, but the hoisted tree then holds two incompatible `react` / `react-dom` / `react-native` sets. npm hoisting picks one, the other app breaks in ways that are hard to see (duplicate React, wrong native module versions, Metro finding web-only copies). Every mobile dependency bump would also change the lockfile that web, admin and the API depend on.
2. **Separate repository, published packages.** Clean isolation, but api-client and the tokens would need publishing and versioning, and mobile could drift from the API contract silently.
3. **Same repo, own install, shared code consumed from source (chosen).**

## Decision

- `apps/mobile` is **not** listed in root `workspaces`. It has its own `package.json`, its own `package-lock.json` and its own `node_modules`. `npm install` at the root never touches it, and installing mobile never changes the root lockfile.
- Shared packages are consumed **from source**:
  - `tsconfig.json` `paths` map `@yapilapi/api-client` and `@yapilapi/design-system` to `../../packages/*/src`, so `tsc` and Jest see the real files and stay in sync with the API contract.
  - `metro.config.js` adds the two package folders to `watchFolders`, sets `nodeModulesPaths` to the app's own `node_modules` only and disables hierarchical lookup. Nothing can resolve a React copy from the hoisted root.
  - Jest uses the same mapping (`moduleNameMapper` / `jest-expo` transform of the shared sources).
- Both shared packages must therefore stay **dependency-free at runtime and platform-neutral** (no DOM, no Node built-ins). The api-client already is; keep it that way. If a shared package ever needs a dependency, mobile must be able to resolve it from its own `node_modules`.
- Design tokens are CSS in `packages/design-system/src/tokens.css`. React Native cannot read CSS, so `apps/mobile/scripts/sync-tokens.mts` generates `src/theme/tokens.generated.ts` from it. `npm run tokens:check` (and a Jest test) fail if the generated file is stale, so the two cannot drift.
- Root scripts delegate: `npm run mobile:start`, `mobile:test`, `mobile:typecheck` run `npm --prefix apps/mobile run ...`. They are deliberately **not** part of root `test` / `typecheck` / `build` (those iterate workspaces or run Vitest), so CI for the API, web and admin does not need the mobile toolchain. Mobile CI is its own job: `npm ci --prefix apps/mobile`, then typecheck and test.

## Consequences

Good:

- No React version conflicts; web, admin and API installs are unchanged.
- The mobile app always builds against the current API client and tokens; a breaking client change fails mobile typecheck.
- No package publishing.

Costs and rules:

- Two installs to keep current (root and `apps/mobile`); Dependabot / Renovate must be pointed at `apps/mobile` separately.
- Root `npm run typecheck`, `lint` and `test` do **not** cover the mobile app. Run `npm run mobile:typecheck` and `npm run mobile:test` too. The root ESLint config ignores `apps/mobile` (it would apply the web rules); a mobile-specific ESLint config is not set up yet. Root Vitest does not collect mobile tests either (they are Jest tests under `apps/mobile/__tests__`).
- Editing a shared package while Metro runs works (it is in `watchFolders`); TypeScript path aliases do not change how the shared code is bundled, so shared code must not rely on root-only tooling (Vite env variables, `import.meta`).
- The mobile-only endpoints the app calls (discover, search, notifications and push tokens, media, privacy export) are wrapped in `apps/mobile/src/api` because the shared client does not cover them yet. A test checks that each such path exists in `docs/api/openapi.json`. Moving them into `@yapilapi/api-client` later is the intended cleanup and needs no architecture change.

## Revisit when

- The mobile app moves to a stable Expo SDK line the rest of the repo can also live with (unlikely for web), or
- Mobile CI time makes a shared install attractive, or
- A third native app appears: then a second, mobile-only workspace root (`apps/mobile/*`) is the next step, not merging into the main one.
