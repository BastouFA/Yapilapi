import { DEV_PHRASEBOOK } from '@yapilapi/ai';
import { check, checkEq, type EvalCase } from '../harness.js';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NEEDS_TRANSLATION = 'translation is unavailable';

export const cases: EvalCase[] = [
  {
    id: 'tr.phrasebook_accuracy',
    category: 'translation',
    kind: 'dev',
    title:
      'The dev provider translates every phrasebook entry into every listed language correctly, and always returns the original',
    async run(h) {
      const u = await h.user();
      let n = 0;
      for (const [en, langs] of Object.entries(DEV_PHRASEBOOK))
        for (const [lang, expected] of Object.entries(langs)) {
          const r = await u.client.post('/v1/ai/translate', {
            targetType: 'caption',
            text: en,
            targetLanguage: lang,
            sourceLanguage: 'en',
          });
          checkEq(r.status, 200, `status for ${en} -> ${lang}`);
          checkEq(r.body.translation.text, cap(expected), `${en} -> ${lang}`);
          checkEq(r.body.original.text, en, 'original returned');
          n++;
        }
      check(n >= 30, `phrasebook too small (${n})`);
    },
  },
  {
    id: 'tr.reverse_and_pivot',
    category: 'translation',
    kind: 'dev',
    title: 'Foreign phrases translate back to English and across languages via English',
    async run(h) {
      const u = await h.user();
      const back = await u.client.post('/v1/ai/translate', {
        targetType: 'caption',
        text: 'Muchas gracias',
        targetLanguage: 'en',
      });
      checkEq(back.body.translation.text, 'Thank you very much', 'es -> en');
      const pivot = await u.client.post('/v1/ai/translate', {
        targetType: 'caption',
        text: 'Bonjour',
        targetLanguage: 'de',
        sourceLanguage: 'fr',
      });
      check(
        pivot.status === 200 && /hallo|guten/i.test(pivot.body.translation.text),
        `fr -> de: ${JSON.stringify(pivot.body)}`,
      );
    },
  },
  {
    id: 'tr.honest_unsupported',
    category: 'translation',
    kind: 'dev',
    title:
      'Text the dev provider cannot translate is refused honestly (422), never faked, and does not use quota',
    async run(h) {
      const u = await h.user();
      const before = (await u.client.get('/v1/ai/usage')).body.translations.used;
      const r = await u.client.post('/v1/ai/translate', {
        targetType: 'caption',
        text: 'The mitochondria is the powerhouse of the cell',
        targetLanguage: 'de',
      });
      checkEq(r.status, 422, 'status');
      check(
        !/mitochondrien|kraftwerk/i.test(JSON.stringify(r.body)),
        'a translation was fabricated',
      );
      checkEq(
        (await u.client.get('/v1/ai/usage')).body.translations.used,
        before,
        'quota used by a failed translation',
      );
      void NEEDS_TRANSLATION;
    },
  },
  {
    id: 'tr.original_preserved_and_cached',
    category: 'translation',
    kind: 'dev',
    title:
      'Translating a post never changes it, is cached, and the cache is re-checked against visibility',
    async run(h) {
      const author = await h.user();
      const reader = await h.user();
      const stranger = await h.user();
      const pub = await h.post(author, 'Thank you very much');
      const first = await reader.client.post('/v1/ai/translate', {
        targetType: 'post',
        targetId: pub,
        targetLanguage: 'es',
      });
      checkEq(first.body.translation.cached, false, 'first call cached');
      checkEq(
        (
          await reader.client.post('/v1/ai/translate', {
            targetType: 'post',
            targetId: pub,
            targetLanguage: 'es',
          })
        ).body.translation.cached,
        true,
        'second call',
      );
      checkEq(
        (await h.sql('SELECT body FROM posts WHERE id = $1', [pub])).rows[0].body,
        'Thank you very much',
        'post body',
      );
      check(first.body.original.text === 'Thank you very much', 'original missing');
      const priv = await h.post(author, 'Good morning', 'private');
      await author.client.post('/v1/ai/translate', {
        targetType: 'post',
        targetId: priv,
        targetLanguage: 'fr',
      });
      checkEq(
        (
          await stranger.client.post('/v1/ai/translate', {
            targetType: 'post',
            targetId: priv,
            targetLanguage: 'fr',
          })
        ).status,
        404,
        'cached translation of a private post served to a stranger',
      );
    },
  },
  {
    id: 'tr.messages_gated',
    category: 'translation',
    kind: 'invariant',
    title: 'A message is translated only for a consenting member, and only that message is read',
    async run(h) {
      const [a, b] = await h.friends();
      const outsider = await h.user();
      const conv = await h.dm(a, b);
      const msg = await h.say(b, conv, 'See you soon');
      await h.say(b, conv, `another private line ${h.uniq('other')}`);
      checkEq(
        (
          await a.client.post('/v1/ai/translate', {
            targetType: 'message',
            targetId: msg.id,
            targetLanguage: 'es',
          })
        ).status,
        403,
        'no consent',
      );
      await h.consent(a, 'ai_processing');
      await h.consent(outsider, 'ai_processing');
      const ok = await a.client.post('/v1/ai/translate', {
        targetType: 'message',
        targetId: msg.id,
        targetLanguage: 'es',
      });
      checkEq(ok.status, 200, 'member with consent');
      check(!/another private line/.test(JSON.stringify(ok.body)), 'other messages read');
      checkEq(
        (
          await outsider.client.post('/v1/ai/translate', {
            targetType: 'message',
            targetId: msg.id,
            targetLanguage: 'es',
          })
        ).status,
        404,
        'non-member',
      );
    },
  },
  {
    id: 'tr.quota_and_flag',
    category: 'translation',
    kind: 'invariant',
    title: 'Translation is behind the AI_TRANSLATION flag and a per-user daily quota',
    async run(h) {
      const u = await h.user();
      await h.sql(`UPDATE feature_flags SET enabled = false WHERE key = 'AI_TRANSLATION'`);
      h.t.ctx.flags.invalidate();
      try {
        checkEq(
          (
            await u.client.post('/v1/ai/translate', {
              targetType: 'caption',
              text: 'hello',
              targetLanguage: 'es',
            })
          ).status,
          404,
          'flag off',
        );
      } finally {
        await h.sql(`UPDATE feature_flags SET enabled = true WHERE key = 'AI_TRANSLATION'`);
        h.t.ctx.flags.invalidate();
      }
      const { newHarness } = await import('../harness.js');
      const small = await newHarness({ AI_TRANSLATIONS_PER_DAY: '1' }, h.live);
      try {
        const s = await small.user();
        const t = (text: string) =>
          s.client.post('/v1/ai/translate', {
            targetType: 'caption',
            text,
            targetLanguage: 'es',
            sourceLanguage: 'en',
          });
        checkEq((await t('hello')).status, 200, 'within quota');
        checkEq((await t('thank you')).status, 429, 'over quota');
      } finally {
        await small.t.close();
      }
    },
  },
  {
    id: 'tr.language_detection',
    category: 'translation',
    kind: 'invariant',
    title: 'Language detection identifies common languages and reports "und" for undecidable text',
    async run(h) {
      const u = await h.user();
      const samples: Array<[string, string]> = [
        ['The weather is lovely and we are going to the park today with our friends', 'en'],
        ['El clima es muy agradable y vamos al parque hoy con nuestros amigos', 'es'],
        ["Le temps est magnifique et nous allons au parc aujourd'hui avec nos amis", 'fr'],
        ['Das Wetter ist heute wunderschön und wir gehen mit unseren Freunden in den Park', 'de'],
        ['O tempo está lindo e nós vamos ao parque hoje com os nossos amigos', 'pt'],
      ];
      for (const [text, lang] of samples)
        checkEq(
          (await u.client.post('/v1/ai/language/detect', { text })).body.language,
          lang,
          `detect ${lang}`,
        );
      checkEq(
        (await u.client.post('/v1/ai/language/detect', { text: '12345 !!!' })).body.language,
        'und',
        'undecidable',
      );
    },
  },
  {
    id: 'tr.speech_honest',
    category: 'translation',
    kind: 'invariant',
    title: 'Speech endpoints return 501 without a provider and never fabricate transcripts',
    async run(h) {
      const u = await h.user();
      for (const url of ['/v1/ai/speech/transcribe', '/v1/ai/speech/translate']) {
        const r = await u.client.post(url, { mediaId: crypto.randomUUID(), targetLanguage: 'es' });
        checkEq([r.status, r.body.error.code], [501, 'feature_disabled'], url);
      }
    },
  },
];
