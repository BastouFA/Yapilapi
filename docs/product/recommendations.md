# How For you and Reels are recommended

For you and Reels are ranked by a recommender that learns from what each person actually does. It runs inside Postgres, with no extra service and no
machine learning library: a handful of tables, one ranking module and a list of weights you can tune. This page explains it in plain words.

The code: `apps/api/src/lib/ranking.ts` (candidates, scores, order, paging), `apps/api/src/lib/affinity.ts` (what is learned),
`apps/api/src/lib/post-stats.ts` (counts per post), `apps/api/src/modules/recommendations.ts` (the events the apps send), migration
`packages/database/migrations/0080_recommendations.sql`. Tests: `apps/api/test/recommendations.test.ts`.

## 1. Signals: what the apps report

The web and phone apps report what happens to posts on screen, in batches every few seconds and when the app is closed or goes to the background
(`apps/web/lib/feed-events.ts`, `apps/mobile/lib/feed-events.ts`, sent to `POST /v1/feed/events`):

| Event | When |
|---|---|
| impression | at least half of a post was on screen for a second |
| dwell | how long it stayed on screen (sent when it leaves) |
| watch | how long a reel or video actually played |
| complete | a reel played to 90% or looped |
| skip | a reel was left within 2 seconds |
| share | the share sheet went through, or the link was copied |
| profile_open | the author's profile was opened from the post |

Each event says where it happened: for_you, reels, following, friends, communities, profile, tag, search or other.

The API keeps them honest: at most 50 per request and 120 requests a minute, posts the person can't see and their own posts are ignored, an
impression (and a finish, skip, share or profile visit) counts once per person, post and place in 30 minutes, time on screen counts up to a minute
per event and time watched up to three plays of the video (ten minutes at most). Events are kept 90 days.

