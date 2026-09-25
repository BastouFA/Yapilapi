# MEMORY

Scope: `apps/api/src/modules/memory`, migration `262_memory.sql`. Tests: `apps/api/test/memory.test.ts`,
`apps/api/src/modules/memory/memory.unit.test.ts`. Flag: `MEMORY` (off means 404 `feature_disabled`).

A **memory** is a curated, mostly private collection of things from a person's own life: their posts, moments, Reals, events they attended,
shared experiences they joined, media and (owner only) messages, plus links to people, places, events, trips, communities and experiences.

## The key property: sharing never widens an audience

A memory has its own privacy (`private` | `friends` | `public`), but that only decides who may **open the memory**. Every item inside is still
judged by **its own audience rule for the viewer** (`memoryItemVisibleSql`, built on the central post/moment/media/event/Real/experience
predicates). Consequences:

- Making a memory public does not make a friends-only post inside it public; strangers simply do not see that item.
- A friends-only memory that holds someone else's friends-only post shows it only to people already allowed to see it.
- Messages are visible to the owner only, whatever the memory's privacy.
- Adding items is limited to things the person already owns or can currently see (or events attended / experiences joined); anything else fails
  with one generic message so the API cannot be used to probe for content.
- Links are shown to a viewer only when that viewer may learn of the linked entity.
- Under-18 accounts cannot make memories public. Sharing and unsharing are written to the audit log.

Deleting a source (post, Real, account) removes it from every memory. Account deletion erases the person's memories and removes their content and
links from other people's memories.

## Timeline, on this day, trips

- **Timeline** (`GET /v1/memory/timeline`): the person's own life across sources, filterable by date range, place, event, person (things done
  together with a friend) and type, keyset-paginated. Always only the caller's own material.
- **On this day**: deterministic suggestions from past years in the person's timezone. Nothing is created or shared automatically; accepting
  creates a **private** memory once.
- **Trips**: pure clustering (`trips.ts`). Home is inferred as the grid cell with the most distinct days; consecutive geotagged days away from
  home form a trip. Suggestions are never auto-created; accepting makes a private memory; dismissals are remembered.

## Recap

`buildRecap` is deterministic (no AI): counts, date span, places and people, computed per viewer over the items they can see. It is saved only when
the owner asks (`POST /v1/memories/:id/recap/apply`).

## Optional AI drafts

`POST /v1/memories/:id/ai-drafts` asks the AI module for a title or summary. It needs AI switched on and the person's `ai_processing` consent,
otherwise the answer is unavailable (never faked). The prompt carries only the person's own item facts, unusable or unsafe output is refused, and
a draft is **stored, not applied**. The person confirms (`/confirm`) or discards it; confirmation records AI provenance. Nothing an AI wrote
changes a memory without that human step.

## Slideshow export

`POST /v1/memories/:id/exports/slideshow` renders a short video (2 seconds per image, at most 30 of the caller's own images) with ffmpeg's concat
demuxer and stores it in the owner's own media. If ffmpeg is not installed the answer is `processing_unavailable`, never a fake success.

## Endpoints

| Method               | Path                                                      |
| -------------------- | --------------------------------------------------------- |
| POST / GET           | `/v1/memories`                                            |
| GET                  | `/v1/users/:username/memories`                            |
| GET / PATCH / DELETE | `/v1/memories/:id`                                        |
| POST                 | `/v1/memories/:id/items`                                  |
| PUT                  | `/v1/memories/:id/items/order`                            |
| DELETE               | `/v1/memories/:id/items/:type/:itemId`                    |
| POST                 | `/v1/memories/:id/links`                                  |
| DELETE               | `/v1/memories/:id/links/:type/:entityId`                  |
| GET                  | `/v1/memories/:id/recap`                                  |
| POST                 | `/v1/memories/:id/recap/apply`                            |
| GET                  | `/v1/memory/timeline`                                     |
| GET / POST           | `/v1/memory/on-this-day`, `/v1/memory/on-this-day/accept` |
| GET / POST           | `/v1/memory/trips/suggestions`, `/v1/memory/trips/accept` |
| POST                 | `/v1/memory/suggestions/dismiss`                          |
| POST / GET           | `/v1/memories/:id/ai-drafts`                              |
| POST                 | `/v1/memories/:id/ai-drafts/:draftId/{confirm,discard}`   |
| POST                 | `/v1/memories/:id/exports/slideshow`                      |

A memory holds at most 500 items. Data export includes a `memory` section.

## Known gaps

- The slideshow needs ffmpeg on the host and covers images only (no audio, no video clips).
- Trip clustering is geographic only; it does not name trips.
