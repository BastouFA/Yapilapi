# Build status against the master directive

Last updated 2026-09-25 (second pass). Legend: **Built** = UI + API + database + validation + authorization + tests. **API** = working, tested endpoints without a dedicated UI yet. **Schema** = tables and design exist, no endpoints. **Not started** = nothing yet.

## The first integrated flow (directive §60)

Sign up → profile → interests → follow → Home → Discover → create post → post appears → like → comment → follow user → message → create group → community: **Built and covered end to end** by `apps/api/test/flow.test.ts`, and verified through the web app's proxy.

## Domains

| # | Domain | Status | Notes |
| --- | --- | --- | --- |
| 1 | Identity | Built | Register, login, logout, email verification, password reset/change, sessions and devices, security events, account deletion, data export, two-step verification (TOTP + recovery codes), **passkeys** (WebAuthn, usernameless sign-in). |
| 2 | Profiles | Built | Avatar, bio, links, interests, counts, personal/creator/professional/business modes, private accounts. Cover upload UI not yet. |
| 3 | Social graph | Built | Follow, friends with requests, block, mute. Restrict and circles: API; circles management UI not yet. |
| 4 | Content | Built | Text, photo, video, carousel, audio, poll, link, community, event- and product-linked posts; visibility public/followers/friends/circle/selected/private; moderation status, rights and AI provenance fields. |
| 5 | Media | Built | S3-compatible storage, resumable uploads, background processing: photos resized to webp (thumb/medium/large) with location metadata stripped and a blurred placeholder; videos get a poster, a web MP4 and 2-rung adaptive HLS (360p/720p) via bundled ffmpeg. |
| 6 | Feed | Built | For You (ranked: affinity, interests, engagement, freshness, feedback, diversity), Following, Friends, Communities, Local; cursor pagination; more/less like this, not interested, mute topic/creator, "why am I seeing this". |
| 7 | Discovery | Built | Discover page, NOW surface, communities and events. Creators/businesses/products tabs are search-driven. |
| 8 | Search | Built | Universal search over people, posts, communities, events, places, businesses, products, topics with natural-language intent ("something to do tonight", "restaurants for six"). Postgres full-text now; OpenSearch adapter later (ADR-0004). |
| 9 | Messaging | Built | 1:1, groups, community chats, realtime over WebSocket + Redis, typing, read state, idempotent sends, reactions (API), plans. Voice messages, file attachments UI: not yet. |
| 10 | Calls | Built | 1:1 and small-group audio/video over WebRTC, signaling relay, history, missed/declined, blocked users can't call; coturn relay with time-limited credentials for strict networks. |
| 11 | Communities | Built | Create, discover, join (public/private with approval), roles owner→guest with rank rules, bans, feed, chat, events, AI catch-up. Voice rooms, resources: not started. |
| 12 | Moments | Built | 1h/24h/permanent, visibility, viewer strip. Music and dual capture: not started. |
| 13–14 | Real, Real Together | Built (behind `REAL` / `REAL_TOGETHER`) | Real: in-app camera capture only (media must be minutes old and unused), front + back, time-labelled, three a day, friends/followers feed. Real Together: shared members-only moments where friends or people at the same event add their own photos. |
| 15 | Memory | Built (behind `MEMORY`) | Private collections, memories from attended events, On this day, add posts from any post menu, share with friends, AI recap limited to what the owner can see. Auto-generated videos: not started. |
| 16 | Creator Studio | Built (foundation) | 28-day analytics, follower growth, top posts, earnings. Editing, captions, clips: not started. |
| 17 | Creator economy | Built | Monthly subscription plans, tips on profiles/posts/lives, payment through the provider with activation on the signed webhook, 5% platform fee, earnings, payouts with verification. Subscriber-only posts, gifts, brand deals, ads: not started. |
| 18 | Live | Built (behind `LIVE`) | MediaMTX: streaming software publishes RTMP with a per-session key checked by the API; viewers watch low-latency HLS with signed, per-viewer tokens (hls.js in browsers). Chat, Q&A, roles, bans. Gifts, ticketed lives, auto-clips: not started. |
| 19 | Events | Built | Create, discover, RSVP with capacity and waitlist, attendees, host notifications, community events, time zones. Ticketing via products (kind `ticket`). |
| 20 | Places | Built | Place profiles, hours, map link, events, products, nearby search, **reviews and ratings**, **booking requests** with capacity per time slot and owner confirm/decline. |
| 21 | Business | Built (foundation) | Business profiles, places, products. Business analytics/AI assistant: not started. |
| 22 | Commerce | Built | Products, services, tickets, bookings, digital; idempotent orders; stock. Cart and checkout UI minimal (Buy button). |
| 23 | Payments | API | Provider abstraction, signed webhooks, replay protection, amount reconciliation, refunds, platform fees, payouts. Real provider: needs account. |
| 24–25 | AI, recommendations | Built | Gateway → permission → context → router → safety → audit log; caption, summaries, search intent, plans, translation; Claude adapter + offline dev provider; evaluation suite. Agents: not started. |
| 26 | Notifications | Built | In-app + realtime, categories, pause, focus mode, **browser push (VAPID)** and **mobile push (Expo)**, dead-token cleanup. |
| 27 | Trust & safety | Built | Automated analysis, reports, cases, moderator console, decisions, enforcement, appeals, audit trail. |
| 28 | Minor safety | Built (core) | Minimum age 13, minors private by default, adults can't DM minors unless friends, minor-safety reports hide content immediately. Parental controls: not started. |
| 29 | Privacy | Built | Privacy center: data summary, consents, export, deletion, AI memory. |
| 30 | Security | Built | scrypt, hashed session tokens, httpOnly cookies, rate limits, RBAC, audit logs, security headers, SameSite cookies, TOTP and passkeys, scoped API keys and OAuth, SSRF-safe webhooks, EXIF stripping. |
| 31 | Analytics | Built | Event instrumentation, meaningful-action North Star, admin overview. |
| 32 | Administration | Built | /admin: moderation queue, overview, feature flags, audit log; user status/role API. |
| 33 | Developer platform | Built | Developer apps, scoped API keys, signed webhooks, and Sign in with YAPILAPI (OAuth 2.0 code flow with mandatory PKCE, exact redirect matching, rotating refresh tokens, connected-apps list with revoke). |
| 34 | Mini apps | Built (behind `MINI_APPS`) | Developer submission, admin review, installs per conversation/community/event/profile/business with permission checks, sandboxed iframe host with a postMessage bridge, signed context tokens with a verify endpoint, user-confirmed actions. |
| 35 | Internationalization | Built (core) | All UI strings through `t()`, English/French/Arabic catalogs, RTL switching, Intl dates/money. Many strings still need translation. |
| 36 | Accessibility | Built (core) | Keyboard focus rings, ARIA roles, alt text on upload, reduced motion, contrast-checked tokens. Formal audit not done. |
| — | Low bandwidth | Partial | Cursor pagination, lazy images, reduced motion, resumable uploads with retry. Image compression/variants: not started. |
| — | Mobile | Built (core) | Expo app: Home, Discover, Create, Inbox + chat, Profile, Real capture (expo-camera), push registration. Type-checks and the iOS bundle builds; not yet run on a device. Calls on mobile need a development build with WebRTC. |
| — | Design system | Built | Tokens, light/dark themes, 11 primitives, 20 social components; published reference artifact. |
| — | CI/CD, observability | Built | CI workflow, Dockerfiles, health/readiness, Prometheus metrics and alerts, structured logs with request ids. Tracing: not started. |

## Not built yet

- Creator Studio editing tools (trim, captions/subtitles, clips, AI highlight detection).
- Live gifts, ticketed lives, live shopping, auto-translation, auto-clips.
- AI Discover, community FAQ and duplicate-question detection, AI agents (travel, shopping, business).
- Advertising and campaigns; business analytics and business AI assistant.
- Parental controls; regional moderation rules; more translated languages.
- Load/performance tests, a formal accessibility audit, distributed tracing (OpenTelemetry).
- Calls on mobile (needs an Expo development build with react-native-webrtc); running the mobile app on devices.
