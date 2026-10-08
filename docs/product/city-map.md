# Near you: the live city map

What's happening around you right now, on a map: lives at a place, events today and tonight, things for sale on Market, places
that are busy, Pass the Mic chains made nearby, and friends who are out. Reached from Wander (web `/map`, phone `map` screen).

The code: `apps/api/src/lib/city-map.ts` (the layers, the area cache, "Show me on the map to friends"),
`apps/api/src/modules/city-map.ts` (the routes), `packages/shared/src/city-map.ts` (types, tile and projection maths, clustering
and words both apps use), `packages/shared/src/city-map-schemas.ts`, migration `packages/database/migrations/0087_city_map.sql`.
Web: `apps/web/app/(app)/map/page.tsx`, `apps/web/components/CityMap.tsx`. Phone: `apps/mobile/app/map.tsx`,
`apps/mobile/lib/city-map.tsx`. Tests: `apps/api/test/city-map.test.ts`, `apps/web/e2e/city-map.spec.ts`. Behind the `CITY_MAP` flag
(on by default); the live layer also needs `LIVE`, the chains layer `PASS_THE_MIC`.

## 1. What was there to build on

| Thing | Where it is | What it gave the map |
| --- | --- | --- |
| Place pages (`places`, `/places/:id`) | public name, city, point (`lat`, `lng`) | the only exact points the map shows |
| Events | `events.place_id`, `starts_at`, `ends_at`, audience | Today: events at a place, on now or before midnight |
| Lives | `live_sessions` | had no place: 0087 adds `place_id` |
| Posts and reels | `posts` | had no place tag: 0087 adds `place_id` (shown on the post) |
| Pass the Mic | `reel_chains`, `reel_chain_links` | chains whose reels were made at a place |
| Market | `market_listings.approx_lat/lng`, snapped to ~1 km, never sent | listings by pickup area, moved to a 2 km grid |
| Live location in chats | `location_shares` (latest point only, deleted when it ends) | friends sharing with a chat you're in |
| Visibility | `lib/visibility.ts`, `lib/market.ts`, `lib/chains.ts` | every layer is filtered by the same rules as feeds |
| Map rendering | none: chat location cards draw their own pattern, "Open in maps" leaves the app | see section 5 |

So the study turned up two gaps: posts and lives couldn't name a place. Both now take an optional `placeId` (a place page; the
post or live shows it, and it can't be changed after posting, like media). Nothing else about how location is stored changed.

## 2. Layers

| Layer | What shows | Point on the map | Card |
| --- | --- | --- | --- |
| Live now | lives on now with a place | the place | title, place, host, started |
| Today | events at a place that are on now, or start before the end of the viewer's day (their time zone; events without an end count 3 hours) | the place | title, place, time |
| Market | listed things with a pickup point (not sold, not ended, not held) | the 2 km grid (`marketPoint`) | title, area, photo |
| Places buzzing | places where at least 3 different people posted publicly in the last 24 hours | the place | name, city, number of recent posts, the newest picture the viewer may see |
| Chains near you | active chains (a reel in the last 7 days) with reels made at a place here | the place most of them were made at | prompt, place, reels there, cover |
| Questions | open Ask the city questions with an area here (docs/product/ask-the-city.md), behind `ASK_CITY` | a place page's point, the map's middle on the 2 km grid, or the middle of the city's place pages | the question's words, area, asker, answers so far |
| Friends out | friends sharing a live location with a chat you're in, and friends who turned on "Show me on the map to friends" | always the 1 km grid (`friendPoint`) | name, avatar, until when; opens the chat or their profile |

Each layer gives at most 40 items (`MAP_LAYER_LIMIT`, the most relevant first) and the answer says which layers had more
(`more`): the apps say "There's more here. Zoom in to see it all."

## 3. The API

- `GET /v1/map?south&west&north&east&layers&tz`: the items in the box. Optional sign-in (signed out: no Friends out). At most 1
  degree each way (`MAP_MAX_SPAN`, about 100 km): a bigger box is refused with "Zoom in to see what's here." 60 a minute.
  `cache-control: private, max-age=15`.
- `GET /v1/map/center?city=`: where to start without the device's position: the middle of the place pages in the city searched
  for, or in the viewer's profile city. 30 a minute.
- `GET`, `PUT`, `DELETE /v1/map/presence`: "Show me on the map to friends" (section 4). 60 changes an hour.