The app also uses what already existed: likes, comments, saves, reposts (counted as shares), follows, and the feed feedback ("Show more", "Show
less", "Not interested", mute a topic or creator).

## 2. Counts per post

`post_stats` keeps, per post, impressions, people who saw it, time on screen, time watched, finished watches, skips, shares and saves, updated as
things happen. It also keeps the post's **momentum**: every like (1), comment (2), save (3), share (3) and finished watch (2) adds to it, and it fades
by e (about two thirds) every 6 hours. Momentum is what "trending now" means. These counts are about posts, not people, and count for everyone,
including people who turned Personalization off. The numbers people see under posts (views, shares, Rising) are built on them:
see docs/product/post-stats.md.

## 3. What is learned about each person (affinity)

For each person the recommender keeps a score per topic (a post's topics are its hashtags) and per creator. Every signal adds to the scores of the
post's topics and its creator:

| Signal | Topics | Creator |
|---|---|---|
| like | +1 | +1 |
| comment | +2 | +2 |
| save | +2.5 | +2.5 |
| share or repost | +3 | +3 |
| finished a reel | +1.5 | +1.5 |
| on screen 8 seconds or more | +0.5 | +0.5 |
| watched half or more | +0.8 | +0.8 |
| opened the profile from a post | | +0.7 |
| follow (from anywhere) | | +4 |
| skip | −0.6 | −0.6 |
| Not interested | −3 | −3 |
| Show more like this / Show less | +2 / −2 | |
| mute a topic or creator | −10 | −10 |

Unliking, unsaving and unfollowing take their amount back off. Scores fade with time: before each change the old score is multiplied by
exp(−days since the last change / 21), so something you did three weeks ago counts about a third as much as something you did today. Scores stay
between −10 and 30, so one evening of likes can't take over a feed.

The interests people pick when they join (and in settings) stay as their own signal, so a new account gets a sensible feed before anything is learned.

## 4. Candidates: where posts come from

Every time a feed is opened, a few thousand candidate posts are gathered from:

- **Your people**: your own posts, people you follow, friends, co-authors they posted with, and communities you're in (last 14 days; Reels 30).
- **Fresh**: the newest 1,000 posts of the last 14 days (Reels: the newest 2,000 reels).
- **Your interests**: the newest 300 posts on topics you picked.
- **Your topics**: the newest 300 posts on your 10 strongest learned topics.
- **Your creators**: the latest 10 posts (last 30 days) of each of your 50 strongest learned creators.
- **People like you**: the 100 people who most liked, saved or finished the same posts as you in the last 30 days (only people with Personalization
  on), and the 300 posts they engaged with most in the last 14 days that you haven't.
- **Trending**: the 300 posts with the most momentum in the last day.
- **Evergreen**: up to 100 posts 14 to 60 days old with a high engagement rate.
- **Not seen enough yet**: 200 recent posts from new creators (account under 30 days, or fewer than 5 posts) or with fewer than 50 impressions,
  that don't have 3 likes, comments and saves yet.

## 5. The score

Each candidate gets a score, the sum of (weights in `RANKING.weights`):

- **Your interests**: +1.2 per topic you picked, +1 per topic you asked to see more of, −2 per topic you asked to see less of.
- **Your learned topics**: up to ±2.5, rising with your scores for the post's topics (squashed so it levels off).
- **Your learned creator**: up to about +2.7 for a creator you engage with a lot, down to −3 for one you keep skipping.
- **Who it's from**: friend +3, someone you follow +2, a community you're in +1.5, your own post +1 (co-authors count like the author).
- **People like you**: up to about +2, by how strongly they engaged with it.
- **Quality**: the engagement rate, (likes + 2 × comments + 3 × shares + 3 × saves + 2 × finished watches) ÷ (impressions + 20). The 20 keeps a post
  with 2 likes out of 2 views from beating one with 200 out of 1,000.
- **Popularity**: a small amount for the plain number of likes and comments.
- **Momentum**: engagement in about the last six hours.
- **Reels only**: how often it's watched to the end and how often it's skipped, pulled towards normal values until a reel has been seen enough.
- **Freshness**: up to +4 for a brand-new post, fading over a day and a half.
- **Language**: a suggestion (not from people or communities you follow) in a language you don't understand: −0.4 when it reaches you
  translated ("Translate automatically", see `docs/product/speak-any-language.md`), −1.5 when you'd have to tap "See translation".
  Posts in any language can still reach you; ones you can read are mildly preferred.

With Personalization off, only quality, popularity, momentum, the reels rates and freshness count: everyone gets the same ranking.

## 6. What you already saw

A post you were shown in For you (or Reels) in the last 3 days is left out of that feed, unless it's from a friend or close friend and less than 12
hours old. A reel you watched to the end doesn't come back for a week. Seeing something in Following doesn't hide it from For you.

## 7. Order: exploration and variety

The posts go in score order, with these rules:

- **New creators get seen**: one slot in six goes to the best post (by its own engagement rate and freshness) from the "not seen enough yet" group,
  never from your own people. When it's from a new creator, its reason says "From a new creator on YAPILAPI".
- **One creator at a time**: a creator's posts after their first two score 1.5 lower each, so a busy account spreads out instead of filling the feed.
- **One topic at a time**: no more than 3 posts with the same main topic in any 10 in a row.
- **Formats mix (For you)**: after 2 videos, photos or text posts in a row, the next is another format when one scores almost as well (within 1
  point), so variety never lifts a much weaker post.

A post that doesn't fit waits for a place where it does; nothing is dropped. The feed has an end.

## 8. Paging

The first page ranks the whole feed (up to 1,500 posts) and keeps that order for a day (`feed_sessions`); the next pages read from it, so liking
and watching while you scroll never repeats or skips a post. Each page is checked again against who may see what and your filters, so someone you
block mid-scroll disappears at once. Opening the feed again ranks it again, with everything you did since.

## 9. Why am I seeing this

Every post in For you and Reels carries its strongest reason, which the apps show in the reader's language: your post, a friend, someone you follow,
reposted, a community you're in, a topic you picked, a creator you often enjoy, a topic you spend time on (Reels: videos you watch about it),
popular with people who like what you like, trending, a new creator, popular in a community, or popular. "Why am I seeing this?" lists every reason
that applies, including what was learned: creators and topics you engage with, people like you engaged with it, it's trending, it's from a new
creator.

## 10. Safety

The recommender only ever reorders posts the person may already see. Every rule of the other feeds applies before scoring: blocks (either way,
co-authors included), mutes and "Not interested", muted topics and creators, private accounts, audiences (followers, friends, circles, selected
people, subscribers), communities, drafts and scheduled posts, moderation (removed and restricted posts never; posts waiting for review not for
people under 18 or of unknown age), posts withheld in the viewer's country, echoes of reels they can't see, sensitive reels for people under 18,
"Fewer suggestions" (only your people and communities) and "Friends only".

## 11. Privacy

- Personalization off (Settings, Privacy): nothing is learned, what was learned is deleted at once, and For you and Reels are ranked the same for
  everyone. Events still count in each post's totals.
- Other people's activity is used only in aggregate ("people like you"), and only from people with Personalization on.
- The data download includes your feed activity per day and what was learned (topics and creators with their scores); deleting the account deletes
  all of it. Feed activity is deleted after 90 days, kept feed orders after a day.

## 12. Tuning

All the numbers are in one place each, with a comment per number:

- `RANKING` in `apps/api/src/lib/ranking.ts`: score weights, candidate sizes and windows, what counts as seen, exploration, variety rules.
- `AFFINITY` in `apps/api/src/lib/affinity.ts`: how much each signal teaches, how fast it fades, the limits.
- `TREND` in `apps/api/src/lib/post-stats.ts`: momentum weights and how fast it fades.
- `FEED_EVENT_RULES` in `apps/api/src/modules/recommendations.ts`: dedupe window and time caps.

Change this page with them. Some guidance:

- Too many posts from strangers above people you know: lower `quality`, `velocity` or `reach`, or raise `friend` and `follow`.
- Feeds feel stuck on one thing: lower `topicAffinity` or `creatorAffinity`, lower `AFFINITY.fadeDays`, or lower `diversity.topicMax`.
- New creators don't get seen enough: lower `exploration.every` (5 means one slot in five).
- Old posts keep coming back: lower `candidates.evergreen` or raise `evergreenRate`.

## 13. Scaling later

Every source is an index lookup with a limit, so a feed's cost depends on those limits, not on how many posts the site has. At today's size
(about 5,000 posts and 200 people) each feed takes tens of milliseconds. When it grows: move the "people like you" and "your topics" sources to a
precomputed table refreshed by the job worker, sample the "not seen enough yet" group instead of taking the newest, keep `post_stats` momentum in
Redis, and partition `feed_events` by month. None of that changes the scores or the apps.
