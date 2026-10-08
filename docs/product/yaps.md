# Yaps: the social network you speak

YAPILAPI is the social network you speak. Its core unit is the **Yap**: a voice post of up to 60
seconds. Hold one button and talk: no camera, no face, no typing. Every Yap gets a transcript
(searchable, checked by moderation, a text alternative for people who can't listen) and, through
"Speak any language" (docs/product/speak-any-language.md), reaches listeners in their own language,
with "Listen in …" read out by the speech engine (docs/product/speech-engine.md). A minute of voice
is about 240 KB, some fifty times lighter than a minute of video, which matters for the people we
build for first (Africa, South Asia, the Middle East). Photos and reels stay; voice leads.

Behind the `YAPS` flag (on). Migration `0090_yaps.sql` (0088 is unused). Code: `packages/shared/src/voice.ts`
(types, limits, pure helpers the phone uses), `packages/shared/src/voice-schemas.ts`,
`apps/api/src/lib/voice.ts`, `apps/api/src/modules/voice.ts`, `packages/design-system/src/voice.tsx`
(the web player), `apps/web/components/YapRecorder.tsx`, `apps/mobile/lib/voice.tsx` (player,
recorder, upload). Tests: `apps/api/test/yaps.test.ts`, `packages/shared/src/voice.test.ts`,
`apps/web/e2e/yaps.spec.ts`.

Not to be confused with Yap in chats (hold to talk, plays out loud like a walkie-talkie:
`apps/api/src/lib/yaps.ts`), whose voice messages are transcribed by `lib/voice-transcripts.ts`.

## What people can do

- **Record a Yap.** Yap is the first option in Create (Spark) on the web and the phone. Hold the big
  button to talk and let go to stop; or tap once to start and again to stop (the keyboard's Enter or
  Space, and screen readers, use this). A live waveform and a countdown show while recording; it
  stops by itself at 60 seconds. On the phone, slide left to cancel and slide up to lock for
  hands-free. Then play it back, record again or discard it, add an optional line (up to 280
  characters, #tags and @mentions work), choose the audience (everyone, followers, friends, a
  circle, chosen people, subscribers, a squad), a place, and post.
- **Listen.** A Yap card everywhere posts show (Pulse, profiles, tags, places, squads, search):
  the speaker, the line, a waveform to scrub along (a slider for the keyboard and screen readers),
  play and pause, the time, speed 1×, 1.5×, 2×. One clip plays at a time; nothing plays by itself.
  The transcript opens under it, in the reader's language when they don't understand the speaker's
  ("Translated from French · See original"), with "Listen in English" when listening is on; in
  the original, the line being spoken is marked and pressing a line plays from there. A Yap's own
  page (`/p/:id`) has the big player with the transcript open.
- **Pulse, Yaps only.** A "Yaps" filter next to For you and Following (`GET /v1/feed?mode=yaps`),
  ranked like For you.
- **Talk back.** Any post (not only a Yap) can be answered by voice: a voice reply of up to a minute,
  with or without words, in threads that mix voice and text. Notifications as for comments.
- **Voice intro.** Up to 15 seconds on your profile, played from the header; recorded, replaced or
  removed in profile settings (web: Settings → Account; phone: Edit profile).
- **Data saver.** No clip loads until play is pressed (the length and waveform come with the post).
  Off Data saver, when one clip plays the next one on the page loads ahead; with Data saver on,
  nothing loads ahead.

## Data model (for the next builders)

A Yap is **a post**: `posts.format = 'yap'`, `posts.kind = 'audio'`, one `post_media` row pointing
at its clip's `media` row. Everything that works on posts works on Yaps: audiences (squads
included), place tags, comments, reports, stats, the recommender, export, deletion. The line is
`posts.body` (searchable as always, with its own `lang`).

`voice_clips` (one row per recorded clip, keyed by its media id):

