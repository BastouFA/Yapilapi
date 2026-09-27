# Web and phone app parity

Every signed-in page of the web app (`apps/web/app/(app)/`) and where it lives in the phone app
(`apps/mobile/app/`). Status: **Yes** (same features), **Partial** (the everyday parts; the rest
on the web for now), **No** (not in the phone app yet), **Web only** (on purpose).

Last reviewed: September 2026, after the parity pass that added the Wander search, grouped
notifications, event and place pages, follow lists, the profile menu, profile editing and the
remaining settings, then memories, Together and watching lives.

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
| `/p/[id]`                                    | A post                                                                                      | `p/[id]`                                                          | Yes      |                                                                                                                                                                                                              |
| `/reels`                                     | Reels viewer                                                                                | `reels`                                                           | Yes      |                                                                                                                                                                                                              |
| `/reels/[id]/remixes`                        | Duets and remixes of a reel                                                                 | -                                                                 | No       | Links open the reel itself.                                                                                                                                                                                  |
| `/s/[id]`                                    | A story                                                                                     | `s/[id]`                                                          | Yes      |                                                                                                                                                                                                              |
| `/u/[username]`                              | Profile: cover, status, posts, tagged, boards, chapters, shop, follow lists, menu, share    | `u/[username]`, `(tabs)/profile`                                  | Partial  | Follower and following lists, the More menu (add friend, mute, block, report) and Edit profile are now on the phone. QR code: shared as a link through the system share sheet (see below).                   |
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
| `/c/[slug]`                                  | Community: posts, FAQ, rooms, events, members, chat                                         | `c/[slug]`                                                        | Yes      | Events tab, group chat button and member profiles added. The AI summary of a community is web only for now.                                                                                                  |
| `/communities/new`                           | Create a community                                                                          | -                                                                 | No       | Rarely used; on the web.                                                                                                                                                                                     |
| `/rooms/[id]`                                | An audio room                                                                               | `room/[id]`                                                       | Yes      | Rooms are listed in each community's Rooms tab.                                                                                                                                                              |
| `/events`                                    | Events list                                                                                 | `events`                                                          | Yes      |                                                                                                                                                                                                              |
| `/events/[id]`                               | An event with RSVP and who's going                                                          | `event/[id]`                                                      | Yes      | New. Going, interested or can't go, waitlist, host, attendees, share.                                                                                                                                        |
| `/events/new`                                | Create an event                                                                             | -                                                                 | No       | On the web.                                                                                                                                                                                                  |
| `/places/[id]`                               | A place: hours, events, menu and products, bookings, reviews                                | `place/[id]`                                                      | Partial  | New: what, where, map link, hours, events, offers. Buying, booking a table and reviews are on the web.                                                                                                       |
| `/b/[slug]`                                  | A business page                                                                             | -                                                                 | No       |                                                                                                                                                                                                              |
| `/find-friends`                              | Contacts and suggestions                                                                    | `find-friends`                                                    | Yes      |                                                                                                                                                                                                              |
| `/invite`                                    | Invite link and rewards                                                                     | `invite`                                                          | Yes      |                                                                                                                                                                                                              |
| `/real`                                      | Real                                                                                        | `real`                                                            | Yes      |                                                                                                                                                                                                              |
| `/assistant`                                 | Assistant                                                                                   | `assistant`                                                       | Yes      |                                                                                                                                                                                                              |
| `/settings`                                  | Profile, attention, privacy, security, safety                                               | `settings`, `profile-edit`                                        | Partial  | See the settings table.                                                                                                                                                                                      |
| `/live`, `/live/[id]` | Live video | `live/index`, `live/[id]` | Partial | Watching: live now and coming up, the video (HLS with each viewer's signed link), chat and questions that update live, gifts shown in the chat, host and moderators remove messages or people, the host can end. Tickets and gifts are paid for on the web ("Buy a ticket on the web", "Send a gift on the web"); the screen checks the ticket again on coming back. Going live needs streaming software on a computer, and the screen says so. |
| `/together`, `/together/[id]` | Together albums | `together/index`, `together/[id]`, `real?together=<id>` | Yes | Your Togethers, starting one with friends, members, photos with sensitive ones blurred, closing (creator). "Add your view" takes a photo with the Real camera. New photos arrive live. |
| `/memories`, `/memories/[id]` | Memories | `memories/index`, `memories/[id]`, post More menu | Yes | Your memories and ones shared with you, making one, from an event you went to, On this day, rename, delete, remove items, share with friends, the AI recap, and making a recap video. "Add to a memory" is in a post's More menu. The phone adds rename and removing items, which the web page doesn't have. |
| `/plus`                                      | YAPILAPI Plus                                                                               | `invite` (status only)                                            | Partial  | Buying Plus is on the web.                                                                                                                                                                                   |
| `/studio`                                    | Creator studio: analytics, ads, sales                                                       | -                                                                 | Web only |                                                                                                                                                                                                              |
| `/developers`                                | API keys and webhooks                                                                       | -                                                                 | Web only |                                                                                                                                                                                                              |
| `/admin`                                     | Moderation and admin                                                                        | -                                                                 | Web only |                                                                                                                                                                                                              |

Phone-only screens: `close-friends`, `now-status`, `new-group`, `onboarding`, `board-edit`,
`chapter-edit`, `communities` (yours and to discover), `follows`.

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
| Two-step verification, passkeys              | -                                          | No      |
| Connected apps                               | -                                          | No      |
| Export data, delete account, assistant memory | -                                         | No      |
| Decisions about your content and appeals     | -                                          | No      |
| Purchases                                    | -                                          | No      |

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
| `yapilapi://chapter/<id>`, `/chapters/<id>`   | Chapter                 |
| `yapilapi://search?q=…`                       | Wander, searching       |
| `yapilapi://memories/<id>`, `/memories/<id>`  | Memory                  |
| `yapilapi://together/<id>`, `/together/<id>`  | Together                |
| `yapilapi://live/<id>`, `/live/<id>`          | Live                    |

Universal links (https links opening the app) need `associatedDomains` and an Android intent
filter with a verified host, which are native configuration changes and not set up yet; the
mapping above already handles those paths once they are.

## Still missing, and why

- **Going live**: publishing needs streaming software (RTMP) on a computer; the phone app watches
  lives, and says where to go live from.
- **Buying live tickets and sending gifts**: checkout isn't in the phone app, so these open the
  live's page on the web.
- **Creating communities and events**: rarely done, long forms; on the web.
- **Two-step verification, passkeys, connected apps, data export, account deletion, appeals**:
  security and account flows that need care on a phone (authenticator setup, passkey native
  modules we don't ship); on the web.
- **Profile QR code**: the QR generator the web uses (`qrcode-generator`) doesn't resolve from
  the phone app, and no native dependency may be added, so the profile is shared as a link.
- **Place bookings, reviews and buying**, **business pages**, **Plus checkout**: commerce flows
  on the web.
