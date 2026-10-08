# Speak any language

Everything people write, say or show on YAPILAPI reaches everyone in their own language. A
grandmother in Kano reads her grandson's posts from Lyon in Hausa; he reads her replies in
French; neither of them has to tap anything. This is YAPILAPI's flagship direction. It comes in
three steps, each useful on its own.

## The three steps

1. **Text everywhere (built, below).** Posts, comments, story text and chat messages in a
   language the reader doesn't understand are shown translated, with a quiet "Translated from
   Hausa · See original". Videos that already have captions get them in the reader's language
   too. "See translation" stays for everything that isn't translated automatically.
2. **Voice notes in Yap.** A voice note in a chat is transcribed (the speech-to-text provider in
   `apps/api/src/lib/transcription.ts`, off in production until one is chosen), the transcript
   is translated like a message, and the listener can read it or hear it read in their language
   by a plain synthetic voice that is clearly not the sender's. Videos without captions get
   automatic captions the same way, and then step 1 translates them.
3. **Dubbing in the creator's own voice (opt-in).** A creator can choose to have their reels
   dubbed into other languages in a voice made from their own. Off unless the creator turns it
   on, for their own videos only.

### Safety rules for all three

- **Machine translation is always labelled.** A translation never passes for the original:
  "Translated from French" with "See original" one tap away, "Machine translation" for
  screen readers (and as a tooltip on the web). Translated caption tracks say "(translated)".
- **Nobody sees more than they could before.** A translation is made from, and shown to,
  someone who can see the original right now: audience, blocks, private accounts, regional
  rules, subscriptions, chat membership. A cached translation is never a way around that.
- **Removing the original removes its translations.** An edit, deletion or unsent message
  deletes every translation of the old words (database triggers, 0035 and 0084).
- **#tags, @names, links and email addresses never reach the model** and come back unchanged
  (`protectForTranslation` in `packages/shared/src/language-detect.ts`).
- **The model's output goes through the safety layer** (the AI gateway's output check); a
  withheld translation simply isn't shown.
- **Voices (steps 2 and 3).** No one's voice is ever cloned without their explicit, revocable
  consent, given in settings and not as part of another flow; consent is per person, never
  inherited by reposts, duets or echoes. A dubbed video is labelled "Dubbed with AI in
  {name}'s voice" wherever it plays, keeps the original audio one tap away, and is never made
  for minors' accounts, for political or election content, or for ads. Turning the choice off
  deletes the voice model and the dubbed tracks. Synthetic voices for voice notes are generic,
  never the sender's.
- **Cost stays bounded.** Per-person and daily limits, one translation shared by every reader,
  and a feature flag that turns automatic translation off for everyone at once.

## Step 1 in detail: text everywhere

### For readers

- **Settings > Language > Translation** (web, the phone app and Yap, the same account setting):
  "Languages I understand" (the app's language always counts and can't be unticked) and
  "Translate automatically", **on by default**. Migration 0084 turns it on for everyone: it
  was off by default before, and a choice can't be told apart from the default.
