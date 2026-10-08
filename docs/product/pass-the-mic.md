# Pass the Mic and Fair start

Two reasons to make reels, and a reward for making them. **Pass the Mic**: reels made together, one after another, from a prompt.
**Fair start**: a new creator's first reels are shown to up to 1,000 people.

The code: `apps/api/src/lib/chains.ts`, `apps/api/src/lib/fair-start.ts`, `apps/api/src/modules/pass-the-mic.ts`, the fair-start
slots and the chain audience in `apps/api/src/lib/ranking.ts`, `packages/shared/src/pass-the-mic.ts` (types and words both apps
use), `packages/shared/src/pass-the-mic-schemas.ts`, the numbers in `packages/shared/src/constants.ts` (`CHAIN_RULES`, `FAIR_START`),
migration `packages/database/migrations/0085_pass_the_mic.sql`. Tests: `apps/api/test/pass-the-mic.test.ts`. Both are behind
feature flags, on by default: `PASS_THE_MIC` and `FAIR_START` (Admin, Feature flags).

## 1. Pass the Mic

### Starting a chain

A creator starts a chain when posting a reel ("Start a chain" in the reel composer, web and phone: a prompt of up to 120 characters
and who can take the mic), or later from one of their reels ("Start a chain" in the reel's options; `POST /v1/chains`). Prompts like
"Show your city's best street food", "Continue this dance", "Finish my song: the next 10 seconds are yours".

A chain is made of reels posted right away (not drafts or scheduled posts, not echoes), shared publicly, with followers or with
friends (not for subscribers, a circle or chosen people, and not in a community). A reel is in one chain at most.

The starter's reel's sound (its own, or the one it borrowed) is the chain's sound: it's pre-selected for the next person, like
using a sound from a reel, while they may use it (the usual sound rules: a public reel that allows remixes).

### Taking the mic

"Take the mic" on a chain reel (or the chain's page) opens the reel camera and composer with the prompt and the chain's sound. The
reel is posted with `chainId` (`POST /v1/posts`) and becomes the next link. It's a normal reel: on its author's profile, in feeds,
in search, with its own audience. If taking the mic is refused, the reel isn't posted.

Who can take the mic is the starter's choice: **everyone** who can see the chain, **people I follow**, or **nobody** (the chain is
closed; reels in it stay). Left unchosen: everyone for public accounts, people they follow for private and under-18 accounts.
Whatever it says:

- Blocks either way between someone and the starter hide the chain from them: they can't see it, take the mic or be passed it.
- An adult and someone under 18 can only be in each other's chains once they're friends (the rule for messages and co-authors).
- One person adds at most **3** reels to one chain (`linksPerPersonPerChain`) and **20** reels to chains a day (`linksPerDay`).
  Posting is also limited as usual (30 a minute, the pace for new accounts).

### Watching a chain

On a chain reel, a chain bar says "Link 3 of 47 · 12 countries", who started it and the prompt. Moving sideways goes along the chain
in order: on the web the previous and next buttons and the left and right arrow keys (Shift with an arrow still moves 5 seconds);
on the phone a sideways swipe and the same buttons. Up and down stays the normal feed.

The chain page (web `/chains/:id`, phone `chain/[id]`) has the prompt, the starter, the counts (reels, people, countries) and a grid of
its reels, with "Take the mic".

Counts include every reel up in the chain, also ones a viewer can't see (a private account's reel for its followers, say); those
reels are never shown to them, and moving along the chain skips them. Countries are the countries people set on their profile;
when nobody did, the bar leaves them out.

### The starter and the people in it

- The starter changes the prompt, who can take the mic, closes and reopens it (`PATCH /v1/chains/:id`), and removes any reel from
  the chain (`DELETE /v1/chains/:id/links/:postId`). Removing never deletes the reel; it's only out of the chain. The removal is in
  the audit log.
- A reel's author leaves the chain with their reel the same way.
- A reel that is deleted, taken down by moderation, held for review or from a suspended account drops out of the chain at once, and
  comes back if it's restored. Reels are reported like any reel.
- The order never changes: each new reel takes the next place, even after others left.

### Notifications

- The starter: "Ada took the mic on your chain", batched per chain ("Ada and 3 others took the mic on your chain"), pushed once.
- The author of the reel just before: "Ada took the mic after you", batched the same way. Nobody hears twice about one reel.
- Only people who can see the new reel are told, and a reel held for review tells nobody.
- **Pass the mic**: anyone who can see the chain can pass the mic to people they follow or are friends with (up to 5 at a time and
  10 per chain): "Ada passed you the mic: Show your city's best street food". Only people who may take the mic are told (not blocked,
  allowed by the starter, minor protection), once per person per chain; others are skipped without saying why.

