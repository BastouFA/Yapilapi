# Yap Radio: your personal radio station

Press play once and listen hands-free: one Yap after another, like radio, all in your language. Yap
Radio is built on Yaps (docs/product/yaps.md) and the speech engine (docs/product/speech-engine.md).

Behind the `YAP_RADIO` flag (on; Yaps' `YAPS` flag must be on too). Migration `0091_yap_radio.sql`.
Code: `packages/shared/src/radio.ts` (types, limits, pure helpers the phone uses),
`apps/api/src/modules/radio.ts`, `apps/web/components/Radio.tsx` (provider, bar, "Play as radio"),
`apps/web/app/(app)/radio/page.tsx`, `apps/web/app/radio.css`, `apps/mobile/lib/radio.tsx`
(provider, bar above the dock, "Play as radio"), `apps/mobile/app/radio.tsx`. Tests:
`apps/api/test/radio.test.ts`, `apps/web/e2e/radio.spec.ts`.

## Stations

| Station | What plays | Order |
| --- | --- | --- |
| For you (the default) | The recommender's Yap ranking, as the Yaps filter on Pulse (`RankSurface 'radio'`, kept for the next pages in `feed_sessions`) | Ranked |
| Friends | People you follow and your friends | Newest first |
| Near you | Yaps tagged at places within 25 km of where you are (the apps send a position rounded to about 100 m, only when location is already allowed or you pick Near you), or in your profile's city | Newest first |
| Topics | The #tags you follow, or the one you picked ("Play as radio" on a tag page) | Newest first |
| A squad | Your squad's Yaps (members only) | Newest first |
| A person | One person's Yaps ("Play as radio" on a profile) | Newest first |
| A place | The Yaps tagged at one place ("Play as radio" on a place page) | Newest first |

`GET /v1/radio` lists the stations offered to you: the four main ones, your squads and the tags you
follow. With no city and no position, Near you answers `needsPlace` and the apps say how to give one.

## Who hears what

Every station plays only Yaps the listener may see and open: audiences (followers, friends, circles,
chosen people, subscribers, squads), blocks either way, private accounts, regional withholdings,
moderation (removed, restricted, under review for minors), mutes and "not interested", a clip that
was blocked. On top of that:

- **Never twice.** A Yap you finished anywhere (`listen_complete`) never plays again; one you quickly
  skipped on the radio (`skip`, surface `radio`) doesn't for 7 days (`RADIO_SKIP_DAYS`). Within a
  session the cursor never repeats one, and the apps also skip duplicates.
- **Held words never play.** A Yap whose transcript was held by the checks is left out of every
  station (its author still hears their own on their profile's station).
- **Beyond the people you follow, only what may be suggested.** For you, Near you, Topics, a place,
  and the profile of someone you don't follow, play only Yaps whose words passed the checks or will
  never have any (`yapDistributableSql`), as the recommender does. Friends, a squad and the profile of
  someone you follow play their Yaps as Pulse would.
- **Your own Yaps** play only on your own profile's station.

## Listening

- **Hands-free.** When a Yap ends, a short quiet (`RADIO_GAP_MS`), then the next. More Yaps are asked
  for before the queue runs out (on Data saver, only once it has).
- **Where you left off** is kept on the device (station, Yap and position; the web in `localStorage`,
  the phone in the secure store) and picked up for a week: the station is asked for again with
  `start`, which puts that Yap first when it still belongs there.
- **Controls.** Play and pause, back (to the start of the Yap, or the one before within 3 seconds),
  next, scrub the waveform, speed (1×, 1.5×, 2×), like, reply by voice (the voice reply recorder opens;
  the radio pauses), follow, a sleep timer (15, 30 or 60 minutes; the radio pauses at the end),
  "Listen in my language".
- **In your language.** The transcript follows the words being spoken (scrolling with them) and shows
  in your language when you don't understand the speaker's (TranslatableText rules: automatically
  when "Translate automatically" is on, otherwise "See translation"). With "Listen in my language" on
  and listening offered (`voice.listen`), a Yap in a language you don't understand plays read out in
  your language (`POST /v1/voice/:id/speech`) instead of the original; otherwise the original voice
  plays with the translated words.
- **Data.** Data saver: nothing loads ahead. Otherwise only the next Yap's clip loads ahead. The Radio
  page shows about how much was used this session (clips are about 240 KB a minute).

## Web

A bar across the bottom of every page of the app shell while the radio has a Yap (above the dock on
phones, at the foot of the main column on wide screens): who's speaking, the station, play or pause,
next, stop, and the way to the Radio page (`/radio`). The provider sits in the app shell's layout, so
the sound keeps going from page to page (and into Yap mode and back). The operating system's media
controls (lock screen, headphones, media keys) work through the Media Session API: play, pause,
next, previous, seek 10 seconds, stop. Keyboard, when nothing else on the page has the key (not on
Reels, lives, watch together or rooms): space plays or pauses, → or J goes to the next Yap, ← or K
goes back. Another sound starting on the page (a Yap card, a video) pauses the radio, and the radio
starting pauses it.

## Phone

The same, with the bar just above the dock on the tab screens and the Radio screen as a stack screen.
Background playback: the audio session plays in the background while the radio is on (`doNotMix`), and
the lock screen and control centre show the Yap with play, pause and seek (expo-audio offers no
next-track command there). iOS: `UIBackgroundModes` `audio` (already set). Android: expo-audio's
media playback foreground service; `app.json` now asks for it explicitly (`enableBackgroundPlayback`
in the expo-audio plugin, `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MEDIA_PLAYBACK`), without
which Android stops background audio after a few minutes. In the background the next Yap starts at
once (no quiet), so the session isn't ended between two clips. Phone builds are on hold: this is
typechecked, not yet tried on a device.

## Ranking

Listening on the radio is reported like any listening, with the surface `radio`: `impression` and
`listen_start` when a Yap starts, `listen` with how long it played, `listen_complete` at 90%, and
`skip` when the listener skips within 5 seconds (`RADIO_QUICK_SKIP_MS`), which counts against the Yap
(`post_stats.skips`) and teaches the recommender "not this" (with Personalization on).

## API

- `GET /v1/radio`: `{ stations: [{ kind, key, title }] }`. 30 a minute.
- `GET /v1/radio/:station?key=&cursor=&limit=&start=&lat=&lng=`: `{ station, items: Post[], following, nextCursor, needsPlace? }`
  (`following`: the speakers among them you follow). Up to 20 a page. 60 a minute.
- `POST /v1/feed/events` with surface `radio`.

## Entry points

A Radio button on Pulse's Yaps filter, Radio in Wander, and "Play as radio" on profiles, tag pages,
place pages and squads, on the web and the phone.
