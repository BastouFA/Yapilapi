# Legal review pack

For the lawyer reviewing YAPILAPI's legal pages before launch. Prepared from the code on 2026-09-27 (the pages' "Last updated" date). **This is not legal advice.** It was written by the development team (with an AI coding assistant) to describe what the product actually does and to list the questions only a lawyer can answer. Nothing here has been reviewed by counsel.

Where to find things:

- The pages: `apps/web/app/legal/*/page.tsx`, served at `/legal/terms`, `/legal/privacy`, `/legal/guidelines`, `/legal/safety`, `/legal/creators`, `/legal/copyright` and `/legal/cookies`.
- The company name, address, governing law and contact addresses come from environment settings (`apps/web/lib/legal.tsx`). Until those are set, the pages show placeholders in brackets.
- Every placeholder the owner must fill in is listed in [placeholders.md](placeholders.md).
- The store answers (Apple privacy label, Google data safety) are in [../operations/app-store.md](../operations/app-store.md). They must stay consistent with the privacy policy.

## 1. What YAPILAPI is

YAPILAPI is a social app on the web and on iPhone and Android. People post photos, videos, reels and stories, and follow each other. They chat one to one and in groups, with voice messages, calls, polls, games and watching videos together. They also join communities, audio rooms and live videos, go to events, and ask and answer questions on profiles. People 18 and over can sell products, tickets, bookings and downloads, run scheduled product launches ("drops"), take paid subscriptions and receive tips. Anyone can buy an optional paid tier, YAPILAPI Plus.

Some features are optional helpers that use a third-party AI model: summaries, suggested replies, photo descriptions, caption ideas and translation. Sponsored posts are shown only to adults who opt in. There is a developer platform ("Sign in with YAPILAPI", API keys, webhooks) and there are mini apps made by other developers.

## 2. Who it is for, and where

- **Minimum age:** 13. People from 13 to 17 get extra protections (section 6). Selling, receiving money and payouts are 18 and over.
- **Languages:** the app ships in English, French, Arabic, Spanish, Portuguese (Brazil), Swahili, Yorùbá and Hausa. Arabic is right-to-left.
- **Likely markets:** Nigeria, Ghana, Kenya and South Africa. Paystack is wired for NGN, GHS, KES and ZAR, and Yorùbá, Hausa and Swahili are supported.
- **Other markets the languages point to:**
  - French-speaking West and Central Africa, and France;
  - East Africa;
  - Spanish-speaking Latin America and Spain;
  - Brazil, and possibly Angola and Mozambique;
  - Arabic-speaking North Africa and the Middle East.
- **Europe and the United States:** some users there are likely, since the web app is open to anyone.
- **Launch countries:** the owner has not yet chosen them. Both stores let you pick countries. The app-store guide suggests starting with the countries the lawyer has reviewed.
- **Language of the legal texts:** the page text is English only. The page frame is translated into all 8 languages and marked, in each language, as English-only text: titles, navigation, "Last updated" and a note that the text is in English. See question 40.

## 3. The documents

| Page | What it covers | Notes |
| --- | --- | --- |
| Terms of service | Agreement, eligibility, accounts and usernames, content licence, conduct, moderation, AI features, paid features (Plus, drops, boosts), third-party services, music, liability, termination, governing law | Liability cap: the greater of 12 months' payments or 100 USD. Governing law comes from the `LEGAL_JURISDICTION` setting. |
| Privacy policy | Data collected, uses, legal bases, AI features, sharing, transfers, retention, rights, children, security | Written from the database and API code. Retention periods match `apps/api/src/lib/retention.ts`. |
| Community guidelines | What's allowed, questions without a name, selling and drops, enforcement, appeals, reporting | Also needs review by a trust and safety lead. |
| Safety and minors | Minimum age, teen protections (lives and audio rooms included), family links, tools, child sexual abuse material, emergencies, law enforcement | See the findings in section 11. |
| Creator and seller terms | Eligibility (18+), 5% platform fee, drops, subscriptions, tips and gifts, lives, downloads, refunds, payouts, boosts, business insights | The fee comes from `PLATFORM_FEE_PERCENT` in `packages/shared/src/legal.ts`. |
| Copyright and takedowns | Notice, counter-notice, music licences, repeat infringement, trademarks | DMCA-style. There is no designated agent yet. |
| Cookie notice | One cookie (`ypl_session`), what the browser and the phone keep, other companies | No analytics or advertising cookies. |

Sign-up on the web and the phone says that creating an account accepts the Terms and confirms reading the Privacy policy, with links. There is no checkbox and no separate consent screen.

In development builds, a banner on every legal page says the pages are templates awaiting legal review. It never shows in production.

## 4. Data inventory

Legal basis: the privacy policy (section 2) claims four bases in general terms, and doesn't map them purpose by purpose:

- **Contract:** to provide YAPILAPI.
- **Legitimate interests:** safety, security, preventing fraud, personalising and improving YAPILAPI.
- **Consent:** ads, contacts, assistant memory and notifications.
- **Legal obligation.**

The "basis claimed" column below applies that general statement to each item. "Not stated" means the text doesn't say. Retention comes from the code (`RETENTION` in `apps/api/src/lib/retention.ts`). "Until deletion" means the data is kept until the person deletes it or deletes their account, subject to the deletion gaps in section 11.

