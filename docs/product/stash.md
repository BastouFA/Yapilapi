# Stash: hide something at a real place

Step 1 of "Your city, alive" (docs/product/your-city-alive.md). You hide a note, a photo, a short
video, a song, a voice note or a gift at a real place, and it only opens for someone who is there.

The code: `packages/shared/src/stash.ts` (constants, types, the opening and rounding maths, launch
cities, notification words), `packages/shared/src/stash-schemas.ts`, `apps/api/src/lib/stash.ts`,
`apps/api/src/modules/stash.ts`, migration `packages/database/migrations/0094_stash.sql`. Web:
`app/(app)/stash/` (the Stash page, `new`, `[id]`), `components/Stash.tsx`, the Near home
`app/(app)/near/page.tsx`. Phone: `app/stash/`, `lib/stash.tsx`, Near in `app/(tabs)/index.tsx`.
Tests: `apps/api/test/stash.test.ts`, `packages/shared/src/stash.test.ts`, `apps/web/e2e/stash.spec.ts`.
Behind the `STASH` flag (on by default).

## 1. Hiding

- **You must be there.** The app sends where the device is now and how sure it is. The server
  refuses a position less accurate than 100 m ("Your location isn't accurate enough yet. Move
  outside or wait for a better GPS signal."). The position is read only when you tap "Hide it here".
- **What goes in** (`kind`): a note (up to 500 characters), a photo or a video (your own upload,
  processed, not blocked or sensitive; a video up to a minute), a song (from the music picker: a
  library sound or a catalogue song, checked like a post's music), a voice note (a clip recorded
  like a Yap, used once) or a gift (a short code or words revealed on opening, such as a promo code;
  just text, no payments). Any kind can have a line of words too, a title (60) and a hint (140,
  "Under the big tree").
- **Who can open it**: one person (a friend or someone who follows you back), your friends, a squad
  you're in, or everyone.
- **How long**: 24 hours, 7 days, or no end (until you take it back). **How many**: everyone who
  finds it, or the first finder only.
- **Limits**: 20 a day each; 30 hide requests an hour.
- **Moderation**: the title, hint, words and gift are checked like a post's (lib/moderation.ts):
  words that put someone at risk are refused; others that need a look hold the stash (`review` or
  `restricted`) with a case in the moderation queue. A held stash can't be found by anyone but you.
  A voice note's words are transcribed and checked like a Yap's (lib/voice.ts): until they're back
  and passed the stash can't be found, and words that don't pass hold it with a case. A photo or
  video blocked or marked sensitive later makes it unfindable too.

## 2. Where it is stays private

- The exact point is kept (`stashes.lat`, `lng`) for one thing: opening. It is in no answer to
  anyone but the person who hid it (and moderators, in the queue's excerpt, to judge "It's at my
  home"): not on the map, the list, the stash's page, opening, notifications, search, or another
  person's data export. The tests check each.
- Everyone else gets the **area**: a point a random distance (up to 35 m) and direction from the
  spot, chosen once when it's hidden and kept (`area_lat`, `area_lng`), so asking again never
  narrows it down and the spot isn't the area's middle. The apps draw it as an area 100 m across and
  say "About 300 m away", worked out from the area on the device (the list's distances are to the
  area too, in 50 m steps).
- **Private stashes** (one person, friends, a squad) are invisible to everyone outside their
  audience: not even the area.
- **Opening says how far is left**, rounded up so it never says exactly where (10 m steps under
  100 m, 50 m under 500 m, 100 m under a kilometre; further: "Not here yet. Keep looking nearby").
  Combined with the limits below, walking around is the only way in.

## 3. Finding and opening

- **The map**: a Stashes layer on Near you (and the Near home), using the layer system:
  candidates by area are cached per part of the city for everyone; which of them this viewer may
  find is worked out every time (`stashVisibleSql`). Signed out: no stashes.
- **The list**: "Stashes near you" (`GET /v1/stashes/near`), nearest first by area, within 5 km;
  first-finder stashes someone else opened are left out.
- **Opening** (`POST /v1/stashes/:id/open`, with the position now): it opens within 50 m of the
  spot, with some of the device's accuracy counting in the finder's favour (distance − min(accuracy,
  30) ≤ 50). Not yet: "Get closer, about 120 m to go".
- **Anti-spoofing basics**: a position less accurate than 100 m is refused; the last few positions
  someone hid or opened from are kept for at most an hour (`stash_location_samples`, deleted by the
  job worker's minute sweep, at most 5 each), and a jump of more than a kilometre faster than
  300 km/h since the last one is refused ("Your location moved too far, too fast"); 12 open attempts
  a minute each.
- **First finder only** is atomic: the stash's row is locked while the find is written, so two at
  once can't both open it ("Someone found this one first").
- **On opening**: what's inside shows, the find is recorded, and whoever hid it gets a grouped
  notification ("Ada found your stash", "Ada and 2 others found your stash"; category friends,
  respecting their settings, pauses, quiet hours for pushes and blocks). The finder can send back a
  thank-you once: one of four quick ones (Thanks, Love it, Made me laugh, Wow; icons, no emoji) and
  up to 140 characters, checked like a comment ("Ada thanked you for your stash"). The team's
  stashes notify nobody.

## 4. Explorers

- **On profiles**: "Stashes found: 12 · Hidden: 5" and badges (first find, 10 finds, 50 finds,
  finds in 3 cities). Hidden from others with "Show my stash counts on my profile" off.
- **Top explorers**: on the Stash page, this month's most finds in Lagos, Lomé or Paris (top 10),
  among adults who left "Show me in explorer lists" on (on by default for adults, always off under
  18, unknown ages left out), nobody blocked with the viewer. Friendly words, no streaks, no pressure.

## 5. Safety

- **Minors**: someone under 18 only sees and opens stashes from friends and family-linked adults,
  and other under-18s' public stashes. An adult's public stash is for adults (and their under-18
  friends); an adult can't hide one for an under-18 they aren't friends with (or family-linked to).
  The team's launch stashes are for everyone. Unknown ages count as adults, as for messages.
- **Blocks** either way hide everything: stashes, finds, explorer counts and lists.
- **Reports** (`targetType: 'stash'`, by anyone who can find it): the usual reasons, plus "It's at my
  home or another private place" (offered for stashes only), which hides the stash at once
  (`restricted`) and puts it at the top of the queue until a moderator decides. Minor-safety
  reports hold it too. Moderators can remove a stash from the queue's decision, or directly
  (`DELETE /v1/admin/stashes/:id`); the queue shows its words, photo or video and its exact point.
- **Seed mode** (admins): `POST /v1/admin/stashes` places a stash for everyone at a chosen point,
  without being there, shown as "Hidden by YAPILAPI" with no person's name (for launch seeding in
  Lagos, Lomé and Paris). On the web it's a "Launch stashes" option on the hide form for admins;
  `GET /v1/admin/stashes` lists them with their points.

## 6. New stashes near you

Opt-in, off by default ("Tell me about new stashes near me, at most once a day"): at most one
notification a day, "3 new stashes near you today", counting stashes hidden in your profile's city
since the last one that you may find and haven't opened. Never during quiet hours (yours or a
guardian's); the sweep runs with the job worker.

## 7. Data

- **Export**: your stashes with their exact points (they're yours), the stashes you found (who hid
  them, never where exactly), who found yours and what they sent back, and the positions kept from
  the last hour.
- **Deleting your account** deletes your stashes (and their finds), your finds and your positions.
- Stash media is kept from the unused-media cleanup while its stash is up.

## 8. The API

| Route | What |
| --- | --- |
| `POST /v1/stashes` | hide one here |
| `GET /v1/stashes/near?lat&lng` | stashes near a point, by area |
| `GET /v1/stashes/mine` | yours (with points) and the ones you found |
| `GET /v1/stashes/:id` | its page; yours: who found it |
| `POST /v1/stashes/:id/open` | open it from here, or how far to go |
| `POST /v1/stashes/:id/thanks` | finders: a thank-you |
| `DELETE /v1/stashes/:id` | take yours back |
| `GET /v1/stashes/explorers?city=` | this month's top explorers in a launch city |
| `GET /v1/users/:username/explorer` | someone's counts and badges, or null |
| `GET`, `PUT /v1/me/stash-settings` | the three settings |
| `POST`, `GET /v1/admin/stashes`, `DELETE /v1/admin/stashes/:id` | seed mode and removal |

## 9. Not done yet

- The phone screens are type-checked but not run on a device (location accuracy, the music and
  voice pickers inside the hide screen).
- Seed mode has no phone screen (admins use the web).
- A video on the phone opens in the system player rather than inline.
- Stronger anti-spoofing (device attestation, mock-location detection on Android) is for later.
