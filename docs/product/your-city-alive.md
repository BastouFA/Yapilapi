# Your city, alive

YAPILAPI's main identity, approved by the owner on 2026-10-24: **"Your city, alive." See what's
happening around you, find hidden surprises, and go do it with your people.**

It replaces "the social network you speak" (voice-first). Voice stays: Yaps, voice replies, Yap
Radio and Yapilapi Today are features people use, and a Yap is one of the ways in Create. What
changed is what the app is about and where it opens: the city around you, now.

## Launch cities

**Lagos, Lomé and Paris.** They are in `LAUNCH_CITIES` (`packages/shared/src/stash.ts`): the quick
picks when the device can't say where you are and the profile has no city, the explorer lists on the
Stash page, and where the team seeds the first stashes (seed mode). A point within 60 km of a launch
city's middle counts as that city.

## Three steps

1. **Stash, the city in Wander and the new menu** (built; this document and docs/product/stash.md).
   - **Stash**: hide a note, photo, short video, song, voice note or gift at a real place; it only
     opens for someone who is there. Others see only an area, never the spot.
   - **The city in Wander**: Wander opens on the city around you: the map (Near you, with a
     Stashes layer and the other layers) and "What's on now": stashes near you, lives, events
     tonight, busy places, open city questions and Market nearby. Under it, Wander's own sections
     (trending tags, chains, communities, events) and its search. Location is asked for only on a
     tap ("Use my location"); otherwise the profile's city, then the launch cities.
   - **The menu**: see below.
2. **Go out together** (later): plans with your people around what Wander shows.
3. **City first** (later): ranking by your city, a new landing page and onboarding, and sponsored
   hunts (businesses hiding stashes).

Steps 2 and 3 aren't built. The landing page and onboarding are unchanged until step 3; nothing on
the signed-in screens says the app is voice-first any more (the old tagline left Settings, About).

## The menu

**Pulse · Wander · Spark · Chats · You** on the web and the phone (the owner's pick, 2026-10-25; the
middle button was called Create with a ＋ until the owner asked for a better name and icon the same day).

- **Pulse** (the feed) is the first tab and where the app opens: after signing in, finishing
  onboarding or switching accounts the web goes to `/home` unless the sign-in link named another
  page; on the phone it is the first tab (`index`).
- **Wander** (`/discover`, the phone's `discover` tab) starts with the map and "What's on now"
  (`components/CityNow.tsx` on the web, `lib/city-now.tsx` on the phone), then its search and
  discover sections.
- **Spark** in the middle opens the ways to create: Hide a stash (first), Post, Reel, Story, Live
  (while lives are on) and Yap. Its icon is a bold four-point spark with a small light in its top
  corner, white on the raised brand-gradient button. Touched, the button squishes down; on a tap (or
  Enter or Space) it pops back with a little overshoot, the spark makes a quarter turn and flashes,
  its light circles it once, and a soft ring and six specks of coral and saffron burst out from
  behind it (about 0.6 s); the menu opens 180 ms into it. With reduced motion only a brief dimming,
  and the menu opens at once.
  The menu it opens is titled Create. The voice-first Yap button is gone from the middle.
- **Chats** and **You** as before.

For one day (2026-10-24) the menu was Near · Pulse · ＋ · Chats · You, with a separate Near home at
`/near` and Wander off the bar. Near's content moved into Wander; `/near` now redirects to
`/discover` (query included), and a `near` link on the phone opens Wander.

## Where it lives

| | Web | Phone |
| --- | --- | --- |
| Pulse | `/home` | first tab (`app/(tabs)/index.tsx`) |
| Wander, with the map and what's on now | `/discover` (`components/CityNow.tsx` at its top) | `discover` tab (`lib/city-now.tsx` at its top) |
| Create menu | `components/CreateMenu.tsx`, from Spark | Spark in `app/(tabs)/_layout.tsx` |
| Stash | `/stash`, `/stash/new`, `/stash/:id` | `stash`, `stash/new`, `stash/[id]` |

Links keep working: `/home` is Pulse, `/near` redirects to `/discover`, `/discover`, `/map`,
`/stash` and every other path are unchanged. The phone's first-launch tour of the dock points at
Pulse, Wander (the map and what's on now), Spark, then Chats and You, and shows once more
(`ypl_nav_tour_v3`).

Navigation glyphs (`packages/shared/src/nav-glyphs.ts`, drawn the same on web and phone): `pulse`,
`wander`, `spark` (the raised middle button: a `star` shape, four points with curved-in sides, and a
dot; on the phone the star is four clipped rings, plain Views) and `yap` for Chats; `near` (a pin on
the ground) is from the Near tab and no longer in the bar. Message keys: `nav.create` says "Spark"
("Étincelle", "Funke", ...; it said "Create" for a few hours on 2026-10-25), `nav.hint.create` lists
the ways to create and `create.title` ("Create") titles the menu, in all 24 languages; Wander's map part reuses the
`near.*` keys ("What's on now", the intro, "Or pick a city", the empty note).