- Text in a language the reader understands is never translated, automatically or not.
- With "Translate automatically" on, a post, comment, story text or chat message in another
  language shows its translation in place of the original, with "Translated from {language} ·
  See original" under it. Tapping toggles back and forth; the choice is remembered per item
  for the session (`chosen` in the clients' translation modules). The rest gets "See
  translation" as before: text in a language that couldn't be told, too short to be worth it
  (only emoji, tags, names or links, or one capitalised word, which is usually a name:
  `worthTranslating` in `packages/shared/src/translation.ts`), view-once messages, and
  everything once a limit is reached.
- Where it applies: Pulse (For you, Following, Friends, Communities), post pages, comments,
  reels captions, stories, and chats (web chat, Yap mode on the web, the phone chat, which the
  Yap app shares). Profile grids show pictures only, so they have nothing to translate.
- **Captions.** A video with caption tracks but none in the reader's language also offers
  "{language} (translated)" in the player's caption menu (web) and uses it when captions are on
  (phone, which names it under the Captions switch in the reel's options). It's only made when
  chosen, then kept for everyone. A video without captions doesn't change; step 2 handles speech.

### How it works

- **Language at write time.** `lang` columns on posts, comments, moments and messages (0035),
  filled by the offline detector.
- **One translation per item, target language and version of the text**, shared by every
  reader (`translations`, keyed by a SHA-256 of the text). Edits and deletions remove it.
- **Batches, only for what's on screen.** `POST /v1/translations` takes up to 50
  `{ kind, id }` and the target (the reader's app language). Each item goes through exactly the
  permission check of "See translation" (`loadTranslatables`, one query per kind); anything the
  reader can't see is silently left out, like an id that doesn't exist. Cached translations come
  back at once. Missing ones are made, at most 4 at a time per server process; whatever isn't
  ready after 3.5 seconds comes back as `pending`, and the clients ask again a few times. Two
  readers asking for the same new translation at the same moment share one model call.
- **Clients** (`packages/design-system/src/translation.tsx` on the web, `apps/mobile/lib/translation.tsx`
  on the phones) ask only for text that is on screen or about to be: an IntersectionObserver
  (300px ahead) on the web, a light position check on the phone (React Native has no observer).
  Requests wait 120-150 ms to gather everything that appeared, deduplicate what's already being
  asked, and keep what came back for the session, so scrolling back costs nothing.
- **Recommendations.** For you and Reels already ranked posts in any language; they now prefer
  what the reader can read, mildly: a suggestion (not from people or communities they follow) in
  a language they don't understand scores −0.4 when it reaches them translated and −1.5 when they
  would have to tap "See translation" (`RANKING.weights.unreadLanguage*` in
  `apps/api/src/lib/ranking.ts`). A good post in another language still gets through.
- **Inline translations in list responses** (feeds sending the reader's cached translations
  with the posts) were left out of step 1: the batch request already returns cached ones in one
  round trip, and putting them in every list endpoint would touch every hydrator. Worth doing
  if the extra request shows up in measurements.

### Cost and safety controls

| Control | Default | What happens past it |
| --- | --- | --- |
| `AUTO_TRANSLATE` feature flag (Admin > Feature flags) | on | No automatic translation for anyone; "See translation" still works |
| `AI_TRANSLATION` feature flag | on | No translation at all |
| A real translation model | `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` | With the offline stand-in, automatic translation is off (and translated captions aren't offered) and turns on by itself once a key is set. In production the stand-in doesn't answer "See translation" either ("Translation isn't available right now"), so its marked pseudo-translations never reach people. Pseudo-translations already cached are deleted (0084) and never served as real ones |
| `AI_TRANSLATE_MODEL` | `claude-sonnet-5-5` | The model for translations only (item text and caption tracks); `AI_MODEL` stays for the other AI helpers |
| `AUTO_TRANSLATE_PER_HOUR` | 200 new translations per person per hour (cached ones are free) | That person gets "See translation" for new items for a while (the apps pause for 5 minutes) |
| `AUTO_TRANSLATE_DAILY_LIMIT` | 20,000 new translations a day (UTC) for everyone, caption tracks counted per 50 lines | Everyone gets "See translation" for new items until midnight UTC |
| `TRANSLATE_PER_HOUR` | 300 "See translation" requests per person per hour | Unchanged; caption tracks count here too |

The clients learn whether automatic translation works from `GET /v1/flags` (`autoTranslation`:
both flags on and a real model), and the batch answer says `auto: false` when a limit stops it.
Every automatic translation is in the AI audit log (`ai_tool_calls`, scope `auto`; cache hits
as one entry per batch).

### Rough cost

With Claude Sonnet 5.5 at $2 per million input tokens and $10 per million output tokens, a
typical post or message (system prompt about 120 tokens, text 50 to 100, the same again out,
plus a little thinking at low effort) costs about **$0.001 to $0.002** to translate, once for
everyone who reads it in that language. At the default daily budget that is at most about
**$20 to $40 a day** (roughly $600 to $1,200 a month) however busy the app gets; most days will
be far below it because popular posts are translated once and read many times. A caption track
costs about $0.02 per 50 lines.

### Tests

`apps/api/test/auto-translation.test.ts`: visibility (audiences, blocks, stories, chats,
cached translations never leaking), one translation shared by readers, understood languages,
short text and view-once messages skipped, edits, the reader's switch and the flag, the hourly
limit and the daily budget, the offline stand-in (and production refusing it), pending answers
and readers sharing one model call, caption tracks, and the recommender's preference.
`apps/api/test/translation.test.ts` keeps covering "See translation".
