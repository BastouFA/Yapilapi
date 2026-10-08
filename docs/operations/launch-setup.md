# Launch setup: the outside services only the owner can switch on

Everything in the code is ready for these services. What's missing is an account, a key or a
decision, and those have to come from you. Each section below lists what to create, what to paste
where, and how to check it worked.

After each step, run the launch check. It reads the same settings as the server, never prints a
secret, and says for each service whether it is set up and answering:

```bash
pnpm --filter @yapilapi/api launch:check
```

On Render, run it from **yapilapi-api > Shell** instead (the image has no pnpm):

```bash
cd /app/apps/api && node --import tsx scripts/launch-check.ts
```

Locally the settings live in `.env` at the root of the project (copy `.env.example` if it doesn't
exist). In production they are environment variables on the API service (`render.yaml` lists them;
`docs/operations/deploy-render.md` starts with the go live checklist). Never put a key in the code or
in a commit. A setting left empty counts as unset.

| # | Service | Needed for launch | Time | Cost |
| --- | --- | --- | --- | --- |
| 1 | Email (SMTP) | Yes: sign-up, password reset and security emails | 30 minutes plus DNS wait | Free tier is enough to start |
| 2 | Anthropic (AI helpers) | No: the app works with the built-in stand-in | 10 minutes | Pay per use; set a monthly limit |
| 3 | Jamendo (music) | No: in-app sounds work without it | 15 minutes | Free for non-commercial use; see the note |
| 4 | Lawyer review | Yes, before a public launch | Their time | `docs/legal/review-pack.md` |
| 5 | Apple and Google developer accounts | Yes, for the store apps | 1 to 3 days of checks | Apple yearly fee, Google one-time fee |
| 6 | How iPhone purchases work | Yes, before App Store review | A decision | `docs/operations/in-app-purchases.md` |
| 7 | Speech-to-text (automatic captions, voice message transcripts) | No: people can still write captions; voice messages just have no text | 10 minutes | Pay per minute of audio |
| 8 | Text-to-speech ("Listen in French" under translated voice messages) | No: the button isn't offered | 10 minutes | Pay per character; `TTS_DAILY_CHAR_LIMIT` caps it |

## 1. Email

The API sends plain-text emails through any SMTP relay: confirming an email address, password
resets, sign-in alerts from a new device, and security notices. Production refuses to start
without it.

**Pick a provider.** Any SMTP relay works. Resend, Postmark, Brevo, Amazon SES and Mailgun all do.
Resend is the simplest with this app (`docs/operations/deploy-render.md` has its exact address).
Check each one's current free tier and prices when you sign up.

**Use your own domain.** Emails from a free address (gmail and the like) land in spam or are
refused. Buy the domain the app will live on first if you haven't.

**Steps:**

1. Create the account and add your domain in the provider's dashboard.
2. The provider shows DNS records to add at your domain registrar. Add all of them. They are usually:
   - **SPF**: a TXT record on the domain, for example `v=spf1 include:<provider's value> ~all`.
     If the domain already has an SPF record, merge the `include:` into it; a domain must have only one.
   - **DKIM**: one or more CNAME or TXT records the provider gives you (their names look like
     `resend._domainkey`).
   - **DMARC**: a TXT record on `_dmarc.yourdomain.com`. Start with
     `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` and move to `p=quarantine` once emails
     arrive reliably for a couple of weeks.
3. Wait until the provider shows the domain as verified (minutes to a few hours).
4. Create an SMTP login or API key and set:

   ```
   EMAIL_TRANSPORT=smtp
   SMTP_URL=smtps://<user>:<password or API key>@<smtp host>:465
   EMAIL_FROM="YAPILAPI <hello@yourdomain.com>"
   ```

   If the password contains `@`, `:` or `/`, replace them with `%40`, `%3A` and `%2F`.
5. Check it, sending a real test email to yourself:

   ```bash
   pnpm --filter @yapilapi/api launch:check --send-email you@yourdomain.com
   ```

   Then sign up with a new address in the app and make sure the confirmation email arrives
   (and not in spam).

## 2. Anthropic API key (AI helpers)

Without a key the AI helpers use a built-in stand-in that gives fixed answers. That covers
catching up on Pulse, suggested replies in chats, photo descriptions and caption ideas.
With a key they use Claude.

1. Create an account at https://console.anthropic.com and add a payment method.
2. **Set a monthly spend limit first** (Settings > Limits). Every AI request is rate-limited per
   person in the app, but a limit on the account is the real safety net.
3. Create an API key (Settings > API keys). Name it after the environment, for example
   `yapilapi-production`, and use a separate key for staging.
4. Set (on Render, `AI_PROVIDER` is already `anthropic`, so pasting the key is enough):

   ```
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=<the key>
   AI_MODEL=claude-opus-5
   ```

   `claude-opus-5` gives the best answers. The helpers are short, so the cost per request is small,
   but if the monthly bill matters more than quality, a smaller model can be set in `AI_MODEL`;
   check the current model list and prices on the Anthropic site.

   Translations have a model of their own, `AI_TRANSLATE_MODEL` (default `claude-sonnet-5-5`):
   with a key set, posts, comments, stories and messages are translated for readers
   automatically (docs/product/speak-any-language.md). Until then automatic translation stays
   off and "See translation" says translation isn't available. The spend is capped by
   `AUTO_TRANSLATE_DAILY_LIMIT` (default 20,000 new translations a day, roughly $20 to $40) and
   `AUTO_TRANSLATE_PER_HOUR` per person; Admin > Feature flags > `AUTO_TRANSLATE` turns it off.
