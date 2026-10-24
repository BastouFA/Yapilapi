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

1. **Stash, the Near home and the new menu** (built; this document and docs/product/stash.md).
   - **Stash**: hide a note, photo, short video, song, voice note or gift at a real place; it only
     opens for someone who is there. Others see only an area, never the spot.
   - **Near**: the first tab and where you land after signing in. The city map (Near you, with a
     Stashes layer) and "What's on now": stashes near you, lives, events tonight, busy places, open
     city questions and Market nearby, with search and Explore (Wander) at the top. Location is
     asked for only on a tap ("Use my location"); otherwise the profile's city, then the launch
     cities.
   - **The menu**: Near · Pulse · ＋ · Chats · You. The ＋ in the middle opens the ways to create:
     Hide a stash (first), Post, Reel, Story, Live (while lives are on) and Yap. The voice-first Yap
     button is gone from the middle.
2. **Go out together** (later): plans with your people around what Near shows.
3. **City first** (later): ranking by your city, a new landing page and onboarding, and sponsored
   hunts (businesses hiding stashes).

Steps 2 and 3 aren't built. The landing page and onboarding are unchanged until step 3; nothing on
the signed-in screens says the app is voice-first any more (the old tagline left Settings, About).

## Where it lives

| | Web | Phone |
| --- | --- | --- |
| Near | `/near` (`app/(app)/near/page.tsx`) | first tab (`app/(tabs)/index.tsx`) |
| Pulse | `/home` (unchanged) | `home` tab (`app/(tabs)/home.tsx`, was `index`) |
| Explore (Wander) | `/discover`, from Near's header | `discover`, from Near's header (off the dock) |
| Create menu | `components/CreateMenu.tsx`, from the ＋ | the ＋ in `app/(tabs)/_layout.tsx` |
| Stash | `/stash`, `/stash/new`, `/stash/:id` | `stash`, `stash/new`, `stash/[id]` |

Links keep working: web `/home` is Pulse on both, `/near` opens the phone's first tab, `/discover`,
`/map` and every other path are unchanged. After signing in (and switching accounts, finishing
onboarding) the web goes to `/near` unless the sign-in link named another page. The phone's
first-launch tour of the dock was updated and shows once more.

Navigation glyphs (`packages/shared/src/nav-glyphs.ts`, drawn the same on web and phone): `near`
(a pin on the ground) and `add` (the plus in the raised middle button). Message keys: `nav.near`,
`nav.hint.near` are new; `nav.create` now says "Create" and `nav.hint.create` lists the ways to
create, in all 24 languages.
