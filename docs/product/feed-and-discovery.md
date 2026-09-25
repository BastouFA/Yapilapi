# Discovery and NOW

Discovery helps people find things without an algorithmic feed doing it for them. Every list explains
itself (`reasons` / `explanation`), is bounded or keyset-paged, and honours blocks, mutes and topic mutes.

## Endpoints

- `/v1/discover/trending?window=1h|6h|24h|7d`: public posts by engagement velocity (reaction 1, comment 2,
  save 2, share 3; one actor counts once) over an age decay, at most 2 posts per author. Trending topics
  need at least 2 distinct authors. Private accounts, teens, "not interested" and hidden creators are excluded.
- `/people`: friends-of-friends, shared communities, shared interests, each with a reason. Excludes anyone
  already followed or friended, blocked, muted, non-discoverable. Teens only get contextual sources.
- `/suggested-follows`: onboarding; works from chosen `topics=` before interests are saved.
- `/creators`, `/communities`, `/topics`, `/places`, `/events`, `/products`, `/businesses`, `/local`.
- `/live`: behind flag LIVE. `/products` needs COMMERCE.
- `GET /v1/now`: behind flag NOW (404 `feature_disabled` when off).

## Cold start and personalization

New users with no graph get suggestions from the topics they pick (or popular creators). With
`personalization` off, no behavioural signal is used: generic popular results only.

## NOW privacy

NOW shows what is happening around, not who. Counts appear only for groups of at least 5 people
(k-anonymity), are rounded down to a multiple of 5, and only count adult, public-profile, discoverable
authors. The location the client passes is used for the query only: it is never stored or echoed. No
individual is ever listed (`privacy.individualsShown=false`).
