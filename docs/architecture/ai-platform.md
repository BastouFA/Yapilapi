# AI platform

Scope: `packages/ai` (`@yapilapi/ai`, pure and portable), `apps/api/src/modules/ai`, migration `210_ai_platform.sql`, `tests/ai-evals`.
Tests: `packages/ai/src/**/*.test.ts` (unit, 139), `apps/api/test/ai.test.ts` (integration on real Postgres, 69), `npm run test:ai-evals` (79 cases).
Security model: [docs/security/ai.md](../security/ai.md).

## Principles

1. **The AI is the user, not a superuser.** Every read the AI does goes through the same visibility and authorisation code the API uses
   (`postVisibleSql`, `loadVisiblePost`, `eventVisibleSql`, messaging `loadAccess`/`listMessages`/`loadMessageForViewer`, `listCommunityKnowledge`,
   `getAuthorizedBusinessKnowledge`, `hasConsent`). There is no second copy of a privacy rule.
2. **Deny by default.** A tool runs only if the agent lists it, the scope matches, the agent holds the permission, the arguments validate, the user is old
   enough, and any required consent exists. Every attempt, allowed or denied, is written to `ai_tool_calls`.
3. **The AI never publishes, sends, buys or deletes on its own.** No tool has a mutating effect (`TOOL_SPECS[..].effect` is `read` or `draft`, asserted in a
   unit test and in the eval suite). Tools create **drafts** (`ai_artifacts`); a human confirms through a separate endpoint.
4. **Honest labelling.** Answers from the offline responder carry `provider: "dev"` and a `notice`; sources list what was used, including memories.
5. **Layers are separable.** Each layer below is its own module with its own tests.

## Layers

```
POST /v1/ai/chat
  Gateway          gateway.ts          validate, agent + scope, conversation, orchestrate; buffer-then-stream SSE
  Safety (input)   safety-layer.ts     screenRequest: self-harm -> support, disallowed categories, teen rules, prompt extraction
  Permission Eng.  permissions.ts      PermissionEngine (tool policy, consent, posts, comments, DMs, events, knowledge, memory)
  Context Engine   memory.ts, grounded.ts, tools/*, packages/ai/context.ts
                                       bounded, provenance-tagged, permitted sources only; untrusted text neutralised + wrapped
  Model Router     packages/ai/router.ts + usage.ts    per-task routes, fallback chain, circuit breaker, budgets, metrics
  Tool System      tools/*, packages/ai/tools.ts       typed zod contracts, executor, audit, draft-only handlers
  Safety (output)  safety-layer.ts     screenOutput: secrets/PII, canary + prompt leak, exfil links/images, moderation, self-harm
  Response         gateway.ts          message, sources, toolCalls, artifacts, memorySuggestions, safety record, provider label
```

### Model Router (`packages/ai/src/router.ts`, `apps/api/.../usage.ts`)

- `ModelProvider { name, isDev, model, supports(task), chat(), embed?() }`. Tasks: `chat`, `summarise`, `translate`, `classify`, `embed`.
- `ProviderRegistry` holds providers; `ModelRouter` maps a task to an ordered chain (`setRoute(task, chain)`), with a per-provider **circuit breaker**
  (3 failures -> open for 30 s -> half-open trial), per-attempt **timeout** race and **fallback** to the next provider. Only failures that indicate a sick
  provider (timeout, network, 5xx, rate limit, malformed) count against the breaker; `invalid_request`/`unsupported`/`auth` do not.
- Default chain = `AI_DEFAULT_PROVIDER`, then every other provider that has a key, then `dev` **only outside production** (a production outage is a 503,
  never a silent downgrade to a rule-based demo). Tests register a controllable provider on `getAiRuntime(ctx).registry` and set a route.
