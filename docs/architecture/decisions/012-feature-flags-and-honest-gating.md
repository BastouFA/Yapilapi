# ADR 012: unfinished capability is gated by a feature flag and answers honestly

Status: accepted. Scope: whole platform

## Decision

Flags (`LIVE, COMMERCE, AI_TRANSLATION, MEMORY, NOW, MINI_APPS, PLAY, REAL, REAL_TOGETHER`) support global on/off, percentage rollout and per-user overrides, are readable at `/v1/meta` and managed by staff with audit. Where a capability depends on infrastructure that is not configured (live ingest, ffmpeg, speech, hardware attestation), the API returns an explicit `501`/`503` with a machine-readable reason instead of pretending to succeed. There is no "Coming Soon" UI outside a documented flag.