5. Check it: the launch check sends one tiny request and shows the model that answered.

What is sent: only what a helper needs at that moment (the recent messages of the chat you are in,
the photo being described, posts from people you follow for catch-up). Every AI answer is labelled
"AI-generated" in the app. This belongs in the privacy policy and is covered in the lawyer's pack.

## 3. Jamendo client id (music from outside the app)

Without it, the music picker offers the in-app sounds only. With it, people can also add songs
from Jamendo's Creative Commons catalogue, and the app only offers songs whose licence allows it.

1. Create an account at https://devportal.jamendo.com and create an application.
2. Copy its **client id**; the secret isn't needed.
3. Set `JAMENDO_CLIENT_ID=<client id>`.
4. Check it: the launch check runs a search.

**Before launch, read Jamendo's API terms.** The API is free for non-commercial use. A service that
earns money may need an agreement with Jamendo; ask them. `docs/operations/music.md` explains how
licences are handled and what a deal with a commercial catalogue involves.

## 4. Lawyer review

The legal pages describe what the product actually does, with placeholders for the company's
details. Give your lawyer `docs/legal/review-pack.md`: it lists every kind of data kept, the
outside services data goes to, the rules for under-18s, and the specific questions to answer per
country. Fill in the placeholders listed in `docs/legal/placeholders.md`; most are settings, not
code changes.

## 5. Apple and Google developer accounts

Follow `docs/operations/app-store.md`, which covers the whole process: accounts, the build service,
the store forms, the privacy answers and the review notes. The account steps need your identity
documents and a payment, so only you can do them:

- **Apple Developer Program**: enrol as an organisation if you have a company (this needs a
  D-U-N-S number, which is free but can take days), or as an individual.
- **Google Play Console**: create a developer account. New personal accounts must run a closed
  test with testers for a period before they can publish; an organisation account avoids that.

Store listing text in several languages is ready in `docs/operations/store-listing.md`.

Before submitting, put the app on your own iPhone and Android phone and go through
`docs/operations/real-device-testing.md`: how to install a preview build that talks to the Render
servers, the two settings that make the site's links open the app, and a checklist of what a
simulator can't prove (push notifications, calls on mobile data, the microphone and cameras,
location, links, large text and screen readers).

## 6. How iPhone purchases work

This decides whether buying Plus and tipping happen inside the iPhone app. Selling physical goods,
drops and bookings through the app's own checkout is allowed either way.
`docs/operations/in-app-purchases.md` explains the options, fees and risks, and the one setting to
change for each choice. Until you choose, the iPhone app follows the safest option, which passes
review.

## 7. Speech-to-text (automatic captions and voice message transcripts)

Without a provider, the video editor says automatic captions aren't set up, and people can still
write captions or upload a .vtt file; voice messages in chats have no "Show text". With one, "Make
captions automatically" works on videos, and voice notes and Yaps in chats are transcribed (and
translated for people who don't understand them; `docs/product/speech-engine.md`).

1. **Recommended: Groq** (fast and cheap for short voice notes). Create an API key at
   https://console.groq.com (**API Keys**) and set a spending limit. OpenAI
   (https://platform.openai.com, **API keys**) works the same way, and so does any other service with
   the same `POST /audio/transcriptions` request that returns WebVTT, including a Whisper server you
   run yourself.
2. Set (Groq):

   ```
   TRANSCRIBE_PROVIDER=openai-compatible
   TRANSCRIBE_API_URL=https://api.groq.com/openai/v1
   TRANSCRIBE_API_KEY=<the key>
   TRANSCRIBE_MODEL=whisper-large-v3-turbo
   ```

   With OpenAI instead: `TRANSCRIBE_API_URL=https://api.openai.com/v1` and `TRANSCRIBE_MODEL=whisper-1`.

3. Check it: the launch check asks the service for its model list (nothing is transcribed or paid
   for), then open a short video in the video editor and choose **Make captions automatically**, and
   send a voice note in a chat: "Show text" appears under it a moment later.

The audio of the video being captioned, and of voice messages (unless the sender turned off
"Transcribe my voice messages"; never view-once or disappearing ones), is sent to the provider; this
belongs in the privacy policy next to the AI helpers. `VOICE_TRANSCRIPTS` (Admin > Feature flags)
turns voice message transcripts off for everyone without touching captions.

## 8. Text-to-speech ("Listen in French")

Without a provider, translated voice messages show their translated text only. With one, a
"Listen in {language}" button reads the translation out in a plain synthetic voice (never the
sender's). Each clip is made the first time someone taps it and shared by everyone after.

1. Create an API key with OpenAI (https://platform.openai.com, **API keys**) and set a monthly limit.
   Any service with the OpenAI-compatible `POST /audio/speech` request works.
2. Set:

   ```
   TTS_PROVIDER=openai-compatible
   TTS_API_URL=https://api.openai.com/v1
   TTS_API_KEY=<the key>
   TTS_MODEL=gpt-4o-mini-tts        # or tts-1
   TTS_VOICE=alloy
   TTS_DAILY_CHAR_LIMIT=200000      # characters a day for everyone; then "not available right now"
   TTS_PER_HOUR=30                  # new clips per person per hour
   ```

   `TTS_VOICES=fr=nova,ar=onyx` picks a voice per language (optional).
3. Check it: the launch check asks the service for its model list; then, as someone whose app
   language differs from a voice note's, open "Show text" and tap **Listen in …**.

The translated text (never the audio or the sender's name) is sent to the provider.
`VOICE_TRANSLATION` (Admin > Feature flags) turns translated transcripts and listening off for
everyone.