| Column | What |
| --- | --- |
| `media_id` | The `media` row: the stored file (`audio/mp4`, AAC mono 24 kHz about 32 kbit/s, tags stripped), `duration_ms`, `size_bytes`. Also the clip's id everywhere (`VoiceClip.id`). |
| `owner_id`, `purpose` | Who recorded it and what for: `yap`, `comment` or `intro` (it decides the length limit; a clip is attached only where its purpose says, and only once). |
| `duration_ms` | Measured by the server from the decoded sound (never the app's word), at most 61 s. |
| `peaks` | 48 loudness bars, 0 to 100, for drawing the waveform without loading the audio. |
| `transcript_status` | `pending` (being made), `ready`, `unavailable` (no speech-to-text), `failed` (the provider failed or heard nothing). |
| `transcript`, `segments`, `lang` | The words, the timed lines (`[{start, end, text}]`, seconds, when the provider gives WebVTT) and their detected language. |
| `screened` | `passed` or `held`: whether the words passed the text checks. |
| `search` | `to_tsvector('simple', transcript)`, GIN-indexed: search finds Yaps by what they say. |

Elsewhere: `comments.voice_media_id` (a voice reply), `profiles.voice_intro_media_id`,
`feed_events` kinds `listen_start`, `listen`, `listen_complete` and surfaces `yaps`, `squad`,
`place`; `post_stats.listens`, `listen_ms`, `listen_completes`; `feed_sessions.surface` `yaps`;
`translations.kind` `voice` (and spoken clips, `speech_clip_uses.kind` `voice`), both forgotten by
triggers when the words change or the clip goes.

The API gives `VoiceClip { id, url, durationMs, peaks, transcript: { status, text, lang, segments } }`
on `Post.voice` (format 'yap'), `Comment.voice` and `Profile.voiceIntro`.

## API

- `POST /v1/voice?purpose=yap|comment|intro` (multipart `file`, up to 8 MB as sent): decode, measure
  (1 s to 60 s, an intro up to 15 s, 0.5 s of slack), store small, draw the waveform. Returns
  `{ voice }`. At most 60 clips an hour per person.
- `POST /v1/posts` with `format: 'yap'` and `media: [{ id, url, kind: 'audio' }]` (the clip, which must
  be yours, recorded for a Yap and unused). At most 30 Yaps an hour.
- `POST /v1/posts/:id/comments` with `voiceId` (a clip recorded for a reply); `body` is then optional.
- `PATCH /v1/me/profile` with `voiceIntroId` (or `null` to remove it; the old clip's file is deleted).
- `GET /v1/voice/:id`: one clip the viewer can hear (the apps ask again while its transcript is pending).
- `POST /v1/voice/:id/speech` `{ target }`: "Listen in …", the transcript's translation read out
  (`lib/speech.ts`, kind `voice`), with the same switches as voice messages (`VOICE_TRANSLATION`,
  `AI_TRANSLATION`, a translation model and `TTS_PROVIDER`).
- `POST /v1/translations` and `/v1/translate` with kind `voice`.
- `GET /v1/feed?mode=yaps`; `POST /v1/feed/events` with the listen kinds.
- `GET /v1/admin/yaps`: how many Yaps, this week's, voice replies, intros, transcripts by state
  (admin console, Flags tab).

## Transcripts and moderation

When a clip is attached (a Yap published, a reply posted, an intro set), the job
`voice.clip.transcribe` sends it to the configured provider (`lib/transcription.ts`,
`TRANSCRIBE_PROVIDER`), without a language so the provider hears which one is spoken. The words go
through the same text checks as a post (`analyzeText`): words that may put someone at risk remove
the Yap or reply; others hold it for review or restrict it, with an automated moderation case that
names the transcript (`voice_transcript`); an intro that doesn't pass comes off the profile. Each
call is in the AI audit log (task `transcribe`).

**Until its words have passed**, a Yap reaches its author's followers and anyone who opens it, but
isn't suggested to anyone else: not in For you, the Yaps filter or Fair start
(`yapDistributableSql`). A held transcript keeps it out for good.

**Without a provider** (`TRANSCRIBE_PROVIDER=none`, production today), clips are `unavailable` at
once ("Transcript not available"), Yaps go out normally and moderation relies on reports. A failed
transcript is treated the same way.

## Ranking and Fair start

Yaps are ranked with everything else in For you and alone in the Yaps filter (`RankSurface 'yaps'`).
A Yap's own signals: the share of listens that reached the end (90%, `VOICE_COMPLETE_AT`; pulled
towards a prior until it has been heard enough) and the voice replies it started. Finished listens
count like finished reels for "people like you", and listening long enough teaches the recommender
like watching. Yaps make their own "format" for the variety rule. A creator's first Yaps get a fair
start like reels (`lib/fair-start.ts`), once their words have passed (or there will be none); the
Reels feed only takes fair-start reels and the Yaps filter only fair-start Yaps. (The "fair start is
done" notification still says reel.)

## Files and data

- Deleting a Yap or a voice reply deletes its recording at once, unless a report or a moderation case
  about it is still open (then the usual retention erases it later). Changing or removing an intro
  deletes the old one. Deleting the account deletes every file and clears the transcripts.
- The data export has `content.voice`: each clip's purpose, where it went, its address while it can
  be opened, and its transcript; `profile.voice_intro_media_id`.

## Later builders

- **Yap Radio** (hands-free listening): a queue over `GET /v1/feed?mode=yaps` that plays clip after
  clip, using `listen_*` events, `VoiceClip.peaks` for the screen and `voice.speech` for translations.
- **Ask the city**: Yaps with a `place_id`, found through `posts_place_idx` and the transcript search.
- **Yapilapi Today** (built: docs/product/yapilapi-today.md): a daily spoken briefing ranked with
  `post_stats.listen_completes`, written from transcripts.