**Caching per area.** Each layer is read in two steps. The candidates (ids and points) for the area around the box (the box
widened to a grid whose cells suit its size, so everyone looking at roughly the same part of a city shares it) are the same for
everyone and kept in memory for 30 seconds. Then, every time, never cached, the candidates this viewer may see, with their cards.
So a block, an unfollow or a removed post applies at once; a brand-new live can take up to 30 seconds to appear. Friends out is
never cached.

**Indexes** (0087): `posts (place_id, created_at)`, `live_sessions (place_id)` while live, `events (place_id, starts_at)`, places by
point (only those still up), `map_presence` by point and by end. Market already had one by point.

## 4. Privacy and safety

- **Where you are never goes to the server for the map.** The apps send only the box on screen; distances on cards are worked out
  on the device. The browser's position is asked for only when you tap "Use my location" (or allowed it before); the phone asks with
  a purpose string that says so. Without it: the profile's city, then a city search.
- **Only what you can already see.** Lives: `liveVisibleSql` (audiences, blocks, a teen's live only to their friends, guardian and
  teen followers). Events: `eventVisibleSql`, never link-only events. Market: `listingListedSql` (blocks, held and removed listings
  out). Places' pictures: `postVisibleSql` and `postUnlockedSql`, nothing sensitive. Chains: `chainsById` (blocks with the
  starter) and a reel made there that the viewer can see. Posts withheld by a regional rule in the viewer's country are left out
  like everywhere (postVisibleSql); a busy place's count is public posts only.
- **Blocks both ways** hide the other person's lives, events, listings, chains and their place on Friends out.
- **No exact home-like points.** The only exact points are place pages, which are public already. Market listings keep a point
  rounded to a kilometre, and the map moves them to a 2 km grid. Friends are always on the 1 km grid, even when they shared a
  precise point with the chat.
- **Friends out** is only ever friends: someone sharing a live location with a chat you are in now, or who chose "Show me on the
  map to friends". Not followers, not friends of friends. An adult and someone under 18 never see each other on it, unless one is
  the other's guardian through an active family link.
- **Show me on the map to friends** is off by default. You turn it on from the map, for 1 hour, 4 hours or until midnight (your time
  zone; never more than a day), and can stop it at any time. Only the point rounded to a kilometre is kept, one row per person, no
  history: stopping deletes it and the job worker deletes it when its time is up (`sweepPresence`, once a minute). Opening the map
  while it's on moves it to where you are now (the end stays). The data export says when it started and ends, never the place.
- **Rate limits** on every route (above).

## 5. The map itself: why tiles, and which

The app had no map library and no tiles (chat location cards draw a made-up street pattern on purpose). Adding one wasn't allowed
for this, and isn't needed:

- **Web**: a small tile layer of our own (`components/CityMap.tsx`): 256-pixel web-mercator tiles placed as `<img>`s, dragging,
  zoom buttons, the mouse wheel and the keyboard (arrows pan, + and - zoom), pins as buttons. The projection, tile and
  clustering maths are in `packages/shared/src/city-map.ts`, tested there.
- **Phone**: the same maths with React Native's own `Image` for tiles (with the app's user agent, as tile servers ask), drag to
  pan and buttons to zoom. No new dependency: `expo-location` was already there for chat location sharing.
- **Tiles**: OpenStreetMap's (`MAP_TILE_URL`), with "© OpenStreetMap contributors" linked on the map. OpenStreetMap's own servers
  are for light use, so a busy deployment sets its own provider: `NEXT_PUBLIC_MAP_TILE_URL` (web) and `mapTileUrl` in the phone
  build's `extra`. The tile servers see which tiles are loaded (the part of the map on screen), as any map does.
- **List first.** The same results are a list (nearest first) next to the map on wide screens and one tap away on phones: what
  screen readers and keyboard users get, and what shows if tiles don't load.

Pins close together on screen become one with a count (cells of 56 pixels); tapping one shows a small card (title, distance, time,
picture) that opens the item; a group lists its items.

## 6. Tagging a place

"Add a place" in the web composer (posts and reels, not community posts) and in the web's Go live form searches place pages
(`GET /v1/search?type=places`) and sends `placeId`. Posts show the place as a chip linking to its page (web and phone); lives
return it as `place`. A draft keeps its place.

## 7. Not done yet

- "Add a place" in the phone's go-live screen (the phone's Yap composer and Ask the city have one: `PlacePicker` in `apps/mobile/lib/city-map.tsx`).
- The phone screen is type-checked but not yet run on a device (dragging, tile loading).
- Places buzzing counts posts only; stories and check-ins could count too.
- A geocoder for cities without place pages.
