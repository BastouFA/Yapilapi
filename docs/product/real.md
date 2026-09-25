# REAL

Scope: `apps/api/src/modules/real`, migration `260_real.sql`. Tests: `apps/api/test/real.test.ts`, `apps/api/src/modules/real/real.unit.test.ts`.
Flag: `REAL` (off means every endpoint answers 404 `feature_disabled`).

REAL is a way to share an in-the-moment photo (front, rear or both) together with an honest **authenticity receipt**: what the server could actually
verify about how and when the photo was taken. It is a receipt, not a badge of truth. It is our own design; it deliberately does not copy the
mechanics of any existing "daily unfiltered photo" product.

## Product decisions (anti-dark-pattern)

- **No forced daily prompt.** There is no global "everyone, now" moment, no countdown, and no late-shaming. A capture is something you start
  yourself, any time.
- **No streaks, no scores.** The API exposes no streak counter, no "days in a row", no penalty for skipping a day. Reaction counts are not a ranking.
- **Reminders are opt-in and quiet.** `real_reminder_settings.enabled` defaults to `false`. When turned on, the person picks weekdays and a local
  time; at most one reminder per local day, sent only within a 60 minute grace window after the chosen time, and never during the person's quiet
  hours (the notification policy is applied). A missed reminder is not retried or escalated.
- **No pressure to post publicly.** The audience is chosen at capture time and any capture can stay `private`. Sharing to the profile feed is a
  separate, explicit action.

## Authenticity, honestly

1. `POST /v1/real/capture-sessions` (body: `deviceId`, optional `clientTime`) returns a signed token
   `v1.<payload>.<signature>` (HMAC-SHA256, key derived from the data-encryption key, 10 minute TTL). The token is bound to the user and to a hash
   of `(user, deviceId)` and backed by a `real_capture_sessions` row.
2. `POST /v1/real/captures` must present that token. It is **single use** (the session's `used_at` is claimed as part of saving, and a unique
   index on `capture_session_id` backs it up), and is refused for another user, another device, or an expired or tampered token.
3. The server computes the receipt (`authenticity`, a pure function in `authenticity.ts`); the client cannot supply it. Checks include: the
   capture time is not in the future beyond a 2 minute clock tolerance, the upload arrives within 10 minutes of capture, and the reported clock
   skew is within tolerance. Declared edits (crop, filter...) are recorded as `edited: true` with the list.
4. `indicators` translate the receipt into human-readable rows (`unedited`, `device_attested`, ...) so a UI can show exactly which checks passed and
   which did not.

**What this does and does not prove.** With the default `none` verifier the receipt proves "captured through the app flow, close to upload time,
by this account on this device id". It does **not** prove the pixels came from a camera sensor. `device_attested` is `false` and `assurance` is
`in_app` unless a real hardware attestation verifier is installed.

`AttestationVerifier` (`{ provider, verify(input) }`) is the plug-in point for Apple App Attest / Google Play Integrity
(`setAttestationVerifier(ctx, verifier)`). Only when a verifier returns `attested: true` does the receipt say `device_attested: true` and
`assurance: 'attested'`. The capture-session response reports honestly whether attestation is available. **Gap:** no real platform verifier is
shipped (it needs store credentials); only the interface and the `none` implementation exist.

## Visibility matrix

Same audiences as posts and moments, without expiry (a Real lives until its author deletes it).

| Audience    | Who can open it                                                            |
| ----------- | -------------------------------------------------------------------------- |
| `public`    | Anyone, unless the author's account is private, then only active followers |
| `followers` | Active followers                                                           |
| `friends`   | Accepted friends                                                           |
| `circle`    | Members of the chosen circle                                               |
| `selected`  | Only people listed in `real_capture_audience`                              |
| `private`   | Only the author                                                            |

Always: the author sees their own capture, blocked pairs (either direction) see nothing, deleted captures and deleted/suspended authors are
invisible, and a capture held by moderation is visible to the author only. One rule (`realVisibleSql`) is shared by the API and by the central
media access check, so the image files follow the same audience as the capture.

## Endpoints

| Method       | Path                             | Purpose                                                                           |
| ------------ | -------------------------------- | --------------------------------------------------------------------------------- |
| POST         | `/v1/real/capture-sessions`      | Start a capture (signed single-use token)                                         |
| POST         | `/v1/real/captures`              | Save a Real with a server-computed receipt                                        |
| GET          | `/v1/real/captures`              | My Reals                                                                          |
| GET / DELETE | `/v1/real/captures/:id`          | Read (audience-checked) / delete (also deletes the media)                         |
| PUT / DELETE | `/v1/real/captures/:id/reaction` | React / remove reaction (visible captures only)                                   |
| POST         | `/v1/real/captures/:id/share`    | Share to profile: creates a normal post whose `metadata.real` carries the receipt |
| GET          | `/v1/real/tray`                  | Reals from people the viewer can see, newest first, no "unseen" pressure          |
| GET / PUT    | `/v1/real/reminders`             | Opt-in reminder settings                                                          |
| GET          | `/v1/real/posts/:id`             | The receipt for a shared post                                                     |

## Safety and privacy

- Caption text is screened with the shared text classifier; a hit holds the capture (`moderation_status`) and opens a moderation case
  (`real_capture`).
- Location is optional and stored only when the author supplies it.
- Data export includes a `real` section. Account deletion removes captures, media, reactions (including other people's reactions on the deleted
  user's captures) and reminder settings.
- Share-to-post uses the ordinary content pipeline, so it inherits post moderation, blocks and age rules.

## Known gaps

- No hardware attestation verifier ships; receipts say `in_app` honestly.
- Reminders are produced by `runRealReminders`, which the deployment's scheduler must invoke.
- No image forensics (for example detecting a photo of a screen).
