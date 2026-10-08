# Yapilapi Today

Every morning, a short briefing at the top of Pulse: "Here's what your people and your city are
talking about." Four to seven short segments, about 300 words at most, written from the day's top
Yaps and posts of the people you follow, your friends, your squads and your city, in your app's
language, and read aloud by a plain synthetic voice. Each segment says which posts it is about, so
you can open them or hear the original Yap ("Hear @ada"). A reason to open YAPILAPI each day,
without pressure: nothing plays by itself, there is no streak, and it is easy to put away or turn
off.

Behind the `TODAY` flag (on), and only with a real AI model (`AI_PROVIDER=anthropic` and a key):
with the offline stand-in, development and tests get a rule-based Today ("@ada: first words…") and
production shows nothing. Migration `0093_today.sql` (0091 and 0092 are Yap Radio's and Ask the
city's). Code: `apps/api/src/lib/today.ts`, `apps/api/src/modules/today.ts`,
`packages/shared/src/today.ts` (types and limits both apps use), `apps/web/components/Today.tsx`,
`apps/mobile/lib/today.tsx`. Tests: `apps/api/test/today.test.ts`, `apps/web/e2e/today.spec.ts`
(with `apps/web/e2e/today-stub.mjs`).

## For people

- **The card** (web and phone, the top of Pulse): "Yapilapi Today", marked AI-generated, with
  Play and Hide. Play reads the first segment and goes on to the next by itself; the player shows
  "Part 2 of 5", the segment's words, Previous and Next, and under each segment its sources: a link
  to each post ("Ada's post") and, for a Yap, **Hear @ada** (its own recording). **Not interested in
  this** takes that segment away; the people and posts it was about stay out of your Todays for 30
  days (your feeds don't change). **Hide** puts the card away until tomorrow's.
- **Without a voice** (no text-to-speech configured, or past the day's reading budget), a Today is
  its text, and Play plays each segment's first original Yap instead; a segment without one waits on
  its text for Next. Never a made-up voice, never anyone's own.
- **Settings → Notifications → Yapilapi Today** (web and phone): on or off (on by default), the hour
  it's ready from (5:00 to 11:00, default 7:00, in your time zone, which the apps keep up to date),
  include my city (on; needs a city on your profile), and "Tell me when it's ready" (off by
  default; quiet hours, a pause, focus and the System category hold it like any notification).

## How a Today is made

1. **When.** Once a minute the worker looks for people with Today on, who used YAPILAPI in the last
   7 days (a session seen), whose chosen hour has come this morning (until noon, their time) and who
   have none for today yet, up to 100 at a time, four at once (`sweepToday`). Everyone else gets
   theirs the first time they open Pulse after their hour (`GET /v1/today`). One per person and
   local day.
2. **What goes in.** The last 24 hours, the best first (likes, twice the comments, three times the
   finished listens of a Yap, a squad post a little more), and only what has words: a post's text
   and a Yap's transcript.
   - **Your people** (your own part, never shared): posts by people you follow or are friends with,
     and posts in your squads, at most 20.
   - **Your city** (shared): public posts by adults with public accounts, tagged at a place in your
     profile's city or by someone whose profile names it, at most 15. Only for adults.
3. **What never goes in.** Anything the person can't see and open right now (`postVisibleSql` and
   `postUnlockedSql`: audiences and squads, blocks both ways, private accounts, regional rules,
   subscriptions); anything held for review or restricted, with media marked sensitive or blocked,
   with an open report, or a Yap whose words the checks held; people they muted, posts and people
   they said they're not interested in (in the feed or in Today); anything by someone under 18 for
   an adult; their own posts; community posts. The city part also leaves out echoes and anything
   withheld in any country, since it is shared.
4. **Writing.** One call per part to the model (`AI_TODAY_MODEL`, default `claude-sonnet-5-5`,
   through the gateway's provider): the people part up to 4 segments and about 180 words, the city
   part up to 3 and about 120. The instructions: only what the posts say (no invented facts,
   feelings, relationships, ages or numbers), people by their @handle, neutral and warm, no
   exaggeration, pressure, questions or exclamation marks, nothing about health, death, violence,
   sex, money trouble, politics or anyone's private difficulty; each segment lists the numbers of the
   posts it is about. Segments that cite nothing given, or that the safety check (`analyzeText`)
   flags, are dropped. Each call is in the AI audit log (task `today`, scopes `today:people` or
   `today:city`, never the words).
5. **Reading aloud.** Each segment goes through `speak()` (docs/product/speech-engine.md) in the
   person's language, counted against Today's own budget and the speech engine's. The city part is
   read once and its clips are shared.
6. **Serving.** A segment shows only while the person can still see every post it cites: a post
   deleted, hidden or from someone they blocked since takes its segment with it. "Not interested in
   this" hides only that segment in today's.

**Shared city part.** Made once per city (the profile's city, lower-cased), local day and language
(`today_city_segments`), by whoever needs it first, and copied into each neighbour's Today, filtered
for them. A neighbour who blocked one of its authors simply doesn't get that segment.

## API

| Route | What |
| --- | --- |
| `GET /v1/today?tz=` | This morning's Today, `{ today: TodayBriefing \| null }`, made now if it's due. `tz` is the device's time zone (kept for the morning sweep). 30 a minute. |
| `GET /v1/today/:id` | One of your briefings by id (for Yap Radio to play). 404 for anyone else's. |
| `POST /v1/today/:id/segments/:index/not-interested` | Takes that segment away and tunes the next ones. Returns the briefing as it is now. |
| `POST /v1/today/:id/dismiss` | Hide until tomorrow. |
| `GET`, `PUT /v1/me/today` | Settings: `{ enabled, hour, city, notify, timezone }` (hour 5 to 11). |
| `GET /v1/flags` | `today`: the flag is on and a real model is set (or not production). |

`TodayBriefing { id, day, lang, dev, createdAt, segments: [{ index, kind: 'people' | 'city', text,
audioUrl | null, sources: [{ postId, username, displayName, voice: { id, url, durationMs } | null }] }] }`.
**Yap Radio** can play it as it is: each segment's `audioUrl`, then (or instead) its sources'
`voice.url`.

## Data

- `user_preferences.today`, `today_hour`, `today_city`, `today_notify` (null means the default).
- `today_briefings`: one per person and local day: the segments (text, the post ids they cite, the
  clip's address), `empty` (nothing to say, so it isn't tried again), `hidden`, `dismissed_at`,
  `notified_at`. Deleted after 7 days, with the account, and their clips go with them (a trigger
  forgets their uses; the speech sweep deletes clips nothing is for).
- `today_city_segments`: the shared city parts, deleted after 7 days the same way.
- `today_feedback`: "Not interested in this" (who, about whom, which post), kept 30 days.
- `today_budget`: scripts and characters per UTC day.
- The data export has `ai.todayBriefings`, `ai.todayNotInterested` (people by username) and the
  settings under `settings.preferences`.

## Cost controls

| Control | Default | Past it |
| --- | --- | --- |
| `TODAY` flag | on | No Today for anyone |
| A real model | `AI_PROVIDER=anthropic` with a key | With the stand-in, nothing in production |
| `TODAY_DAILY_LIMIT` | 5,000 new scripts a day (UTC), everyone together (a city part counts once) | No new Todays until midnight UTC, quietly (nothing is shown, nothing kept, so it can be made later) |
| `TODAY_TTS_DAILY_CHAR_LIMIT` | 100,000 characters read out a day (UTC), within `TTS_DAILY_CHAR_LIMIT` | New Todays are text with the original Yaps |
| Who gets one in advance | people active in the last 7 days | Others only when they open Pulse |

## Rough cost per active person per day

Prices change; check them when signing up. With Claude Sonnet 5.5 at $2 per million input tokens
and $10 per million output tokens, and text-to-speech at about $15 per million characters:

- **The people part**: about 1,500 tokens in (instructions and 10 to 20 short items) and 400 to 600
  out (the segments as JSON, a little thinking at low effort): about **$0.008 to $0.009**.
- **The city part**: the same once per city and language, shared by everyone there: a fraction of a
  cent per person in any city with more than a handful of listeners.
- **Reading aloud**: about 1,000 characters for the people part: about **$0.015**. The city part's
  clips are made once.

So about **$0.02 to $0.025 per active person per day** with the voice (roughly $0.60 to $0.75 a
month), and about **$0.01** as text only. The defaults cap the whole thing at roughly $45 a day for
scripts and $1.50 a day for reading aloud; raise `TODAY_TTS_DAILY_CHAR_LIMIT` (and
`TTS_DAILY_CHAR_LIMIT`) to give more people the spoken version: about $15 a day per 1,000 listeners.

## Tests

`apps/api/test/today.test.ts`, with a stand-in model and voice: only visible items go in (blocks,
private accounts, squads that aren't yours, held posts and held Yap words, minors for adults, muted
people), sources and Yap clips, the language, one per day, the shared city part (made and read
once, filtered per neighbour), sources that disappear, "Not interested in this" (now and next time),
owner only, the chosen hour and Hide, the morning sweep for active people with the notification
only when asked for and lazy making for the others, turning it off, both budgets, no voice, the flag
and the stand-in in production, the data export and the audit log.
`apps/web/e2e/today.spec.ts` (API against `e2e/today-stub.mjs`): the card appears on Pulse, Play
reads the first segment and moves to the second by itself, "Hear @bola" plays the original Yap, "Not
interested in this" takes a segment away, and axe passes on the card in light and dark.

## Later

- Yap Radio plays a Today as its first item (`GET /v1/today`).
- A spoken opening line ("Good morning…") in each language, once there's a cached clip per language.
- Better city matching than the profile's city text (areas from the city map).
