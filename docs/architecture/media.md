# Media and Moments

Code: `apps/api/src/modules/media/`, `apps/api/src/modules/moments/`. Migrations `120_media_pipeline.sql`, `130_moments.sql`.
Tests: `apps/api/test/media.test.ts`, `moments.test.ts`, unit tests next to the modules (`*.unit.test.ts`).

## Media

### Endpoints

|                                           |                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/media`                          | multipart (`file`, optional `altText`, `decorative`, `purpose` = `attachment`\|`public`, `kind`). Up to 32 MB.                                                    |
| `POST /v1/media/uploads`                  | start a resumable upload (`kind`, `size`, `sha256`, `chunkSize?`) -> `{id, chunkSize, chunkCount, expiresAt}`. `mode:"direct"` returns a presigned PUT (S3 only). |
| `GET /v1/media/uploads/:id`               | received / missing chunks (resume).                                                                                                                               |
| `PUT /v1/media/uploads/:id/chunks/:n`     | raw bytes (`application/octet-stream`), optional `X-Chunk-Sha256`. Idempotent per chunk (a retry returns `duplicate:true`; a corrected chunk overwrites).         |
| `POST /v1/media/uploads/:id/complete`     | assemble on disk, verify size + SHA-256, sniff type, sanitise, store. Idempotent. A wrong checksum discards the chunks so the client can start clean.             |
| `GET/PATCH/DELETE /v1/media/:id`          | metadata; alt text / decorative; soft-delete + remove bytes.                                                                                                      |
| `PUT/DELETE /v1/media/:id/captions/:lang` | WebVTT (`text/vtt` body or JSON `{content}`), validated (header, cue timing, ordering, size).                                                                     |
| `PUT/DELETE /v1/profile/avatar`, `/cover` | set from an owned, `ready` image (it becomes `public`); the previous image is retired.                                                                            |
| `POST/DELETE /v1/admin/media/:id/block`   | moderators: blocked media is never served (owner included); unblock re-processes.                                                                                 |
| `GET /media/*`                            | serving (see below).                                                                                                                                              |

### Rules

- **Never trust the client**: kind, MIME and extension come from magic bytes (`sniff.ts`): jpeg/png/webp/gif/avif, mp4/mov/webm, mp3/m4a/ogg/wav, pdf. Everything else (exe, svg, html, mkv, heic, ...) is 415. A client label that contradicts the bytes (PNG sent as `video/mp4`, or `kind=video`) is 415, not silently re-typed. Chunked uploads are sniffed on chunk 0 so a bad file costs one chunk of bandwidth.
- Max sizes: image 20 MB, file 25 MB, audio 100 MB, video 500 MB; 10 GiB per-user quota. Random 128-bit storage keys (`m/ab/<32 hex>.<ext>`). SHA-256 is stored (of the bytes actually stored).
- **Privacy**: EXIF/GPS/XMP/IPTC are removed from images before storage. With `sharp` (installed) images are re-encoded (orientation applied, then dropped). If sharp cannot load, a lossless pure-JS stripper handles JPEG and PNG (keeps only the orientation flag, drops data after EOI/IEND). GIF has no EXIF. WebP/AVIF cannot be stripped without sharp: they are stored as-is and the media reports `metadataStripped:false`. Images always pass through the API (never direct-to-bucket) for this reason.
- **Accessibility**: images report `needsAltText` until an alt text is given or the image is marked `decorative`.
- **Lifecycle**: `pending -> uploaded -> processing -> ready | failed | blocked`. Existing modules may attach `uploaded|processing|ready` media.

### Processing (`processor.ts`, swappable `MediaProcessor` + `MediaQueue`; in-process queue, concurrency 1)

- Images (sharp): width/height, BlurHash, variants `thumb` (320 px webp) and `webp` (<=1600 px).
- Video/audio (ffprobe/ffmpeg found via `MEDIA_FFMPEG_PATH` / `MEDIA_FFPROBE_PATH`): duration, dimensions, validation that a video really has a video stream (else `failed`), video variants `poster` (jpeg) and `720p` (H.264/AAC mp4, faststart, never upscaled). ffmpeg is invoked with a forced demuxer and `-protocol_whitelist file`.
- **HLS is not produced** (many segment objects + a segment-aware serving route); progressive mp4 with Range support is served instead.
- `media.processing` is honest: `variants` (renditions exist), `metadata` (probed only, e.g. audio), `passthrough` (no tool available / nothing to derive: media is `ready` as uploaded, no variants).
- Not verified at scale: transcoding runs inside the API process; production should point `MediaQueue` at a worker fleet.

### Serving and authorization

`GET /media/<key>` (originals, variants, captions) authorises every request (`access.ts`): owner; anyone if `purpose=public` (avatars/covers); anyone who can see a post (`postVisibleSql`) or moment (`momentVisibleSql`, expiry included) it is attached to; conversation members for message attachments (via `loadAccess`, so blocks, group join time and community channels apply). Everything else is a 404 (never 403). `pending`, `failed`, `blocked`, deleted media are never served. Headers: sniffed `Content-Type`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, ETag/304, single-range `Range`/206/416, `inline` for images/audio/video and `attachment` for files, `public, immutable` for public media and `private, max-age=3600` otherwise. A trigger forbids attaching `purpose=public` media to posts/moments/messages (it would bypass their audience).
With the S3 adapter the API authorises then 302-redirects to a 5-minute presigned GET; a CDN in front is only appropriate for `public` media.

### Storage adapters (`storage.ts`, `s3.ts`)

`MEDIA_ADAPTER=local` (dir `MEDIA_LOCAL_DIR`, atomic writes, path-traversal-proof keys) or `s3` (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`). **The S3 adapter has not been run against a live bucket**: unit tests cover request construction (commands, ranges, bucket/key) and presigning only. Direct upload signs Content-Type, Content-Length and the SHA-256 into the URL; `complete` then HEADs the object (size), reads the first bytes (sniff) and deletes the object on any mismatch. The direct-flow server logic is integration-tested with a presigning subclass of the local adapter.

### Maintenance

`scripts/cleanup-media.ts` (`npm run media:cleanup`, hourly): drops expired unfinished uploads and their chunks (24 h sliding TTL), deletes storage of soft-deleted media (also rows soft-deleted by the account-deletion hook), re-queues media stuck in `uploaded`/`processing`.

## Moments

Endpoints: `POST /v1/moments`, `GET /v1/moments/tray`, `GET /v1/moments/:id`, `GET /v1/users/:username/moments`, `POST /v1/moments/:id/view`, `GET /v1/moments/:id/viewers` (author), `DELETE /v1/moments/:id`, `PUT/DELETE /v1/moments/:id/reaction`.

- Kinds `photo|video|text|audio`; media must be yours, unused (not in a post, message or another moment), `uploaded|processing|ready`, of the matching kind and not `public` profile media. Music metadata is descriptive only. Visibility `public|followers|friends|circle|selected` (default friends). Expiry `1h|24h|custom|permanent`; custom = `expiresAt` between now+15 min and now+7 days.
- Teens: no public moments and no location. Private accounts cannot post public moments; non-authors see coordinates rounded to ~110 m. Text (body + music) goes through `screenText`; held moments are invisible to everyone but the author's own create response.
- **Expiry is enforced in SQL** (`momentVisibleSql`): an expired moment is invisible to everyone (including the author's reads) the instant it expires. `expireMoments(ctx)` (`scripts/expire-moments.ts`, `npm run moments:expire`, every ~5 min) only reclaims: deletes media bytes (unless something else now uses them), erases text/music/location, soft-deletes the moment, drops views/reactions/audience. Idempotent, batched.
- Tray: live moments (created in the last 7 days) from people you follow (active) or are friends with, excluding yourself, muted and blocked users; grouped per author, groups with unseen moments first (newest first), then seen ones; moments inside a group play oldest first. `limit` <= 50 authors, `hasMore`; no cursor (bounded by the 7-day window and 600-moment cap).
- Deletion hooks: media (soft-delete, swept later) and moments (erase + soft-delete, views, audience).

## Shared-file changes

`lib/visibility.ts` (`momentVisibleSql` public branch now respects private accounts like posts), `modules/index.ts`, `packages/config` + `.env.example` (`S3_FORCE_PATH_STYLE`, `MEDIA_FFMPEG_PATH`, `MEDIA_FFPROBE_PATH`), root `package.json` scripts, `apps/api/package.json` (`sharp`, `blurhash`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