- **Budgets** (persisted, so they survive restarts and hold across instances): `ai_usage` (user, day, task) and `ai_usage_global` (day, task, provider).
  `AI_USER_DAILY_TOKENS` and `AI_GLOBAL_DAILY_TOKENS` are checked _before_ a provider is called (429 with `details.reason` `ai_user_daily_budget` /
  `ai_global_daily_budget`). Translation has its own per-user counter, `AI_TRANSLATIONS_PER_DAY`.
- **Metrics** on `ctx.metrics.registry`: `yapilapi_ai_requests_total{provider,task,outcome}`, `yapilapi_ai_latency_seconds`, `yapilapi_ai_tokens_total`,
  `yapilapi_ai_cost_micros_total`, `yapilapi_ai_safety_events_total{kind}`; `ctx.metrics.events` counts chats and confirmations.
- Errors: every provider failed -> 503 (details are logged, not returned); provider cannot do the task (dev translation of unknown text) -> 422.

### Providers (`packages/ai/src/providers`)

| Provider    | Notes                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`       | Deterministic, offline, rule-based. It decides tools with regexes, phrases answers from tool results, drafts from templates, translates a small phrasebook, and says so. Labelled `provider: "dev"`. |
| `anthropic` | Messages API via `fetch` (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`). Tools, JSON mode, usage mapping.                                                                            |
| `openai`    | Chat Completions + embeddings via `fetch` (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`).                                                                                                     |

The adapters are unit-tested against fixtures in `providers/fixtures`. **Those fixtures are hand-written to the providers' documented response shapes; they
were not captured from live calls, and the adapters have never been run against a live endpoint** (no keys were available). Treat first live use as
unverified; `npm run test:ai-evals -- --live` is the smoke test.

### Permission Engine (`permissions.ts`)

`checkTool` (agent grants, scope, teen rules) then `requireConsent`; data accessors `post`, `threadComments`, `comment`, `event`, `communityKnowledge`,
`businessKnowledge`, `attachedConversation`, `conversationMessages`, `canPostInCommunity`, `memoryAllowed`. Denials are `PermissionDenied` with a machine
reason (`not_visible`, `not_member`, `consent_required`, `not_attached`, `teen_restricted`, `assistant_disabled`, `scope_mismatch`, `tool_not_allowed`,
`permission_missing`). Over HTTP they map to what the API would say without AI (404 for anything the user may not know exists, 403 + reason for consent).

**Private messages** are only reachable through `attachedConversation`, which requires, in order: an adult account, the conversation id in
`attachConversationIds` **on this request**, `ai_processing` consent, and normal conversation access (active member, not blocked, history from `joined_at`).
Nothing reads DMs in the background; summaries of DMs are marked `privateSource` and are omitted from later prompts of the same conversation.

### Tool System (`packages/ai/src/tools.ts`, `tools/*`)

| Tool                                                                                                      | Effect | Needs consent   | Notes                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------ | --------------- | --------------------------------------------------------------------------------------------------- |
| `search_content`                                                                                          | read   | no              | app search backend as the user, re-hydrated through visibility guards; states why results are shown |
| `find_events`, `get_event_details`                                                                        | read   | no              | `eventVisibleSql`; published upcoming events only for the list                                      |
| `summarize_thread`                                                                                        | read   | `ai_processing` | post + comments the user can see (blocks, moderation, restrictions applied)                         |
| `summarize_conversation`                                                                                  | read   | `ai_processing` | attached conversation only; not for teens                                                           |
| `draft_post`, `draft_reply`, `draft_caption`, `draft_description`, `suggest_titles`, `thumbnail_concepts` | draft  | reply only      | creates `ai_artifacts`                                                                              |
| `plan_from_conversation`                                                                                  | draft  | `ai_processing` | attached conversation; only real members can be assignees                                           |
| `create_event_draft`                                                                                      | draft  | no              | payload for an **unpublished** event                                                                |
| `community_faq_answer`, `business_assistant_answer`                                                       | read   | no              | grounded answers (below)                                                                            |
| `translate`                                                                                               | read   | no              | display only                                                                                        |

`executeTool` order: known tool -> agent/scope/grants/teen -> zod validation of the model's arguments -> consent -> handler -> audit row (input passed through
`redactForAudit`) -> `{ok, error}` back to the model (a model never sees an exception). Rate-limit and 5xx errors are rethrown so callers get real HTTP errors.

### Context Engine

Bounded, provenance-tagged, permitted-only. `ContextBundle` (packages/ai) takes items `{source, text}`, orders and truncates to a token budget and renders
them as `<untrusted_data source="type:id">` blocks. Scopes: **personal** (own memories with consent, attached chats), **community** (member-visible rules,
resources and human-written decisions only), **business** (owner-approved, unedited knowledge of an enabled assistant only), **creator** (own drafts input;
no analytics data is read). Every source used is returned in `sources`.

### Grounded assistants (`grounded.ts`)

Community and business questions are answered **only** from approved, human-authored entries: lexical retrieval decides whether anything is relevant (none ->
"not documented", no model call, no sources); a model may only phrase an answer from the matched entries; the result must pass a groundedness check or is
replaced by a verbatim quote of the entry. Business answers additionally require the owner to have enabled the assistant, and an edited approved entry
returns to draft and stops being used until re-approved.

### Agents (`packages/ai/src/agents.ts`)

Seven declarative configs: `social`, `creator`, `community`, `event`, `shopping`, `business`, `travel`. Each names its scope, tools, permission grants, system
prompt (shared safety preamble + role), safety profile (`groundedOnly`, `maxToolCalls`, `useMemory`, `allowAttachments`, `teenAllowed`, output cap) and its own
`evals` (run by the eval harness). An agent can only narrow what the engine allows. `GET /v1/ai/agents` lists them with per-viewer availability.

### Memory (`memory.ts`)

`GET/POST/DELETE /v1/ai/memories`. Behind flag `MEMORY` and `ai_memory` consent (teens cannot grant it). A memory is created only from (a) a fact the user typed
or (b) a suggestion the assistant showed in one of the user's own replies that they approve (`sourceRef` is verified against the stored message). Nothing is
ever derived from retrieved posts, DMs, tool output or model text. Secrets, credential words and instruction-like text are refused; duplicates are
rejected; max 100. Used memories update `last_used_at`/`use_count` and are listed in the reply `sources`.

### Artifacts and confirmation (`artifacts.ts`)

`GET /v1/ai/artifacts[/:id]`, `PATCH /:id` (edit; marks `edited`), `POST /:id/confirm`, `POST /:id/discard`. Confirm claims the draft atomically (a replay is 409),
performs the action **through the normal service as the confirming user, re-checking permissions at that moment**, and on any failure returns the draft to
`draft` so it can be fixed:

| Kind                                        | Confirm does                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `post_draft`                                | `createPost` (community permission, teen rules, moderation) with `aiAssistance`; `posts.ai_provenance` says generated vs assisted |
| `reply_draft`                               | `sendMessage` (conversation) or a comment mirroring the content route (visibility, restrictions, notifications)                   |
| `plan`                                      | messaging `createPlan` (membership, blocks) in the chosen conversation, `ai_generated = true`                                     |
| `event_draft`                               | inserts an **unpublished, private-by-default** event; publishing stays a separate human action                                    |
| `caption`, titles, description, translation | nothing is created; the chosen text is handed back                                                                                |

### Translation and speech

`POST /v1/ai/translate` (flag `AI_TRANSLATION`) for `post`, `comment`, `message`, `caption`, `community`, `event`: authorise and load the original first, then cache
(`content_translations`, keyed by target and language, validated by `source_hash`, so an edited original is retranslated and a cache hit can never be served
to someone who cannot see the source), then per-user quota, then the router's `translate` route. The **original is always returned**; the result is marked
`machineTranslated`. `POST /v1/ai/language/detect` is a local heuristic. `SpeechProvider` (`packages/ai/src/speech.ts`) is an interface only:
`/v1/ai/speech/*` returns **501 `feature_disabled`** until a provider is set on `getAiRuntime(ctx).speech.provider`, and never fabricates transcripts.
`MediaAiProvider` is the agreed seam for the Creator Studio (nothing implements it here).

## Endpoints

`GET /v1/ai/status | agents | usage | tool-calls` - `POST /v1/ai/chat` (`stream: true` for SSE) - `GET /v1/ai/conversations`, `GET /v1/ai/conversations/:id/messages`,
`DELETE /v1/ai/conversations/:id` (hard delete), `DELETE /v1/ai/conversations` - `POST /v1/ai/community/:id/ask`, `POST /v1/ai/business/:id/ask` -
`POST /v1/ai/creator/{titles,descriptions,captions,thumbnail-concepts,translate}` (drafts only) - artifacts and memory as above - `POST /v1/ai/translate`,
`POST /v1/ai/language/detect` - `POST /v1/ai/speech/{transcribe,translate}`.

Streaming is **buffer-then-stream**: the answer is fully safety-screened, then emitted as SSE (`meta`, `tool`, `delta`, `done`). Nothing unscreened is ever streamed.

## Data (migration 210, additive)

`ai_conversations.agent`, `ai_messages.tool_calls` (names and outcomes only), `ai_memories.use_count/content_hash`, `ai_tool_calls.agent/duration_ms/sources/request_id`,
`ai_artifacts.conversation_id/tool/provider/sources/edited/result_ref/updated_at`, `content_translations.source_hash/source_language`, new `ai_usage`,
`ai_usage_global`. Export section `ai_platform` (memories, usage, draft provenance) and a deletion hook for `ai_usage`; the core privacy sections and deletion
hook already cover conversations, messages, memories, artifacts and tool calls.

## Configuration

`AI_ENABLED` (default true, dev provider), `AI_DEFAULT_PROVIDER`, `ANTHROPIC_*`, `OPENAI_*`, `AI_REQUEST_TIMEOUT_MS`, `AI_USER_DAILY_TOKENS`, `AI_GLOBAL_DAILY_TOKENS`,
`AI_TRANSLATIONS_PER_DAY`. Flags: `AI_TRANSLATION`, `MEMORY`.

## Evaluation harness (`tests/ai-evals`)

`npm run test:ai-evals` boots the real app on a private database (`yapilapi_test_aievals`, rebuilt from migrations), runs 79 cases through the real gateway and
writes `tests/ai-evals/out/report.json`. Categories and thresholds: permissions, privacy, injection, hallucination, safety **100 %**; translation,
summarisation, structured outputs, recommendation explanations, agents **90 %**. Exit code 1 below a threshold. Cases are tagged `invariant` (must hold for any
model) or `dev` (assert the dev responder's exact behaviour). `--live` (needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) runs only the invariant cases against the
real provider with no dev fallback; it has not been run here. Offline mode measures the **platform** (permissions, privacy, grounding, safety, routing), **not
model quality**. `--category`, `--case`, `--out` narrow or redirect a run.

## Known gaps

- Live providers are untested (no keys); fixtures are hand-written to documented shapes.
- Speech is an interface; no transcription or voice translation exists. Media AI (clips, silence) is an interface only.
- The events module has no `createEvent` service and there is no comment service, so confirm inserts the unpublished event and mirrors the comment route
  itself. If those modules gain services, `artifacts.ts` should call them.
- Translating untrusted text cannot be injection-neutralised (that would alter the text); translate calls offer no tools and the output is display-only.
- The dev responder is a demo, not a model: free-form questions get a canned capability reply.
- Retrieval for grounded assistants is lexical (deterministic). Embeddings exist in the provider interface but are not used for ranking yet.
