# Creator Studio

Scope: `apps/api/src/modules/studio`, migrations `240_studio.sql`, `241_studio_description.sql`, `scripts/studio-publish.ts` (`npm run studio:publish`).
Tests: `modules/studio/*.unit.test.ts` (26: EDL, captions, silence heuristics, ffmpeg arguments), `apps/api/test/studio.test.ts` (22 on real Postgres; the ffmpeg cases use a real generated clip and are skipped when ffmpeg is not installed).

## Principles

1. **Non-destructive.** A project references media the creator owns. The edit is a recipe (EDL); the source file is never modified. Rendering writes a **new** media row.
2. **Nothing is published by itself.** Publishing needs `confirm: true` in the request. AI suggestions are drafts the creator applies (and that are then recorded as AI assistance).
3. **Honest about capability.** `GET /v1/studio/status` reports what this server can really do (ffmpeg + encoders, speech provider, AI). Missing capability is `503 unavailable / processing_unavailable` or `501 feature_disabled`, never a fake result.
4. **Same rules as any post.** Publishing goes through `createPost` (moderation screening, teen rules, audience rules, rights, AI provenance).

## Endpoints (`/v1/studio`)

`GET status`, `POST edl/validate`, `POST captions/validate` (pure, stateless); projects: `POST|GET projects`, `GET|PATCH|DELETE projects/:id`; `PUT projects/:id/edl` (versioned, optional `expectedVersion`); captions: `GET projects/:id/captions`, `PUT|GET|DELETE projects/:id/captions/:lang`; `POST projects/:id/transcribe`; `POST projects/:id/render`, `GET projects/:id/renders`; suggestions: `POST|GET projects/:id/suggestions`, `POST .../:sid/accept|dismiss`; publishing: `POST projects/:id/publish`, `GET|DELETE projects/:id/publication`.

## Design

**EDL** (`edl.ts`, pure): `{version, segments[], aspect, thumbnail, captions}`. `segments` are the kept parts of the source (a cut is a gap, a trim is a boundary); validated against the media (duration, kind: audio projects reject video-only operations), hashed (`edlHash`) so a render can be matched to the exact recipe. Includes `remapCues` to re-time captions onto the cut timeline.

**Captions** (`captions.ts`, pure): WebVTT and SRT import, validation with positions (overlaps, too-short/long cues, line length), export, heuristic review. Tracks are stored per project and language; text is screened like any user text. They can be burned in on render (ffmpeg `subtitles`) or travel with the media as sidecar tracks when published.

**Render** (`render.ts`, `render-plan.ts`): builds ffmpeg arguments from the EDL (trim/cut with `concat`, crop to an aspect, thumbnail moment, optional burn-in), runs the same sandboxed `runBinary` the media pipeline uses, then registers the output through `processMedia` as a new media row. One running job per project; idempotent per recipe (same EDL hash returns the existing output). ffmpeg output is never returned to clients. If ffmpeg or the encoders are missing: `503 processing_unavailable`.

**Transcription**: `SpeechProvider` from the AI platform seam. No provider: `501 feature_disabled` (after the ownership check) and the manual caption path still works. With a provider it needs `ai_processing` consent, and produces an _editable_ track marked as machine-made; the studio never invents a transcript.

**Suggestions** (`suggestions.ts`): heuristics from ffmpeg `silencedetect` (silence cuts, highlight clips, thumbnail moments) and caption review; AI titles/descriptions through an `AssistProvider` that wraps the AI module with a guarded dynamic import (`runDirectTool`, drafts only, needs consent). A kind that cannot run is listed under `skipped` with the reason while the others still work. Accepting a suggestion edits the draft project only; AI kinds add `studio_title` / `studio_description` to the project's `ai_assisted` list, which reaches the post's `aiProvenance`.

**Publishing** (`publish.ts`): the confirmation stores the _exact_ post content, the media (source or rendered output) and a content hash that also covers the EDL hash, caption hash, AI-assist list and title. Modes: `now` (post created inside the request) and `scheduled` (2 minutes to 90 days ahead). `publishDueStudioPosts` (script, every minute) re-verifies each due confirmation against the project _as it is now_; anything edited, replaced, deleted, or an inactive account, marks the publication stale/failed instead of publishing. Publications are claimed `confirmed -> published` before the post is created, so two workers or a retry can never create two posts. One open confirmation per project; cancel it to change it. A publish of an unrendered changed edit is `409 render_required`.

## Honest gaps

- **Rendering is synchronous** inside the request, bounded (10-minute source, 32 MB output, one job per project). A queue and worker (the media pipeline's queue is the natural home) is the documented next step; long videos need it.
- **No speech provider ships.** Auto-captions require wiring a real `SpeechProvider`; until then captions are manual/imported.
- **No AI provider ships** for titles/descriptions beyond what the AI module is configured with (dev responder is labelled as such).
- **Crash window:** a crash between claiming a publication and creating the post leaves a `published` row without `post_id`. It is visible and never repeated automatically; an operator resolves it.
- No multi-track timeline, transitions, filters, audio mixing or text overlays; the EDL is deliberately small (trim, cut, crop, burn-in captions, thumbnail).
- Loudness normalisation, denoise and stabilisation are not implemented.