All are in the Creators category (Settings, Notifications).

### In the recommender

- **The chain's audience carries on**: someone who watched a chain reel in the last 14 days gets its later reels as candidates for
  For you and Reels, scored `RANKING.weights.chain` (1.5) higher.
- **Wander** has a Chains shelf: chains with a new reel in the last 7 days (`activeDays`), the busiest first (`GET /v1/chains/active`).

## 2. Fair start

### Who gets one

- The first **3** reels of an account that can have one (`firstReels`), then **1 every 7 days** (`everyDays`) while it has fewer
  than **1,000** followers (`underFollowers`). One runs at a time: a reel posted while another runs doesn't get one (it doesn't wait).
- The reel: public, not in a community, not an echo, not held, not marked sensitive.
- The account: public, 18 or older, with a confirmed email or phone (the app's trust gate), not limited or suspended, and without
  open risk flags that make it a risky account (`SPAM_RULES.riskyAccountScore`). With spam checks on, accounts made from the same
  address (their sign-up) have at most **2** fair starts running at once (`perSignupAddress`): accounts made to farm reach get little.
- Teens' reels don't get a fair start: it shows reels to strangers, which minors' rules don't allow.

The composer says "We'll show it to up to 1,000 people." when the next reel would get one (`GET /v1/me/fair-start`).

### How it's shown

One slot in **9** of For you and Reels (`slotEvery`), from the 4th (`firstSlot`), goes to the fair-start reel that suits the viewer
best: topics they picked or engage with, the languages they understand (their app language and the ones they added in Settings,
Language), their country, and how far each reel still is from its target. A reel in a language they don't understand still fits
when it reaches them translated ("Translate automatically" on); with that off, it's a weaker fit. Never the viewer's own, never
one they already saw anywhere (`fair_start_views` and their feed impressions), never from a creator they keep skipping, and every rule of the feed applies (blocks, private accounts, mutes, "Not interested", sensitive videos
for under-18s, Fewer suggestions). Each appears once in a feed; when there are none left, the slots are ordinary ones again, so a small
app reaches whoever there is and never repeats anything.

### Who counts

Each real person once: someone else (not the creator), with an active account that isn't limited or flagged as risky, who had it on
screen (the feed's impression: half of it for a second). Feed events only count posts the person can see, so blocks either way never
count.

### Quality check, end

- Once **50** people saw it (`checkAfter`), if more than **60%** of them moved on at once (`skipShare`; the apps' skip: left within
  2 seconds), or as soon as anyone reports it, it's **slowed**: it goes after the other fair-start reels and only until **200**
  people (`minimum`). The creator sees "It's reaching people more slowly now".
- It ends when it reached its target (1,000, or 200 when slowed) or after **7 days** (`days`), whatever it reached: the creator gets
  one notification, "Fair start finished: 312 people saw your reel". Checked as views come in and once a minute (`sweepFairStarts`).
- Deleted, taken down, held, made private, marked sensitive, or the account limited or suspended: it stops, without a report.

### Honesty

1,000 is a target, not a promise. The reel's stats (phone: Insights; web: the reel's options and its page, for the creator) show
"312 of 1,000 so far" with a progress bar while it runs, and the report when it's done: "1,000 people saw your reel · 630 watched to
the end · 24 shared · 12 followed you". The numbers are the real ones: people who watched to the end, shared it (share sheet, copied
link or sent in a chat) and followed the creator after seeing it, among the people it counted.

## 3. Admin and data

- Admin, Feature flags: both switches, and a line each: chains active this week and reels in chains; fair starts running, slowed,
  finished (`GET /v1/admin/pass-the-mic`).
- The data download has the chains you started, your reels in chains, who you passed the mic to (by username) and your reels' fair
  starts. Deleting the account deletes them; chains you started go, and the reels others added stay theirs.

## 4. Not done

- A reel held for review that a moderator clears later doesn't get a fair start (it wasn't eligible when it went out).
- The viewer's languages weigh in the fit but aren't a filter: someone who turned off "Translate automatically" can still get a
  fair-start reel they'd have to translate.
- Passing the mic is to people you follow or are friends with; there's no @mention in the caption that passes it.
