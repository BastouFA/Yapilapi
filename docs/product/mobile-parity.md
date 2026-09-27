# Web and phone app parity

Every signed-in page of the web app (`apps/web/app/(app)/`) and where it lives in the phone app
(`apps/mobile/app/`). Status: **Yes** (same features), **Partial** (the everyday parts; the rest
on the web for now), **No** (not in the phone app yet), **Web only** (on purpose).

Last reviewed: September 2026, after the first-run pass (welcome, sign up, log in with two-step
codes, forgot password, a six-step onboarding, the tour of the dock, empty states that point to
the next thing to do, loading placeholders and the offline bar; see "First run" below), the parity
pass for creators and money (Studio, post insights, boosting, plans and tips, the shop and
purchases), and the ones before them.

The phone app has no checkout: anything that takes money (buying, booking a service, subscribing,
tipping, gifts, boosting, Plus) opens the matching web page in the browser, with the choice already
made, and the app never handles card details. Coming back to the app loads the result again.

## Pages

| Web route                                    | What it is                                                                                  | Phone app                                                         | Status   | Notes                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/home`                                      | Pulse feed, stories, starter row                                                            | `(tabs)/index`                                                    | Yes      |                                                                                                                                                                                                              |
| `/discover`                                  | Wander: search, communities, events, what's on now, assistant panel                         | `(tabs)/discover`                                                 | Partial  | Search as you type, filters, recent searches, trending tags, communities to join, what's coming up. The "Happening now" block and the inline assistant panel are not on the phone (the Assistant screen is). |
| `/search`                                    | Universal search with filters and recent searches                                           | `(tabs)/discover` (`?q=`)                                         | Yes      | Web links `/search?q=` open Wander with the search filled in. Adds a Places filter.                                                                                                                          |
| `/create`                                    | Post, reel, story, poll composer                                                            | `(tabs)/create`, `camera`                                         | Yes      |                                                                                                                                                                                                              |
| `/camera`                                    | Capture                                                                                     | `camera`                                                          | Yes      |                                                                                                                                                                                                              |
| `/inbox`                                     | Conversations, friend requests, notifications link                                          | `(tabs)/inbox`                                                    | Yes      | Now shows friend requests (accept or decline) and a Notifications row with the unread count.                                                                                                                 |
| `/inbox/[id]`                                | A chat                                                                                      | `chat/[id]`                                                       | Yes      |                                                                                                                                                                                                              |
| `/notifications`                             | Notifications grouped by day, "Ada and 3 others", Follow back, invites                      | `notifications`                                                   | Yes      | Every notification type has text on the phone and opens the right screen. The web marks read with a button; the phone marks read on opening.                                                                |
| `/p/[id]` | A post | `p/[id]` | Yes | Your own posts have See insights and Boost this post in the More menu; a creator's posts have a tip button (paid on the web). |
| `/reels`                                     | Reels viewer                                                                                | `reels`                                                           | Yes      |                                                                                                                                                                                                              |
| `/reels/[id]/remixes`                        | Duets and remixes of a reel                                                                 | -                                                                 | No       | Links open the reel itself.                                                                                                                                                                                  |
| `/s/[id]`                                    | A story                                                                                     | `s/[id]`                                                          | Yes      |                                                                                                                                                                                                              |
| `/u/[username]` | Profile: cover, status, posts, tagged, boards, chapters, shop, support, follow lists, menu, share | `u/[username]`, `(tabs)/profile`, `product`, `plans` | Partial | Follower and following lists, the More menu (add friend, mute, block, report) and Edit profile are on the phone. Support card with the creator's plans and perks, subscribe and tip (paid on the web). Shop tab lists products, downloads and services; each opens `product` (details, download if you bought it, buy or book on the web). Subscriber-only posts show a locked card with Subscribe on the web and See plans. QR code: shared as a link through the system share sheet (see below). |
| `/t/[tag]`                                   | A tag                                                                                       | `t/[tag]`                                                         | Yes      |                                                                                                                                                                                                              |
| `/sounds/[id]`                               | A sound                                                                                     | `sounds/[id]`                                                     | Yes      |                                                                                                                                                                                                              |
| `/music/[id]`                                | A music track                                                                               | `music/[id]`                                                      | Yes      |                                                                                                                                                                                                              |
| `/saved`                                     | Saved posts and boards                                                                      | `saved`                                                           | Yes      | Reachable from You and Settings.                                                                                                                                                                             |
| `/boards/[id]`                               | A board                                                                                     | `board/[id]`                                                      | Yes      | `yapilapi://boards/…` and web links open it.                                                                                                                                                                 |
| `/drafts`                                    | Drafts and scheduled posts                                                                  | `drafts`                                                          | Yes      | Reachable from You and Settings (was only reachable from Create).                                                                                                                                            |
| `/archive`                                   | Story archive                                                                               | `archive`                                                         | Yes      |                                                                                                                                                                                                              |
| `/chapters/[id]`                             | A chapter or time capsule                                                                   | `chapter/[id]`                                                    | Yes      |                                                                                                                                                                                                              |
| `/circles`                                   | Circles                                                                                     | `circles`, `circle/[id]`                                          | Yes      |                                                                                                                                                                                                              |
| `/recaps`, `/recaps/new`                     | Recap videos                                                                                | `recaps`, `recap-new`                                             | Yes      |                                                                                                                                                                                                              |
| `/c/[slug]` | Community: posts, FAQ, rooms, events, members, chat | `c/[slug]` | Yes | Events tab, group chat button and member profiles. Organizers and up get Create event; owners, admins and moderators get Settings (`community-settings`). The AI summary of a community is web only for now. |
| `/communities/new` | Create a community | `community-new` | Yes | Name, address, description, who can join, topics, rules; opens the new community. No cover photo: communities don't have one in the API. |
| `/rooms/[id]`                                | An audio room                                                                               | `room/[id]`                                                       | Yes      | Rooms are listed in each community's Rooms tab.                                                                                                                                                              |
| `/events` | Events list | `events` | Yes | New button to make an event. |
| `/events/[id]` | An event with RSVP and who's going | `event/[id]` | Yes | Going, interested or can't go, waitlist, host, attendees, share, join link for online events. Hosts edit and cancel it (ahead of the web). Messaging attendees isn't in the API. |
| `/events/new` | Create an event | `event-edit` | Yes | Title, details, start and end on the pure-JS date picker, time zone, an address, a place on YAPILAPI or online with a link, capacity, who can see it, community. `event-edit?id=` edits (`PATCH /v1/events/:id`). No cover photo: events don't have one in the API. |
| `/places/[id]` | A place: hours, events, menu and products, bookings, reviews | `place/[id]` | Partial | What, where, map link, rating, hours, events, offers, reviews (read and write), asking to book a time slot with the room left at each (`GET /v1/places/:id/availability`), your bookings with cancel, and for the owner, requests to confirm or decline. Buying is on the web. |
| `/b/[slug]`                                  | A business page                                                                             | -                                                                 | No       |                                                                                                                                                                                                              |
| `/find-friends`                              | Contacts and suggestions                                                                    | `find-friends`                                                    | Yes      |                                                                                                                                                                                                              |
| `/invite`                                    | Invite link and rewards                                                                     | `invite`                                                          | Yes      |                                                                                                                                                                                                              |
| `/real`                                      | Real                                                                                        | `real`                                                            | Yes      |                                                                                                                                                                                                              |
| `/assistant`                                 | Assistant                                                                                   | `assistant`                                                       | Yes      |                                                                                                                                                                                                              |
| `/settings`                                  | Profile, attention, privacy, security, safety                                               | `settings`, `profile-edit`                                        | Partial  | See the settings table.                                                                                                                                                                                      |
| `/live`, `/live/[id]` | Live video | `live/index`, `live/[id]` | Partial | Watching: live now and coming up, the video (HLS with each viewer's signed link), chat and questions that update live, gifts shown in the chat, host and moderators remove messages or people, the host can end. Tickets and gifts are paid for on the web ("Buy a ticket on the web", "Send a gift on the web"); the screen checks the ticket again on coming back. Going live needs streaming software on a computer, and the screen says so. |
| `/together`, `/together/[id]` | Together albums | `together/index`, `together/[id]`, `real?together=<id>` | Yes | Your Togethers, starting one with friends, members, photos with sensitive ones blurred, closing (creator). "Add your view" takes a photo with the Real camera. New photos arrive live. |
| `/memories`, `/memories/[id]` | Memories | `memories/index`, `memories/[id]`, post More menu | Yes | Your memories and ones shared with you, making one, from an event you went to, On this day, rename, delete, remove items, share with friends, the AI recap, and making a recap video. "Add to a memory" is in a post's More menu. The phone adds rename and removing items, which the web page doesn't have. |
| `/plus` | YAPILAPI Plus | `plus` | Partial | Benefits, status and end date, history, progress to a free month from invites. Paying opens the web checkout in the browser; the app never handles card details. |
| `/studio` | Creator studio: analytics, earnings, sales, shop, plans, boosts, promotions, video editor | `studio`, `insights/[id]`, `boost` | Partial | Last 28 days: views, reach, likes, comments, saves, followers and new followers per day (bars drawn with Views), top posts and reels, earnings per currency, payout requests and their status, sales and service bookings (confirm or decline), subscribers and plans, boost and promotion results, tips and gifts. From You for creator, professional and business accounts. Post insights (`insights/[id]`) from a post's More menu. Boosting (`boost`) picks budget, days and audience with a summary, then opens the post on the web with those choices filled in to pay. Adding products and files, making plans, the video editor and new promotions stay on the web (Open Studio on the web). |
| `/developers`                                | API keys and webhooks                                                                       | -                                                                 | Web only |                                                                                                                                                                                                              |
| `/admin`                                     | Moderation and admin                                                                        | -                                                                 | Web only |                                                                                                                                                                                                              |

Phone-only screens: `close-friends`, `now-status`, `new-group`, `onboarding`, `welcome`, `board-edit`,
`chapter-edit`, `communities` (yours and to discover), `follows`, `community-settings` (details,
members and roles, join requests, bans and the FAQ, for owners, admins and moderators; the web
has no such page yet), `purchases` (downloads you bought, opened with a 10-minute link in the
system; your subscriptions, with cancel; tips you sent), `gifts` (tips and gifts received and
sent), `plans` (a creator's plans and perks), `product` (one thing from a shop). On the web these
live on the profile, in Studio and in Settings.

## First run

What a new person sees, in order, and what it rests on.

| Screen or piece                  | Phone app                                              | Notes                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome                          | `welcome`                                              | The logo, the tagline, Pulse, Wander and Yap in a line each with their own symbols, then Create account or Log in. Pulse opens it for anyone signed out, and signing out comes back to it.                                                                               |
| Sign up                          | `signup`                                               | Name, username (suggested from the name, checked as you type with `POST /v1/auth/check-username`), email, password with show and hide, date of birth (optional, the pure-JS date picker), invite code (filled in from `/join/<code>`). Errors show next to their field. |
| Log in                           | `login`                                                | Email and password, then the two-step code (authenticator or recovery code, `POST /v1/auth/mfa/verify`) for accounts that use it. The session is registered as a phone.                                                                                                  |
| Forgot password                  | `forgot-password`                                      | Sends the reset email (`POST /v1/auth/password/forgot`). The link in it opens the web page to choose the new password; then you log in on the phone.                                                                                                                |
| Onboarding                       | `onboarding`                                           | Six steps with progress and Back, each skippable: language, interests, people and communities to follow, find friends (contacts, or share your invite link), photo and name, notifications with what they are for. Where you got to is saved on the phone.             |
| Tour of the dock                 | `lib/tour.tsx`                                         | Four small marks on first launch (Pulse, Wander, Spark, then Yap and You). Nothing is dimmed or blocked, Skip ends it, shown once per phone, read out to screen readers, no fading with Reduce Motion.                                                                 |
| Empty states                     | `lib/empty.tsx`, `EmptyState` in `lib/ui.tsx`          | Pulse with nothing: people to follow (the feed reloads as you follow), trending tags, Find friends. Yap with no chats: Start a chat and people you can message. You with no posts: Make your first post (opens Spark).                                                   |
| Loading                          | `Skeleton`, `SkeletonList` in `lib/ui.tsx`             | Placeholders shaped like posts or rows on Pulse, Yap, Wander's trending list, profiles, notifications and communities. Still with Reduce Motion; screen readers hear "Loading" once.                                                                                   |
| Offline                          | `lib/network.ts`, `lib/offline.tsx`                    | No network-status module is installed, so a request that can't reach the API shows a bar with Try again; it checks `/health/live` now and then and goes away once the API answers. Pulse and Yap reload when the connection is back.                                    |

Not on the phone yet: signing up with a phone number (the API signs up with email only; a phone
number is added and confirmed later in Settings), passkeys (no passkey native module is installed),
choosing a new password inside the app (the email link opens the web), and long-press quick
actions on the app icon (`expo-quick-actions` is not installed, and no native module may be added).

## Settings

| Web setting                                  | Phone app                                  | Status  |
| -------------------------------------------- | ------------------------------------------ | ------- |
| Edit profile (photo, name, bio, type)        | `profile-edit`                             | Yes     |
| Language                                     | `profile-edit`                             | Yes     |
| Country                                      | -                                          | No      |
| Private account                              | `profile-edit`                             | Yes     |
| Data saver                                   | Settings, Data and language                | Yes     |
| Translation                                  | Settings, Data and language                | Yes     |
| Feed controls and daily time budget          | Settings, Notifications and feed           | Yes     |
| Notification categories and pause for 8 hours | Settings, Notifications and feed          | Yes     |
| Phone notifications                          | Settings (turn on notifications)           | Yes     |
| Contacts and downloads (sharing)             | Settings, Privacy and safety               | Yes     |
| Photo tags                                   | Settings, Privacy and safety               | Yes     |
| Hidden words                                 | Settings, Privacy and safety               | Yes     |
| How your data is used (consents)             | Settings, Privacy and safety               | Yes     |
| Advertising consent                          | Settings, Privacy and safety               | Yes     |
| Blocked accounts                             | Settings, Privacy and safety               | Yes     |
| Close friends, circles                       | Settings, Your space; You                  | Yes     |
| Family supervision                           | Settings, Family                           | Yes     |
| Email and phone verification                 | Settings, Account                          | Yes     |
| Where you're signed in                       | Settings, Security                         | Yes     |
| Two-step verification, passkeys              | Logging in with a two-step code (`login`)  | Partial |
| Connected apps                               | -                                          | No      |
| Export data, delete account, assistant memory | -                                         | No      |
| Decisions about your content and appeals     | -                                          | No      |
| Purchases                                    | `purchases` (You)                          | Yes     |

## Links into the app

Taps on push notifications open the screen the notification is about (`lib/links.ts`,
`useNotificationLinks`), including when the app was closed. Links from outside go through
`app/+native-intent.tsx`, which maps the web app's paths to the phone app's:

| Link                                          | Opens                   |
| --------------------------------------------- | ----------------------- |
| `yapilapi://p/<id>`, `/post/<id>`             | Post                    |
| `yapilapi://reels/<id>`, `/reels?start=<id>`  | Reel                    |
| `yapilapi://u/<username>`, `/@<username>`     | Profile                 |
| `yapilapi://t/<tag>`, `/tags/<tag>`           | Tag                     |
| `yapilapi://board/<id>`, `/boards/<id>`       | Board                   |
| `yapilapi://room/<id>`, `/rooms/<id>`         | Room                    |
| `yapilapi://recaps?open=<id>`                 | Recap                   |
| `yapilapi://chat/<id>`, `/inbox/<id>`         | Chat                    |
| `yapilapi://event/<id>`, `/events/<id>`       | Event                   |
| `/events/new?community=<id>`                  | New event               |
| `/events/<id>/edit`                           | Edit event              |
| `/communities/new`                            | New community           |
| `/c/<slug>/settings`                          | Community settings      |
| `yapilapi://place/<id>`, `/places/<id>`       | Place                   |
| `yapilapi://plus`, `/plus`                    | Plus                    |
| `yapilapi://chapter/<id>`, `/chapters/<id>`   | Chapter                 |
| `yapilapi://search?q=…`                       | Wander, searching       |
| `yapilapi://memories/<id>`, `/memories/<id>`  | Memory                  |
| `yapilapi://together/<id>`, `/together/<id>`  | Together                |
| `yapilapi://live/<id>`, `/live/<id>`          | Live                    |
| `/join/<code>`                                | Sign up, code filled in |
| `/signup`, `/login`, `/forgot-password`       | The same screens        |
| `yapilapi://studio`, `/studio`                | Studio                  |
| `/p/<id>/insights`, `yapilapi://insights/<id>` | Post insights          |
| `/p/<id>?boost=1`                             | Boost a post            |
| `/u/<username>?subscribe=1`, `yapilapi://plans/<username>` | A creator's plans |
| `/u/<username>?shop=1&product=<id>`           | One thing from a shop   |
| `yapilapi://purchases`, `yapilapi://gifts`    | Purchases, tips and gifts |

Notifications about money open the matching screen: a tip you got opens tips and gifts; a new
subscriber, a sale or a booking to confirm opens Studio.

The web pages the phone opens for checkout take the choice with them: `/u/<name>?subscribe=1`
(plans), `/u/<name>?tip=1&post=<id>` (the tip sheet, for that post), `/u/<name>?shop=1&product=<id>`
(the Shop tab with that item), `/p/<id>?boost=1&currency=&budget=&days=&country=` or `&topics=`
(the boost sheet filled in).

Universal links (https links opening the app) need `associatedDomains` and an Android intent
filter with a verified host, which are native configuration changes and not set up yet; the
mapping above already handles those paths once they are.

## Still missing, and why

- **Going live**: publishing needs streaming software (RTMP) on a computer; the phone app watches
  lives, and says where to go live from.
- **Buying live tickets and sending gifts**: checkout isn't in the phone app, so these open the
  live's page on the web.
- **Covers for communities and events, messaging an event's attendees**: not in the API yet.
- **Setting up two-step verification, passkeys, connected apps, data export, account deletion,
  appeals**: security and account flows that need care on a phone (authenticator setup, passkey
  native modules we don't ship); on the web. Logging in with a two-step code works on the phone.
- **Profile QR code**: the QR generator the web uses (`qrcode-generator`) doesn't resolve from
  the phone app, and no native dependency may be added, so the profile is shared as a link.
- **Checkout**: buying, booking a service, subscribing, tipping, gifts, boosting and Plus are paid
  on the web, opened in the browser with the choice made on the phone. The phone never handles
  card details, and no payment native module is shipped.
- **Selling and running promotions**: adding products and their files, making plans, the video
  editor and new promotions are in Studio on the web; the phone shows how they are doing.
- **Requesting a payout**: the phone shows payout requests and their status; there is no request
  form on the web either yet.
- **Buying at places**, **business pages**: commerce flows on the web.