| Data | Where | Purpose | Basis claimed | Retention | Shared with |
| --- | --- | --- | --- | --- | --- |
| Email, password hash (scrypt), username, display name, language, invite code and inviter | `users`, `profiles`, `invite_codes`, `referrals` | Account | Contract | Until deletion (email and hash cleared on deletion) | Email service (emails), Paystack (email, at checkout) |
| Date of birth | `users.birth_date` | Age gate (13+), teen protections, 18+ for money | Contract or legitimate interests (not stated) | Until deletion (cleared on deletion) | Nobody |
| Phone number, and each code request (number, IP address, time) | `users.phone_e164`, `phone_verifications` | Verification | Not stated | Number until removed. Requests: 90 days | Twilio Verify |
| Username history (old and new name, dates, 14-day hold) | `username_history` | Old links and @mentions keep working for 14 days | Not stated | 30 days after the hold ends. Deleted with the account | Nobody (old links redirect publicly for 14 days) |
| Profile: photo, cover, bio, pronouns, links (up to 5), interests, mode, accent colour, header style, tabs, featured posts, profile song, "Now" status, city, chosen country | `profiles`, `profile_statuses`, `user_interests` | Profile | Contract | Until deletion | Public, per the privacy settings. A minor's city is never shown to others |
| Site icons of linked websites | `link_icons` (per host, not per person) | Show link icons | Not stated | Refreshed every 7 days | The server fetches `https://<host>/favicon.ico` itself, so linked sites see the server, not users |
| Posts, reels, stories, comments, reactions, polls, boards, chapters, memories, recaps, events, communities, products, reviews, drops; edit history of posts and comments | many (`posts`, `post_edits`, `moments`, `comments`, `comment_edits`, …) | The service | Contract | Until deletion. Deleted items are erased after 30 days, or 180 days if moderators removed them | Other users, per the audience chosen. Public adult content can appear signed out and in search engines |
| Chats: messages, voice notes, attachments, edit history, reactions, pins, polls, lists, reminders, games (board, moves, winner), wallpapers and bubble colours | `messages`, `chat_*`, `chat_games`, `chat_game_moves`, `conversations.wallpaper`/`accent` | Messaging | Contract | Until deleted or unsent. Disappearing chats: 24 h, 7 d or 90 d. View-once: when seen, or after 14 days. Deleted: erased after 30 days. Games (and their card): 12 months after they end | Chat members. Not end-to-end encrypted |
| Scheduled messages ("Send later") | `scheduled_messages` | Send at a chosen time | Contract | Until sent or cancelled. Deleted with the account | Nobody until sent |
| Calls: history (who, when, audio or video, status) | `calls`, `call_participants` | Call history | Contract | 12 months after the call | Call media goes peer to peer or through the TURN relay. Google STUN sees IP addresses. Not recorded |
| Audio rooms: participants and roles | `rooms`, `room_participants`, `room_reminders` | Rooms | Contract | No period set | Other participants. Not recorded |
| Lives: sessions, chat, participants, recordings and clips | `live_sessions`, `live_chat`, `live_participants` | Live video | Contract | Recordings: the host's to keep or delete. Raw recording on the video server: 2 days. Deleted chat lines: 30 days | Viewers. Self-hosted MediaMTX |
| Watch together: session, participants, queue, playback state | `watch_sessions`, `watch_participants`, `watch_queue_items` | Shared viewing | Contract | 90 days after the session ends | Chat members watching |
| Questions ("Ask me"): box settings, questions, answers, asker identity (always stored, even when "without your name shown"), question blocks | `ask_boxes`, `ask_questions` (`asker_id`), `ask_blocks` | Q&A on profiles | Contract | Until deletion. Deleted questions: 30 days (180 if removed by moderators) | Answers are public per the profile's privacy. The asker's identity is shown only to moderators |
| Weekly wraps (counts, what they point to, time zone) | `weekly_wraps`, `user_preferences.timezone` | Private weekly recap. On by default | Not stated | Until the person deletes it or the account | Nobody. The share image is made on request, for the person only |
| "On this day" | Not stored (computed). A dismissal is kept on the device | Memories | Not stated | — | Nobody |
| Catch me up: visits to Pulse, cached summaries | `pulse_visits`, `ai_catchups` | AI summary. On by default | Not stated | Summaries: 7 days. Visits: 13 months after the last one | Anthropic (see section 9) |
| Suggested replies (cached per reader and message) | `ai_reply_suggestions` | AI helper | Not stated | 7 days | Anthropic |
| Assistant memory | `ai_memories` | Assistant | Consent (`ai_processing`, off by default) | Until deleted | Anthropic, when the assistant is used |
| AI request log (task, provider, model, status, no content) | `ai_tool_calls` | Audit, rate limits | Legitimate interests (not stated) | 90 days | Nobody |
| Translations cache | `translations` | Don't translate twice | Not stated | Until the source text changes or is deleted | Anthropic (the text) |
| Sessions: IP address, user agent, last used | `sessions` | Sign-in, security | Legitimate interests | 30 days after they end | Nobody |
| Security events, including a failed sign-in's typed email, IP address and device | `security_events` | Security | Legitimate interests | 12 months | Nobody |
| Sign-in alert devices ("Chrome on macOS" and the CDN country, not hashed, no IP address), and session devices | `known_sign_ins`, `devices` | New-device alerts. Email on by default | Legitimate interests (not stated) | 13 months after last seen | Email service (the alert email) |
| Audit log of account, money and moderation actions (can include IP address) | `audit_logs` | Accountability | Legitimate interests | 2 years | Nobody |
| Product analytics events (no IP address) | `analytics_events` | Feed and product analytics. On by default | Legitimate interests | 13 months. Unlinked when turned off | Nobody (no third-party analytics) |
| Views, feed feedback, reel positions, saves | `post_views`, `moment_views`, `feed_feedback`, `reel_resume`, `saves` | Ranking, "seen by" on stories | Legitimate interests | Post and reel views: 13 months (the count stays). Feed feedback (show more or less, muted topics and people) is a setting: until changed or deletion. Others: no period set | Story authors see who viewed |
| Daily minutes | `usage_days` | Reminders, family links | Not stated | 13 months | The guardian of a supervised teen |
| Business and place page visits (viewer, day) | `business_views` | Business insights (owners see totals only) | Not stated | 13 months | Owners see only counts |
| Country (chosen, or from the CDN header) | `profiles.country`, `profiles.cdn_country`, per request | Regional rules, music licences, ads, sign-in alerts | Not stated | Until changed or deleted | The CDN provider supplies it |
| Settings (who can message, comment and mention, quiet hours and their time zone, sensitive media, data saver, AI helper switches) | `user_preferences`, `profiles` | The service | Contract | Until deletion (not cleared on deletion) | Nobody |
| Consents (personalization, ai_processing, advertising, analytics) | `consents` | Record choices | Legal obligation or consent | Until deletion | Nobody |
| Push tokens (Expo, web push endpoints) | `push_subscriptions` | Notifications | Consent | Until removed or deletion | Expo, Apple (APNs), Google (FCM), browser push services |
| Notifications inbox | `notifications` | The service | Contract | 12 months | Push services get a short line (a name and what happened, never message content) |
| Contacts (salted SHA-256 of emails, computed on the device) | Not stored (only counts) | Find friends | Consent | Not kept | Nobody |
| Payments: orders, payments, provider webhooks (can include email and the card's last digits and brand), refunds, tips, subscriptions, Plus grants | `orders`, `payments`, `payment_webhook_events`, `refunds`, `tips`, `creator_*`, `plus_grants` | Payments | Contract, legal obligation | 7 years (`FINANCIAL_RECORDS_YEARS`), except a paid download while the buyer's account and the product exist. Plus grants: no period set | Stripe, Paystack |
| Seller data: products, drops (reminder lists, held and paid units), sales, payouts | `products`, `drops`, `drop_items`, `drop_reminders`, `drop_orders`, `payouts` | Selling | Contract | Sales and payouts: 7 years, like payments. Products and drops: until deletion | Buyers see products. Sellers see the reminder count only |
| Ads: campaigns, impressions, clicks, hides | `ad_campaigns`, `ad_events` | Sponsored posts | Consent (ads off by default) | Impressions and clicks: 13 months. Hides: while the campaign exists. Campaigns: no period set | Advertisers see totals only |
| Reports, moderation cases, decisions, appeals, risk signals, enforcement | `reports`, `moderation_cases`, `appeals`, `enforcements`, `risk_signals` | Safety | Legitimate interests | Reports, cases, appeals and enforcements: 2 years after the case closed, and while the account stays suspended. Risk signals: no period set | AWS Rekognition (media), authorities when required |
| Family links and teen controls | `family_links`, `teen_controls` | Teen supervision | Not stated | Until the link ends | The guardian sees daily minutes and settings only |
| Developer apps, API keys, OAuth grants, mini app installs, webhook deliveries | `developer_apps`, `api_keys`, `oauth_grants`, `mini_app_installs`, `webhook_deliveries` | Developer platform | Contract | Deliveries: 30 days. Other rows: no period set | Connected apps and mini app developers (see section 5) |
| Problem reports (text, page, app version) | `problem_reports` | Support | Not stated | Kept. On deletion the person's link and text are removed | Nobody |
| Location shared in chats: the latest point of each share (precise, or snapped to about 1 km), then only the record that someone shared with a chat and when | `location_shares` | Sharing where you are, only when the person taps Share | Consent (each share) | Live: the point is deleted when the share ends (15 minutes to 8 hours at most). Pins sent once: until unsent. Records: with the account | The people in that chat. "Open in maps" hands the point to OpenStreetMap or the phone's maps app, only when the viewer chooses |
| Media files (photos, videos, voice notes, stripped of EXIF, GPS and device tags) | Object storage (`media`) | The service | Contract | With their content | Storage provider |
| One-time data (email links, challenges, OAuth codes, download links, uploads) | `auth_tokens`, `mfa_challenges`, `webauthn_challenges`, `oauth_codes`, `download_links`, `upload_sessions` | Security, uploads | Contract | 7 days after use or expiry | Nobody |
| Browser storage and phone secure storage | Device only | Preferences | Not stated | Until cleared | Never sent by itself (see the cookie notice) |

## 5. Processors and third parties

| Who | When it's used | What it receives | Where in the code | Switch |
| --- | --- | --- | --- | --- |
| Hosting, database, cache, file storage | Always | Everything stored | `render.yaml`; S3-compatible storage in `apps/api/src/lib/storage.ts` | `STORAGE_DRIVER`, `S3_*`. Provider: placeholder |
| Email (SMTP relay) | Verification, password reset, security notices (password, two-step, recovery codes, passkeys, phone), new sign-in alerts, account deleted. No marketing email | Email address and message text | `apps/api/src/lib/email.ts` | `EMAIL_TRANSPORT=smtp`, `SMTP_URL` (required in production). Provider: placeholder |
| Anthropic (Claude) | Catch me up, suggested replies, photo descriptions, caption ideas, translation, chat, community and memory summaries, plans, captions, search intent, assistants | See section 9. Photos resized to 1024 or 768 px | `apps/api/src/lib/ai/*` | `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL` (default `claude-opus-5`). Each helper also has its own feature flag |
| Speech-to-text (any OpenAI-compatible service) | Automatic captions, if turned on | The audio of the video (up to 25 MB) | `apps/api/src/lib/transcription.ts` | `TRANSCRIBE_PROVIDER` (default `none`). Provider: placeholder |
| Stripe | Card checkout | Amount, currency, order id. Card data goes straight to Stripe (Stripe.js on the web) | `apps/api/src/lib/payments.ts` | `PAYMENTS_PROVIDER`, `STRIPE_*` |
| Paystack | NGN, GHS, KES, ZAR (cards and mobile money) | Buyer's email, amount, currency, order id | `apps/api/src/lib/payments.ts` | `PAYSTACK_*` |
| Twilio Verify | Phone confirmation | Phone number | `apps/api/src/lib/sms.ts` | `SMS_PROVIDER`, `TWILIO_*` |
| AWS Rekognition | Nudity and violence checks | Photos and video frames | `apps/api/src/lib/media-moderation.ts` | `MEDIA_MODERATION_PROVIDER=rekognition` (off by default; the app-store guide says to turn it on before launch) |
| Expo push service, Apple APNs, Google FCM | Phone notifications | Push token, a short line of text, ids | `apps/api/src/lib/push.ts` | `EAS_PROJECT_ID` (app) |
| Browser push services (Google, Mozilla, Apple) | Web notifications | Endpoint, the same short text (encrypted with VAPID) | `apps/api/src/lib/push.ts` | `VAPID_*` |
| CDN or network provider | All traffic | All requests; supplies the country header | `TRUSTED_COUNTRY_HEADER` in `apps/api/src/app.ts` | Provider: placeholder |
| OpenTelemetry trace collector | Only if turned on | Request traces: routes, timings, database and Redis operations; HTTP spans can include client IP addresses | `apps/api/src/lib/tracing.ts` | `OTEL_EXPORTER_OTLP_ENDPOINT` (off by default). Provider: placeholder |
| coturn TURN relay (self-hosted) | Calls and rooms on strict networks; always for under-18s in rooms when set up | Media relayed, IP addresses | `apps/api/src/lib/ice.ts` | `TURN_URLS`, `TURN_SECRET` |
| Google STUN (`stun.l.google.com`) | Every call and room | The device's IP address | `apps/api/src/lib/ice.ts` | Hard-coded |
| MediaMTX (self-hosted) | Lives | Video, recordings | `apps/api/src/modules/live.ts` | `LIVE_*` |
| Jamendo | Music picker and playback | Server: search terms. Device: audio loaded directly from Jamendo, so Jamendo sees the IP address | `apps/api/src/lib/music/jamendo.ts` | `JAMENDO_CLIENT_ID` |
| Licensed music partner | The same, when a deal exists | The same | `apps/api/src/lib/music/licensed.ts` | `MUSIC_LICENSED_*` (no deal yet) |
| Websites linked from profiles | Icon fetch | A request from the server only | `apps/api/src/lib/link-icons.ts` | Always |
| Connected apps ("Sign in with YAPILAPI") | When a person approves | Read, or read and write, access to the API as the person. Never auth, developer, admin, export, payouts, consents or assistant memory | `apps/api/src/modules/oauth.ts`, `apps/api/src/plugins/auth.ts` | Revocable in Settings |
| Mini app developers | When a mini app is opened | A pseudonymous per-app user id. With the "profile" permission: username, name, avatar. With "members": the names of the people in the chat. The developer's server also sees the IP address | `apps/api/src/modules/miniapps.ts` | `MINI_APPS` flag; each app is reviewed by an admin |
| Webhook URLs set by a developer | Events on their own account | New follower id, event RSVP, paid order id, new post id | `apps/api/src/lib/webhooks.ts` | The developer's own choice |

**Not used:** third-party analytics, crash reporting, ad networks and tracking SDKs, Google Fonts at runtime, and GeoIP databases.

## 6. Minors

- **Age gate:**
  - Date of birth is required at sign-up (web and phone). Under 13 is refused.
  - Accounts made before the gate are asked once, and under 13 closes the account.
  - The date of birth is self-declared. There is no age assurance beyond that.
- **Defaults for 13 to 17 year olds** (`applyMinorDefaults` in `apps/api/src/lib/users.ts`, and elsewhere):
  - The account is private and can't be made public.
  - No ads, and ads personalization off.
  - Never visible signed out: not in link previews, search engines or the sitemap.
  - Reels can't be downloaded. Boards are never public. The profile city is hidden from others.
  - Not findable by email.
  - Adults can message them, ask them questions or invite them to speak in rooms only if they are friends.
  - Their lives (`liveVisibleSql` in `apps/api/src/lib/visibility.ts`) are for their friends, an active guardian, and followers under 18 (who they approved): never for everyone ("Everyone" becomes followers), never listed for others. Adults who aren't friends can't see, join, chat, gift or buy a ticket. Live chat between an adult and someone under 18 only reaches the other when they are friends or family-linked, in any live; the host, co-hosts and moderators see all of it. A teen host can only give co-host or moderator roles to adults who are friends.
  - They don't start or host audio rooms, even as community moderators: they speak when a host invites them, under the friends rule.
  - They never receive questions without a name, and the setting can't be turned on.
  - Suggested replies are off by default.
  - They use the TURN relay in rooms.
  - Sensitive media and posts awaiting review are hidden from them.
  - They can't sell, take paid plans, receive tips or ask for payouts.
  - Minor-safety reports hide the content at once.
- **Buying:** minors are not barred from paying. They can buy products, Plus and tickets, and can tip adults. See question 13.
- **Family links:**
  - A guardian aged 18 or over invites a teen, and the teen accepts. A teen can have up to two guardians.
  - The guardian sets who can message the teen, a daily reminder and quiet hours, and sees daily minutes only.
  - Nothing checks that the guardian is actually the teen's parent.
- **Lives and audio rooms:** see the two points above (finding 4, fixed). There is no "adults only" flag for lives, so under-18s can watch an adult's public live, as they can listen in rooms.

## 7. Content moderation and appeals

- **Automated checks:**
  - Text is scanned by in-house rules (`apps/api/src/lib/moderation.ts`) and spam heuristics (`spam.ts`: disposable email domains, many sign-ups from one network, links from new accounts, repeated text).
  - Media is checked by AWS Rekognition when turned on.
  - The results: refuse, hold for a moderator, or allow.
- **Reports:**
  - Anyone signed in can report posts, reels, stories, comments, profiles, messages, questions, answers, communities, rooms, lives, events, products and drops.
  - The reasons include copyright ("Uses my work without permission").
  - Reports are confidential. When a moderator decides, everyone whose report was open is told in plain words: removed, action taken, or it didn't break the rules (`report_outcome` notifications, in the Moderation category people can turn off). They aren't told how the other person was penalised.
- **Decisions and appeals:**
  - Moderators decide in `/admin`. The affected person gets an in-app notification with the decision.
  - They can appeal once from Settings. The app says "A different reviewer will look at it", and the code enforces it: whoever made the decision can't decide its appeal (`different_reviewer_needed`), and the moderator console shows "Needs another reviewer". With only one moderator, the appeal waits. The appeal records the reviewer and whether the decision was upheld or overturned.
  - There is no appeal time limit.
- **Regional rules:** content can be withheld per country, with a recorded legal basis. Authors see where a post is withheld.
- **Not built:**
  - notice-and-action for people without an account (only the copyright email);
  - statements of reasons in a structured form;
  - transparency reports;
  - trusted flaggers;
  - known-CSAM hash matching (for example PhotoDNA).

## 8. Payments and creator earnings

- **Providers:** Stripe and Paystack. YAPILAPI takes the buyer's payment and pays the seller later on request (payouts are checked manually). In practice YAPILAPI collects and holds funds for sellers. See question 14.
- **Platform fee:** 5% of each sale, booking, subscription payment, tip and gift (`PLATFORM_FEE_BPS = 500`), plus payment processing at the provider's standard rate (`PROCESSING_FEES`: for example 2.9% + 30¢ for USD cards; Paystack 1.5%, plus ₦100 from ₦2,500, at most ₦2,000), never more than the payment. Tips and plans start at about $1 in every currency.
- **Plus:**
  - 4.99 USD (configurable) for 30 days, with no automatic renewal.
  - It includes no sponsored posts, 10-minute reels, 500 MB uploads and a badge.
  - Invites give free Plus: 30 days for every 3 confirmed joins, up to 12 times.
- **Refunds:**
  - Only the seller, or a platform admin, can refund a paid order (`POST /v1/orders/:id/refund`).
  - There is no refund request flow for buyers, no withdrawal period and no digital-content waiver step.
  - Tips and gifts are stated as non-refundable except where the law requires it or for fraud.
  - The unspent budget of a boost is refunded automatically.
- **Drops:**
  - The seller must be 18+.
  - A drop is announced 5 minutes to 180 days ahead and can close 15 minutes to 30 days after it opens.
  - "Notify me" costs nothing.
  - Units in an unpaid order are held for 15 minutes. A late payment is kept if units remain, and refunded otherwise.
  - Overselling is prevented in the database.
  - Cancelling a drop cancels unpaid orders. Paid orders follow the usual refund path, which the seller must carry out.
  - The texts avoid pressure wording (no countdown in seconds).
- **Digital downloads:** buyers get 10-minute download links. When a seller deletes their account, their files are kept so buyers can still download. The creator terms state this, with a placeholder for how long.
- **Apple and Google in-app purchase rules:** open. See app-store.md, "Fix or accept these before launch".

## 9. AI use and labelling

- **Model:** Anthropic Claude through `apps/api/src/lib/ai`. The offline development provider returns marked, rule-based output.
- **What is sent:**
  - **Catch me up:** posts the reader can see (up to 60, from the last 7 days).
  - **Suggested replies:** the last 12 messages the reader can see, including other people's messages. On by default in one-to-one chats, off in groups and for under-18s.
  - **Photo description:** the photo, resized.
  - **Caption ideas:** the draft, the photos, and (with Personalization on) up to 8 of the person's recent posts.
  - **Translation:** the text, with tags, names and links masked.
  - **Summaries:** the messages or posts in scope.
  - **Assistants:** the prompt, the person's interests, language and events, and tool results.
- **Safeguards:** a permission check comes first, and context only includes what the person can see right now. Output passes a safety filter. Nothing is posted or sent without the person choosing to. Per-person limits apply.
- **What is stored:** a log without content (`ai_tool_calls`, 90 days). Cached results are kept 7 days.
- **Labelling:**
  - Helper output is labelled AI-generated.
  - Translations say "Machine translation".
  - A post made with a caption idea is marked as made with AI assistance (a provenance field on posts).
  - The guidelines ask people to label AI content that could mislead. There is no general "made with AI" toggle for people's own uploads.
- **Anthropic's terms:** its data retention and training terms for the account are not yet confirmed. The privacy policy has a placeholder for them.

## 10. Music licensing

Details: [../operations/music.md](../operations/music.md).

- **Sources:**
  - original sounds from reels (the creator allows reuse);
  - Jamendo, under Creative Commons. ND and SA licences are never offered, NC songs are for personal accounts only, and BY and CC0 are open to all;
  - a licensed-catalogue adapter for a future partner (no deal exists);
  - development tones, never in production.
- **Licence checks:** each song carries its licence (commercial use, countries, maximum clip length, credit, expiry). The licence is checked at publish time and at view time. Business accounts get only songs cleared for commercial use. A withdrawn song goes silent, with a note.
- **No copies:** audio is never copied or proxied. It plays from the provider's own address.
- **Jamendo's API terms** need checking. The free API is non-commercial, and a commercial service may need a Jamendo Licensing agreement.
- **Not built:** reporting song use to collecting societies, and any mainstream music.

## 11. Findings: where the code and the texts don't match yet

The pages are written so they don't promise what the code doesn't do. These findings are for the owner and the lawyer to decide on. The review itself changed no code; findings marked "fixed" were fixed afterwards.

1. **Account deletion and profile fields: fixed.**
   - This review found that `DELETE /v1/me` (`apps/api/src/modules/privacy.ts`) left some profile fields in place: pronouns, city, accent colour, header style, tabs, featured posts, profile song and country.
   - Since fixed (commit `ed7edc0`, test in `apps/api/test/profile-style.test.ts`). Deletion now also clears those fields and the pinned post, and deletes the "Now" status. The privacy policy lists them as removed.
   - `profiles.mode` (personal, creator, business) and `profiles.locale` (language) now go back to the defaults too (same test).
2. **Account deletion doesn't touch many other tables.** The `users` row stays (status `deleted`, email, password hash, birth date and phone cleared), so rows in other tables stay linked to an anonymised account. These include:
   - settings and quiet-hours time zone (`user_preferences`), consents and hidden words;
   - blocks, mutes and restrictions;
   - reactions, comment likes (removed), message reactions, poll votes, story responses, story views and post views;
   - saves and boards (including public board titles), memories, chapters, places, businesses, products, drops, drop reminders and orders, events and RSVPs, communities and memberships, place reviews;
   - rooms and room reminders, lives and live chat;
   - calls, watch together queue items, chat games, feed feedback and reel positions;
   - Catch me up visits and caches, notifications, business-page visits;
   - family links, developer apps, API keys and OAuth grants (these stop working, because authentication requires an active user), mini app installs;
   - two-step secrets and recovery codes, reports, appeals and moderation cases.

   Whether each of these stays visible to other people was not checked item by item. Payment records, reports and moderation decisions are kept on purpose.
3. **The data export (`GET /v1/me/export`) is being completed. Confirm before launch.**
   - When this pack was written, the export included:
     - account, profile, "Now" status, interests, follows and followers, circles, close friends;
     - posts and their earlier versions, sounds, comments and their earlier versions, comment likes, hidden words, reactions;
     - messages sent, scheduled messages, communities, event RSVPs, orders as a buyer;
     - consents, assistant memory, security events (last 500), problem reports, username changes, sign-in devices;
     - weekly wraps, question box and questions, question blocks, chat games.
   - Separate work is adding the rest, without secrets such as password hashes, tokens and two-step secrets.
   - Before launch, check the export against the list below, which is what was missing then. The privacy policy now describes the export in general terms ("the information linked to your account"), so it stays true once the work is done. Confirm that it is true at launch.

   Missing when this pack was written:
   - **Selling:**
     - sales as a seller (orders through one's products);
     - products, drops (`drops`, `drop_items`), drop orders and holds (`drop_orders`);
     - payouts, tips sent or received, creator plans and subscriptions, refunds;
     - Plus grants, invite codes and referrals, ad campaigns and ad events.
   - **Waiting lists:** drop reminders (`drop_reminders`) and room reminders.
   - **Chats:**
     - chat wallpapers and bubble colours (`conversations.wallpaper`, `accent`);
     - conversation memberships and per-chat settings (`conversation_members`, including smart-reply switches);
     - pins, message reactions, polls and votes, lists, reminders;
     - game moves (`chat_game_moves`).
   - **Content:**
     - stories (`moments`), story views and responses;
     - media files and their metadata (`media`, edits, caption tracks);
     - boards, saves, memories, chapters, recaps, togethers, photo tags, collaborations, music saves.
   - **Places and events:** places, businesses, bookings, reviews, events created, communities created and FAQs.
   - **Live and rooms:** lives and live chat, rooms, calls.
   - **Watch together:** sessions, participants and queue items.
   - **AI and activity:**
     - AI caches (`ai_catchups`, `ai_reply_suggestions`), Pulse visits (`pulse_visits`), the AI call log;
     - analytics events, post and reel views, feed feedback, reel positions, daily minutes;
     - business-page visits.
   - **Account and security:**
     - settings (`user_preferences`: quiet hours, time zone, weekly wrap and alert switches), blocks, mutes, restrictions, friendships and requests;
     - notifications, sessions (IP address and device), passkeys and two-step factors (metadata), push subscriptions;
     - family links and teen controls, developer apps, API keys, OAuth grants, mini app installs.
   - **Safety:** reports made, moderation cases, appeals and enforcements about the person.

4. **Lives had no age rules: fixed.**
   - A teen's live is for their friends, an active guardian and followers under 18; adults who aren't friends can't see, join, chat, gift or buy a ticket. Live chat follows the messaging rule between adults and under-18s in every live. Section 6 has the details; tests in `apps/api/test/safety-gaps.test.ts`.
   - Audio rooms had a smaller gap: a teen who moderates a community could start a room and speak to every adult member. Teens no longer start or host rooms; they speak when invited, under the friends rule.
   - The safety page says so. There is no "adults only" setting for lives.
5. **Appeals: fixed.** A different moderator must decide an appeal; it waits if nobody else can. The terms and guidelines now say "a different moderator from the one who decided reviews every appeal". Reporters are now told the outcome too (section 7).
6. **Retention periods: set.** Payment records 7 years (configurable, `FINANCIAL_RECORDS_YEARS`); reports, cases, appeals and enforcements 2 years after the case closed (longer while the account stays suspended); call history 12 months; watch together 90 days after the end; ended games 12 months; username history 30 days after the hold; sign-in devices 13 months after last seen; business-page visits, Pulse visits, post and reel views and ad impressions and clicks 13 months. The daily clean-up (`apps/api/src/lib/retention.ts`) deletes them and the privacy policy states them.
   - Still to confirm: the payment period per country (a placeholder asks), and whether child-safety evidence needs longer preservation than 2 years (question 27).
   - Kept on purpose without a period: feed feedback (it is a setting), "hide this ad", risk signals, Plus grants, audio room history.
7. **Weekly wrap, Catch me up (Pulse visits), analytics, personalization, suggested replies (one-to-one) and sign-in alert emails are on by default.** Ads and assistant memory are off by default. See question 2.
8. **Metadata on old files:** files uploaded before 2026-09-27 may still carry location metadata. This only matters if real users uploaded before then (app-store.md).
9. **Copyright takedowns are handled by email.** There is no takedown tool: the "tell the person who posted it, with a copy of your notice" step is manual.

## 12. Open questions for the lawyer

Each question is specific to what the code does. The laws named are pointers for the review, not conclusions.

1. **Controller and establishments.** Which legal entity is the controller? Does it need an EU representative (GDPR Art. 27), a UK representative, a DPO, or a Nigerian, Kenyan or South African registration (NDPC; ODPC; the Information Regulator's Information Officer)?
2. **Legal bases.** For each purpose in section 4, is the basis claimed right?
   - In particular: analytics on by default; personalization on by default; the weekly wrap and Catch me up visit tracking on by default; business-page visit logging; sign-in device records; storing the email typed in failed sign-ins.
   - Does any of these need opt-in consent under the GDPR, the UK GDPR, Nigeria's NDPA 2023, Kenya's Data Protection Act 2019, South Africa's POPIA or Brazil's LGPD?
3. **Nigeria (NDPA 2023, GAID 2025).**
   - Is YAPILAPI a "data controller of major importance" (registration, fees, DPO, compliance audit returns)?
   - What are the rules for transfers abroad (Anthropic, Stripe, Twilio and AWS are US companies)?
   - How does the NDPA treat processing children's data (parental consent for under-18s)?
4. **Kenya (DPA 2019).**
   - Registration with the ODPC.
   - Section 33: processing a child's data needs parental consent and age verification, and a child there is under 18. How does that fit a 13+ service with self-declared ages?
   - Is a data protection impact assessment needed?
5. **South Africa (POPIA).**
   - A child is under 18, and processing a child's data generally needs a competent person's consent. The same question as for Kenya.
   - Information Officer registration.
   - Section 72 on transfers.
6. **Brazil (LGPD and the 2025 statute on children's digital protection, often called "ECA Digital").** If Brazil is served, what is required for adolescents (Art. 14 LGPD "best interest", parental supervision tools, age verification, default settings)? Are the current teen defaults enough?
7. **Age of digital consent per country.**
   - The app lets anyone from 13 sign up without parental consent. Its only mechanism is the terms' statement that a parent agreed "where the law requires it".
   - In which launch countries is a higher age or verifiable parental consent required (for example GDPR Art. 8 member-state ages of 13 to 16; US COPPA under 13; Kenya and South Africa under 18)?
   - Is self-declared date of birth an acceptable age check?
8. **UK and EU online-safety rules for children.** Do the UK Age Appropriate Design Code, the Online Safety Act 2023 (children's risk assessment, age assurance) or DSA Art. 28 (minors' protection; no profiling-based ads to minors) apply? Do the teen defaults meet them? Finding 4 (lives) is fixed.
9. **EU Digital Services Act, if EU users are served.**
   - Is YAPILAPI an online platform (it is at least a hosting service)?
   - What is needed for: a notice-and-action channel open to people without an account (Art. 16); statements of reasons, including to the DSA transparency database (Art. 17, 24(5)); internal complaints within 6 months of a decision (Art. 20, where today there is one appeal and no time limit); informing notifiers of outcomes; trusted flaggers (Art. 22); ad transparency, meaning who paid and the main targeting parameters (Art. 26, where a "why am I seeing this" sheet exists); recommender transparency and a non-profiling option (Art. 27, 38, where Personalization off exists); traceability of traders for the marketplace and drops (Art. 30); points of contact and a legal representative (Art. 11 to 13); transparency reports (Art. 15, 24)?
   - Which of these does the micro or small enterprise exemption remove?
10. **Hidden-name questions ("Ask me").**
    - The asker is hidden from the recipient and the public, but stored and visible to moderators, and may be disclosed to authorities. The page texts now say so.
    - Is "without your name shown" (instead of "anonymous") clear enough, and is the notice adequate?
    - Can the recipient obtain the asker's identity through a data access request, given that the export deliberately leaves it out? How do third-party rights weigh here?
    - Do laws on anonymous harassment or cyberbullying (for example Nigeria's Cybercrimes Act, Kenya's Computer Misuse and Cybercrimes Act) create preservation or disclosure duties?
    - Is it right that under-18s can ask questions without their name (they can't receive them)?
11. **Other people's data sent to the AI provider.**
    - Suggested replies and chat summaries send other chat members' messages to Anthropic when one member uses the feature. Catch me up sends friends' posts.
    - What legal basis and notice cover the people whose messages are sent, who didn't turn anything on? Is the per-reader switch enough, or is a chat-level or sender-level opt-out needed?
    - Does this need a DPIA?
12. **AI transparency and labelling.**
    - Do the EU AI Act's transparency duties (Art. 50: telling people they interact with AI; marking AI-generated content), or national rules, apply to the assistants, suggested replies, photo descriptions and caption ideas?
    - Is the current labelling enough?
    - Must AI-assisted posts be labelled for viewers, not just marked internally?
13. **Minors paying.** Minors can buy products, Plus and tickets, and tip adults. Do capacity-to-contract or parental-consent rules for purchases in the launch countries require limits?
14. **Collecting and holding sellers' money.**
    - YAPILAPI takes buyers' payments through Stripe or Paystack and pays sellers out later.
    - Is this a regulated payment service or e-money activity in any launch country (for example PSD2 and the commercial agent exemption in the EU; the CBN in Nigeria; the National Payment System Act in Kenya; the SARB in South Africa)? Or should Stripe Connect or Paystack split payments be used so YAPILAPI never holds funds?
    - What KYC and AML checks are needed before payouts (today: verified email, age 18+ and a manual review)?
15. **Consumer law for drops, products and refunds.**
    - Buyers have no in-app way to ask for a refund, and there is no withdrawal period.
    - Do EU and UK distance-selling rules (a 14-day withdrawal right; a digital-content exception only with express consent and acknowledgement) or consumer laws in Nigeria (FCCPA 2018), Kenya (Consumer Protection Act 2012), South Africa (CPA 2008, ECTA s.44 cooling-off) and Brazil (CDC Art. 49, 7 days) apply to sales on YAPILAPI? Who owes them, YAPILAPI or the seller?
    - Must sellers be identified as traders or consumers to buyers?
    - Are the drop mechanics fair: a 15-minute hold, a late payment refunded if sold out, and a pre-launch "Notify me"? Are any scarcity claims restricted by unfair-practices rules?
16. **Plus.**
    - A 30-day purchase without auto-renewal. What refund and cancellation rights apply?
    - Does free Plus for invites raise any promotion or referral rules?
    - Apple and Google in-app purchase requirements (app-store.md).
17. **Tax.**
    - VAT or GST on Plus, boosts and the platform fee (EU OSS, UK VAT; Nigeria's VAT on non-resident digital services; Kenya's VAT on digital marketplace supplies and Significant Economic Presence tax; South Africa's VAT on electronic services).
    - The tax treatment of tips and gifts.
    - Platform reporting of sellers' income (EU DAC7, and similar rules elsewhere).
    - Withholding on payouts.
18. **Advertising.**
    - Sponsored posts are targeted by interests, language and country (from the CDN), only for opted-in adults.
    - Are there ad-approval or content rules in launch countries (for example Nigeria's ARCON pre-exposure vetting) or disclosure rules for boosted posts?
    - Is the opt-in consent valid as designed?
19. **Music.**
    - Does Jamendo's API or licensing require a commercial agreement for YAPILAPI, which has ads, Plus and business accounts?
    - Can Creative Commons NC songs appear in personal posts on a platform that shows ads?
    - Are licences from collecting societies (for example COSON or MCSK, the Music Copyright Society of Kenya) needed for original sounds or live-stream background music?
20. **Copyright.**
    - Registration of a US DMCA agent.
    - Whether the EU DSM Directive Art. 17 applies (it is size-dependent).
    - The repeat-infringer policy wording.
    - The counter-notice jurisdiction wording for non-US users.
    - The user content licence in the terms, including remixes and reuse of original sounds.
21. **International transfers.**
    - Servers are in [Server region]. Anthropic, Stripe, Twilio, AWS, Expo, Apple and Google process data elsewhere, often in the US.
    - Which transfer mechanisms are needed per origin country (SCCs or the EU-US Data Privacy Framework; NDPA adequacy and transfer rules; Kenya's s.48 to 50; POPIA s.72; LGPD Art. 33)?
    - Which processors have signed DPAs?
22. **Retention.** Please confirm the periods in the privacy policy (section 5), including the ones set for finding 6. This matters especially for payment records (tax law, 7 years by default) and for moderation records (2 years after the case closes), including child-safety evidence preservation.
23. **Account deletion and export completeness.**
    - Is anonymising the account row, while keeping the linked rows in finding 2, acceptable as erasure?
    - Is keeping digital-product files for buyers after a seller deletes their account acceptable, and for how long?
    - Once the export work lands (finding 3), does it meet the rights of access and portability? That includes the format (JSON), the scope (only messages the person sent), and leaving out who asked a question without their name.
24. **Contact matching.** Salted SHA-256 hashes of contacts' email addresses (including non-users) are compared and not stored. Is that personal data of the non-users, and is the notice enough?
25. **Cookies and device storage.** Is browser and phone storage of preferences (theme, recent searches, the "On this day" dismissal, the minutes counter) exempt from consent under ePrivacy Art. 5(3) and national equivalents? Is a banner needed anywhere?
26. **Family links.** Nothing verifies that a guardian is the teen's parent. Is that acceptable, and what should the texts say?
27. **Child sexual abuse material.**
    - Which reporting duties apply in the launch countries?
    - To whom should reports go (NCMEC only applies to US providers; national hotlines; INHOPE members)?
    - Is hash matching expected?
    - What preservation periods apply?
28. **Law-enforcement requests.** What process and which contact are required per country? Emergency disclosure wording.
29. **Breach notification.** Deadlines and authorities per country (GDPR 72 hours; NDPA 72 hours; Kenya 72 hours; POPIA "as soon as reasonably possible").
30. **Terms enforceability.**
    - The liability cap (the greater of 12 months' payments or 100 USD).
    - Governing law and courts (see placeholders).
    - Whether sign-up without a checkbox is valid acceptance.
    - Whether minors can accept.
    - How changes to the terms must be announced.
31. **Business insights.** Visits to business pages are recorded per signed-in viewer and day, and owners see only totals. Is notice in the privacy policy enough?
32. **Watch together and sharing.** Is there any public-performance or copyright issue with people watching others' public reels together in a group chat? (It only uses content everyone in the chat can already see.)
33. **Security notices by email.**
    - The new-device email is on by default. Is that fine to send without opt-in (transactional)?
    - Must all transactional emails show an address and an unsubscribe link?
34. **Accessibility of the legal texts to minors.** Do the UK AADC or other rules require child-friendly summaries of the privacy policy and terms?
35. **Store disclosures.** Are the Apple privacy label and Google data safety answers in app-store.md consistent with this inventory? For example, are push tokens a "device ID", and does "coarse location" cover the CDN country?
36. **The "Now" status, the city and pronouns.** Do they count as special-category or sensitive data in any launch country (for example pronouns revealing gender identity)? Is extra care needed?
37. **Sign-in device records.** Are browser, system and country, kept until account deletion, proportionate, or should they expire?
38. **Speech-to-text.** If automatic captions are turned on with an OpenAI-compatible provider, which processor terms and transfer mechanisms apply? Does the audio include other people's voices?
39. **Mini apps and connected apps.**
    - Is YAPILAPI a joint controller with third-party developers?
    - What developer terms are needed? Developer terms don't exist yet.
    - Is the per-app pseudonymous id enough?
40. **Language of the legal texts.**
    - The texts are English only, with a note in each language.
    - Which launch countries require the terms or privacy policy in a local language? Examples: French in France or Quebec; Portuguese in Brazil under the consumer code; Arabic in some Gulf states.
    - Must translations be lawyer-approved before they are shown?
