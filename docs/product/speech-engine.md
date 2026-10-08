# The speech engine

YAPILAPI is becoming the social network you speak. Three pieces turn speech into something
everyone understands, whatever language they read, and every voice feature (voice messages in
chats today; Yaps, Radio and Today later) builds on them:

| Piece | What it does | Code | Provider setting |
| --- | --- | --- | --- |
| Speech-to-text | Audio in, words and their language out | `apps/api/src/lib/transcription.ts` | `TRANSCRIBE_PROVIDER` (`none` or `openai-compatible`) |
| Translation | Words into the reader's language, labelled as machine translation | `apps/api/src/lib/translation.ts`, `AiGateway.translateItem` / `translateMany` | `AI_PROVIDER`, `AI_TRANSLATE_MODEL` |
| Text-to-speech | Words read out by a plain synthetic voice, as a cached audio clip | `apps/api/src/lib/speech.ts` | `TTS_PROVIDER` (`none` or `openai-compatible`) |

There is no fake voice and no fake transcriber. When a provider isn't configured, what needs it is
simply unavailable: the API says so (`GET /v1/flags`) and the apps don't offer it. The translation
model has an offline stand-in for development; it never translates voice messages (only a real
model does), and production refuses it.

## For people

**Voice messages in chats** (voice notes and Hold-to-Yap clips; web chat, Yap mode on the web, the
phone chat, which the Yap app shares):

- A moment after a voice message is sent, **Show text** appears under it. It opens what was said.
- In a language the reader doesn't understand (the same rules as automatic translation: the app's
  language and "Languages I understand", with "Translate automatically"), the words show
  translated, with "Translated from French · See original", and **Listen in English**: the
  translation read out by a plain synthetic voice, clearly not the sender's. It's made the first
  time anyone taps it, then shared by everyone in the chat who listens in that language.
- The push for a voice note says its first words when they're ready in time ("Ada: Voice message:
  See you at six, and bring…"); the push waits up to 15 seconds for them.
