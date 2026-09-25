# ADR 009: AI as a permissioned gateway with provider abstraction; humans confirm

Status: accepted. Scope: `packages/ai`, `apps/api/src/modules/ai`

## Decision

Pipeline: Gateway -> Safety (request) -> Permission Engine (deny by default, as the requesting user) -> Context Engine (permitted, bounded, provenance-tagged content) -> Model Router (fallback chain, per-provider circuit breaker, budgets) -> Tool System (typed, audited, draft-only) -> Safety (output).

- Providers (dev, Anthropic, OpenAI) sit behind one interface; the router picks per task. The dev provider is deterministic and is what tests and the 79-case eval harness use.
- AI output that would change something (posts, events, listings) is stored as a draft artifact; a human must confirm. Nothing is published automatically.
- Memory is opt-in, visible, editable, deletable and audited; direct messages are never ingested without consent and an explicit attachment. Secrets, card numbers and national ids are redacted before anything is stored.
- Community and business assistants are grounded in human-written material and cannot invent decisions.

## Not done

The Anthropic/OpenAI adapters are unit-tested against fake HTTP only; no live-provider calls were made. No speech provider is configured.
