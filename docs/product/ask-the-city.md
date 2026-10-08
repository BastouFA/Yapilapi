# Ask the city

Ask a question out loud ("Best suya in Yaba?", "Is Third Mainland jammed?", "Who fixes iPhones near Ikeja?") and people nearby
answer by voice or in writing. Live local knowledge that search engines don't have.

Behind the `ASK_CITY` flag (on). Migration `0092_ask_city.sql`. Code: `packages/shared/src/ask-city.ts` (types, limits and pure
helpers the phone uses), `packages/shared/src/ask-city-schemas.ts`, `apps/api/src/lib/ask-city.ts`, `apps/api/src/modules/ask-city.ts`,
`packages/design-system/src/ask-city.tsx` (what a question post shows), `apps/web/app/(app)/ask/page.tsx`,
`apps/web/components/AskCity.tsx`, `apps/mobile/app/ask.tsx`, `apps/mobile/lib/ask-city.tsx`. The phone screen is type-checked but not yet
run on a device. Tests: `apps/api/test/ask-city.test.ts`,
`packages/shared/src/ask-city.test.ts`, `apps/web/e2e/ask-city.spec.ts`.

## Built on what was there

- **Yaps** (docs/product/yaps.md): a spoken question is a Yap, with its clip, waveform, transcript, translation and "Listen in …".
  A written one is a text post. Either way it's a post for everyone, so feeds, reports, translation, export and deletion work.
- **Comments and voice replies** are the answers: moderated, reported, translated and blocked like any comment.
- **Near you** (docs/product/city-map.md): place pages for the area, the map's view for "this part of the map", and the layer
  system for a **Questions** layer.
- **"Ask me"** (questions to one person, `/questions`) stays what it is: a question box on a profile. Ask the city reuses its
  question icon and the "help" glyph, not its tables; the two never mix.

## What people can do

- **Ask.** Web `/ask` (and "Ask a question" on Near you, which brings the part of the map on screen), phone Ask the city screen.
  Say it (the Yap recorder, up to a minute, with an optional line) or write it (up to 280 characters). Choose a topic: food,
  traffic, services, safety, events, shopping, other. Choose where: your city (the profile's, or one typed), a place page, or,
  from the map, "this part of the map". Choose how long it's open: no time limit (listed for 14 days), 1 hour, today (the end of
  your day), this week. Traffic questions close after an hour unless you choose otherwise.
- **Find questions.** Open questions in your city (the one you help in, else the profile's), in a city you search for, or with
  their area in the map's box; those still waiting for an answer first, then the newest; filtered by topic. "Your questions"
  lists yours, open or closed. Links from Wander, Pulse's Yaps filter and Near you.
- **Answer** under the question, by voice or in writing (comments). Answers are translated automatically like any comment.
- **Helpful.** The asker marks one or more answers helpful (a toggle under each answer). Helpful answers come first in Top, show
  a "Helpful" label, and the person who answered is told once.
- **Helped N people in Lagos.** A quiet line on the profile of someone whose answers people found helpful: the number of different
  people who marked one, in the city where that number is highest. No leaderboard, no ranking, no streaks. It names a city, so on
  an under-18's profile only they see it.
- **Help answer questions near me** (off by default): pick topics; at most 3 notifications a day about new questions in your city.
- **On the map.** The Questions layer pins open questions at their area (a place page's point, the map's middle on a 2 km grid, or
  the middle of the city's place pages); the card says how many answers it has, or that it needs one.
- **In the feed.** About one slot in 15 in For you and the Yaps filter is an open question in your city that you haven't answered
  ("A question near you"). The Yaps filter takes spoken questions only.

## Data model

`ask_city_questions` (one row per question post): `post_id`, `author_id`, `topic`, `city` and `city_key` (lower case, matched on),
`area` (a place's name, or null for the whole city), `place_id`, `lat`/`lng` (the area's point or null), `expires_at`.
`ask_city_helpful` (one row per helpful answer: the answer, the question, who answered, who asked, the city).
`ask_city_helpers` ("Help answer questions near me": city and topics; no row means off).
`ask_city_notified` (who was told about which question: nobody twice, and the daily cap).
Posts carry `Post.askCity` (topic, city, area, place, end, open, answers, helpful); comments `Comment.helpful`; profiles
`Profile.localHelper`.

## API

- `POST /v1/ask` `{ topic, body, voiceId?, area: { placeId? | city? | box? }, expires?, timeZone? }`: at most 10 a day each
  (`ASK_PER_DAY`), 20 a minute. A box keeps only its middle on the 2 km grid (`askAreaPoint`), and its city is the one most place
  pages there are in when none is given; nothing usable falls back to the profile's city, else "Choose a place or a city for
  your question."
- `GET /v1/ask?city|south&west&north&east&topic&cursor`: open questions; `city` in the answer is the city listed.
- `GET /v1/ask/mine`.
- `PUT` and `DELETE /v1/ask/:id/helpful/:commentId`: the asker only, never their own answer.
- `GET`, `PUT /v1/me/ask-settings` `{ on, city?, topics? }`.
- `GET /v1/map?layers=questions`, and comments as usual (`POST /v1/posts/:id/comments` with `voiceId` for a spoken answer).

## Safety and privacy

- **Area only.** Never the asker's position: a place page (public already), a city, or the map's middle on a 2 km grid (with "Use
  my location" the map is centred on the person, so the middle itself is never kept).
- **Moderation.** A question goes through every check a post does (`screenPost`): harmful words are refused, flagged ones held with
  a moderation case. A spoken question's transcript is checked like a Yap's; until it passes, the question isn't listed, mapped,
  put in feeds or notified (`askListedSql`: `postVisibleSql`, moderation `normal` and `yapDistributableSql`; the asker always sees
  their own). Answers are comments, voice answers transcribed and checked like voice replies.
- **No hunting people.** Questions that ask where someone lives are refused ("Ask about places and things, not where someone
  lives."); questions and answers can be reported like posts and comments; the daily limit slows misuse.
- **Safety topic.** A note on the form and on the question: "If someone is in danger right now, call your local emergency number.
  Answers here come from people nearby, not from emergency services." The app has no local emergency numbers, so none are named.
- **Who sees what.** Every list, the map and the feed use the post's visibility (blocks both ways, private accounts' questions
  for their followers, regional rules). Notifications and feed slots only reach people of the asker's age group (adults and people
  under 18 never reach each other this way, unless family-linked), never anyone blocked either way, only people who may see the
  question, and never during quiet hours (theirs or a guardian's: those are skipped, not delayed). The Communities notification
  category turns them off; the helpful notice is in Creators.

## Notifications

`ask_nearby` ("New question in Yaba, Lagos: Food", category communities) from the job `ask.city.notify`, queued when a question
is asked; a spoken question whose words aren't back yet is looked at again every 30 seconds (up to 20 times). At most 500 people
per question. `ask_helpful` ("Ada found your answer helpful", category creators). Both open the question with its answers.

## Not done yet

- Closing a question early ("I've got my answer") and editing its topic or area.
- A neighbourhood name for map-area questions (they show the city).
- Notifications by distance (they go by city).
