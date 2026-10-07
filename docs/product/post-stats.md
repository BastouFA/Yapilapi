# The numbers under posts, reels and stories

Every post and reel shows how people responded to it: views, likes, comments, reposts and shares. Creators can hide the like and view counts,
posts that are taking off get a small "Rising" badge, authors are told when a post passes a milestone, and posts say which of your people
liked them. This page says what each number means and the rules behind them.

The code: `apps/api/src/lib/posts.ts` (what each post carries, `countsOf`, `likedBy`), `apps/api/src/lib/rising.ts`,
`apps/api/src/lib/milestones.ts`, `apps/api/src/lib/post-stats.ts` (counts per post), `apps/api/src/modules/recommendations.ts`
(`recordShare`, views from feed events), `packages/shared/src/post-stats.ts` (short numbers, milestone words), migration
`packages/database/migrations/0082_post_numbers.sql`. Tests: `apps/api/test/post-stats-display.test.ts`.

## 1. What each number counts

| Number | What it counts | Where it's kept |
|---|---|---|
| Views | Different people, other than the author, who had the post on screen (half of it for a second, the feed's impression) or watched the reel or opened it. Each person counts once. | `post_views` (one row per person) and `posts.view_count` |
| Likes | People who like it now (an unlike takes one away). | `reactions`, `posts.like_count` |
| Comments | Comments that are up. | `posts.comment_count` |
| Reposts | People who reposted it to their followers. | `post_reposts`, `posts.repost_count` |
| Shares | Times it was sent into a chat, through the share sheet, or as a copied link: once per person, post and place in 30 minutes. Reposts are not in it. | `post_stats.sends` |

Views are not raw impressions: someone who scrolls past a post five times is one view. Raw impressions, time on screen and the like stay in
`post_stats` for the recommender (docs/product/recommendations.md). `post_stats.shares` there also counts reposts, because for ranking a repost
is a share; the number people see is `sends`.

Who saw a post is forgotten after 395 days (lib/retention.ts); the count stays. Someone who sees the post again after that counts again.

The apps write numbers short in the reader's language (1.2K, 3,4 k, 12 M; `compactCount`) and give screen readers the whole number
("1,234 views").

## 2. Stories

The owner of a story sees its views, likes, replies (messages answering it) and shares (times it was sent into a chat or added to someone's
story). Everyone else sees only the like count, and only when the owner hasn't hidden like counts. Who viewed and who liked stays the owner's
alone, as before.

## 3. Hiding like and view counts

"Hide like and view counts" is a setting for the account (Settings, Privacy, Sharing: `profiles.hide_counts`) and for each post (the composer's
options, and the post's menu for its author: `posts.hide_counts`, `PUT /v1/posts/:id/counts`). A post's own choice wins; without one it follows
the account, so changing the setting changes the older posts too.

When they're hidden the API leaves `counts.likes` and `counts.views` out for everyone but the author, everywhere a post goes (feeds, the post,
profiles, reels, link previews, the answer to a like or a view) and leaves out story like counts. The author still gets them, with
`countsHidden: true` so the apps can say only they can see them. Comments, reposts and shares stay shown. "Liked by" isn't shown either.

## 4. Rising

A post or reel is Rising when, right now:

- its momentum (`post_stats.trend`, faded to now: each like adds 1, comment 2, save 3, share 3 and finished watch 2, and the total fades by e
  every 6 hours) is in the top 5% of all posts that had momentum in the last 48 hours,
- that momentum is at least 5, and
- at least 20 people have viewed it.

The top-5% cut-off is worked out with one query over the posts with momentum in the last 48 hours (the `post_stats_trend_idx` index), at most once
every 5 minutes per API instance, and kept in memory; each post is then compared with numbers its own query already reads. The numbers are in
`RISING` (lib/rising.ts). The apps show a small "Rising" badge with an accessible label.

## 5. Milestones

When a post's views or likes pass 100, 1,000, 10,000 or 100,000, its author is told: "Your reel passed 1,000 views". Each milestone of each post is
written once to `post_milestones` before telling anyone, so it's told exactly once, even when two people push it over together, and never again
after an unlike and a new like. A post that passes several at once tells only the highest. Milestones a post had already passed when this came out
were written without telling anyone. Drafts and scheduled posts don't count.

It's checked where the counts go up: a like, a view (`POST /v1/posts/:id/view`), and posts seen in feeds (`POST /v1/feed/events`). The
notification is in its own category, Milestones (on by default, Settings, Notifications), and pushes like the others. The notification list shows
it as a small card with the number.

## 6. Liked by

Under a post: "Liked by Amara and 12 others". The person named is the latest one who liked it whom the viewer follows or is friends with, and only
when the viewer may see them there:

- never the author or the viewer, nobody either of them blocked, nobody the viewer muted, no suspended account;
- a private account only when the viewer follows it;
- someone under 18 only when they're friends with the viewer;
- not when the author hid like counts (unless the viewer is the author).

The others are everyone else who liked it. Signed out, there's no line.

## 7. Sending a post into a chat

"Send in a chat" (`POST /v1/posts/:id/send`) sends a message with the post's link, and your words if you add some, to people or chats you choose. It
goes through the messaging endpoints as you, so blocks, minor protection and who can message whom apply as for any message, and the link opens
only for people who can see the post. It counts as a share.
