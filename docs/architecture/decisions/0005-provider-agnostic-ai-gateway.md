# 0005: Provider-agnostic AI gateway

**Status:** accepted, 2026-09-25

**Decision.** All AI features call `AiGateway.run()`. The gateway checks permissions and loads only data the requester can already see, calls an `AiProvider`, filters the output through the safety layer, and logs task, scopes and status without content. The default model is Claude (`claude-opus-5`) through the official SDK, with server-side refusal fallback enabled; a deterministic dev provider runs offline.

**Why.** The product must not depend on one vendor, and authorization must happen before any context reaches a model.

**Consequences.** Adding a provider means implementing `complete()`. AI memory is explicit and consent-gated; private conversations are never ingested unless a member asks for a summary of that conversation.