- **Settings > Privacy > AI helpers > Transcribe my voice messages** (also in Yap's settings), on
  by default. Off: no transcript is made of your voice messages, and the ones already made are
  deleted, with their translations and spoken clips.

## Privacy

- **Only the chat's members**, through the message's own checks: someone who left, someone who
  blocked the sender, someone who deleted the message for themselves, and anyone outside the chat
  never gets the words (`loadTranslatables`, kind `transcript`). A message held for review: only
  its sender. A voice clip taken down by moderation has no words to show; one marked sensitive
  shows them only to those who see sensitive media.
- **Never for view-once or disappearing messages.** They aren't transcribed, translated or read out
  at all, and their pushes never say more than what they are.
- **Deleted with the message.** Unsending, deleting or a message disappearing deletes its transcript
  (database triggers and a foreign key, migration 0089), which deletes its translations and what
  spoken clips are for; the worker then deletes clips nothing is for any more, with their files,
  within a minute (`sweepSpeech`).
- **What leaves the server**: the voice clip goes to the speech-to-text provider; the transcript to
  the translation model (#tags, @names, links and emails stay out); the translated words to the
  text-to-speech provider. Never names, ids or anything else.
- **Safety layer**: a transcript the safety check says may put someone at risk is not written out;
  translations go through the AI gateway's output check like every translation.
- **Audit log** (`ai_tool_calls`, never the words): `transcribe` (per message, the sender as the
  person), `translate` (scope `transcript:<id>`), `speak` (cached answers with scope `cache`).
- **Data export**: `chats.voiceTranscripts` holds the transcripts of your own voice messages only,
  and `settings.preferences.transcribe_voice` your choice.

## For builders: `speak(text, lang)`

`apps/api/src/lib/speech.ts`:

```ts
import { speak } from '../lib/speech.ts';

const clip = await speak(
  { db: ctx.db, storage: ctx.storage, speech: ctx.speech, config: ctx.config },
  { text, lang: 'fr', source: { kind: 'yap', id: yapId }, userId: listener.id },
);
// clip.url: an MP3 in storage, shared by everyone; clip.cached: made before.
```

- One clip per text, language, voice and model (a SHA-256 of the text; the text itself isn't
  stored), kept in storage and shared by every listener. Cached clips are free.
- `source` says what the clip is for. When that thing goes, call `forgetSpeech(db, source)` (or
  delete it in a trigger, as transcripts do); the worker's sweep deletes clips nothing is for.
- `userId` counts a new clip against that person's hourly cap (`TTS_PER_HOUR`). Leave it out for
  clips the server makes on its own.
- It throws `speech_unavailable` (503, "Listening isn't available right now") with no provider,
  past the day's budget, for text over 4,000 characters or when the service fails, and
  `speech_limit` (429, the same words) past the person's cap. Check `ctx.speech` first to hide the
  feature instead.
- **The caller checks who may hear the text.** `speak` only reads it out.
- Voices are generic (`TTS_VOICE`, or `TTS_VOICES` per language). Never a person's own voice; that
  is step 3 of `docs/product/speak-any-language.md` and needs its own consent.

Transcribing for other features: `ctx.transcription.transcribe({ audio, filename, mime })` returns
WebVTT (`parseVtt` in `lib/webvtt.ts`); `lib/voice-transcripts.ts` shows a job around it (eligibility
checks again when it runs, the safety check, the language from the offline detector).
Translating: add a `TranslatableKind` with its permission query in `loadTranslatables`, and the
batch endpoint, the cache and both apps' `useTranslatable` work as they are.

## How voice messages work

1. Sending (`sendMessage` in `modules/messaging.ts`): a voice note or Yap (one audio clip, not view
   once, not disappearing), with `VOICE_TRANSCRIPTS` on, a provider, and the sender's switch on, gets
   a `message_transcripts` row (`pending`) and a `voice.transcribe` job. A voice note's push is sent
   by that job instead.
2. The job (`lib/voice-transcripts.ts`) checks everything again, sends the clip to the provider,
   joins the WebVTT lines, detects the language and stores `ready` (or `empty` when nothing was said,
   `failed` when the provider failed or the safety check withheld it). Members who see the message
   get `message.transcript` live. Then the push goes out (it waits at most 15 seconds).
3. Reading: messages carry `transcript: { text, lang }` (only `ready` ones, only while the flag is on
   and a provider configured, only where the clip itself is shown).
4. Translating: kind `transcript` (the message's id) in `POST /v1/translations` and `/v1/translate`,
   cached in `translations` like everything else.
5. Listening: `POST /v1/messages/:id/transcript/speech { target }` → `{ url, language }`: the same
   permission check, the cached translation (made if missing, within the "See translation" limit),
   then `speak`.

## Flags and settings

| Setting | Default | Effect |
| --- | --- | --- |
| `VOICE_TRANSCRIPTS` flag | on | Voice messages get transcripts. Effective only with `TRANSCRIBE_PROVIDER` |
| `VOICE_TRANSLATION` flag | on | Transcripts are translated and can be heard. Effective only with transcripts, `AI_TRANSLATION` and a real translation model; listening also needs `TTS_PROVIDER` |
| `GET /v1/flags` | | `voiceTranscripts`, `voiceTranslation`, `voiceListen`: what works here right now |
| `TRANSCRIBE_API_URL`, `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` | OpenAI `whisper-1` | Production: Groq, `https://api.groq.com/openai/v1`, `whisper-large-v3-turbo` |
| `TTS_API_URL`, `TTS_API_KEY`, `TTS_MODEL`, `TTS_VOICE`, `TTS_VOICES` | OpenAI, `gpt-4o-mini-tts`, `alloy` | Any OpenAI-compatible `POST /audio/speech`; MP3 output |
| `TTS_DAILY_CHAR_LIMIT` | 200,000 characters a day (UTC), everyone together | Past it: "not available right now" until midnight UTC |
| `TTS_PER_HOUR` | 30 new clips per person per hour | Past it: "not available right now" for that person |

Production setup: `docs/operations/launch-setup.md`, sections 7 and 8. Keys are `sync: false` in
both `render.yaml` and `render.free.yaml`.

## Rough cost

Prices change; check them when signing up.

- **Speech-to-text**: Groq's `whisper-large-v3-turbo` is about $0.04 per hour of audio (billed with
  a 10-second minimum per request), so a 20-second voice note costs well under a tenth of a cent;
  100,000 voice notes a day is roughly $20 to $40. OpenAI `whisper-1` is about $0.006 a minute,
  several times more. Every voice note is transcribed once, whoever reads it.
- **Translation**: as for any message (about $0.001 to $0.002 each with Claude Sonnet 5.5), once
  per target language, and only when someone who needs it reads it.
- **Text-to-speech**: OpenAI `tts-1` is about $15 per million characters; `gpt-4o-mini-tts` is
  priced per minute of audio and comes to a similar order. A 300-character translation is about half
  a cent, once per language for everyone. The default daily budget (200,000 characters) caps it at
  about $3 a day.

## Tests

`apps/api/test/voice-messages.test.ts` (stand-in providers; nothing paid is called): the job and the
flags, members only (outsiders, blocks), Yaps, silence and failures, view-once and disappearing
messages left out, the sender's switch, translation for a reader who doesn't understand (made once),
spoken clips shared by listeners and the hourly cap and daily budget, deletion cascades with the
sweep, the data export, no provider, and the push text. `apps/web/e2e/voice-messages.spec.ts`: a
French reader sees "Show text", the translation and "Listen in French".
