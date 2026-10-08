import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { worthTranslating } from '@yapilapi/shared';
import { AiGateway } from '../src/lib/ai/gateway.ts';
import { devProvider, type AiProvider } from '../src/lib/ai/providers.ts';
import { RANKING, scoreOf, type Features } from '../src/lib/ranking.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * Speak any language, step 1 (docs/product/speak-any-language.md): POST /v1/translations
 * translates what's on a reader's screen automatically. Who may see what, one translation
 * shared by every reader, the reader's languages, the hourly limit and the day's budget, the
 * flag, the offline stand-in, edits, caption tracks and the recommender's language preference.
 * A stand-in model ('stub', not the offline 'dev' one) answers; nothing leaves the machine.
 */

/** A model that counts its calls and answers "EN: <text>", optionally after a pause. */
function stubModel(delayMs = 0) {
  const calls: string[] = [];
  const provider: AiProvider = {
    name: 'stub',
    model: 'stub-1',
    async complete({ prompt }) {
      calls.push(prompt);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      // Caption lines come numbered ("1\ttext"): keep the numbers.
      const text = /^\d+\t/.test(prompt)
        ? prompt
            .split('\n')
            .map((l) => l.replace(/^(\d+)\t/, '$1\tEN: '))
            .join('\n')
        : `EN: ${prompt}`;
      return { text, provider: 'stub', model: 'stub-1' };
    },
  };
  return { provider, calls };
}

describe('automatic translation', () => {
  let t: BuiltApp;
  const model = stubModel();
  let ada: TestUser; // writes in French
  let bola: TestUser; // reads in English
  let carl: TestUser; // reads in English too
  let eve: TestUser; // an outsider

  const FR = ['Bonjour à tous, quelle belle journée à la plage avec mes amis', 'Merci beaucoup pour cette belle soirée, à bientôt mes amis'];
  let n = 0;
  const french = () => `${FR[n % 2]} numéro ${++n}`;
  const batch = (u: TestUser, items: { kind: string; id: string }[], target = 'en', app = t) => as(app.app, u).post('/v1/translations', { target, items });
  const newPost = async (body: string, extra: Record<string, unknown> = {}, author = ada, app = t) => {
    const r = await as(app.app, author).post('/v1/posts', { body, visibility: 'public', ...extra });
    expect(r.status).toBe(201);
    return r.body.post as { id: string; lang: string | null };
  };
  const setFlag = (key: string, enabled: boolean | null) =>
    enabled === null
      ? t.ctx.db.query(`DELETE FROM feature_flags WHERE key = $1`, [key])
      : t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`, [key, enabled]);

  beforeAll(async () => {
    t = await testApp({}, { translator: model.provider });
    ada = await signUp(t.app);
    bola = await signUp(t.app);
    carl = await signUp(t.app);
    eve = await signUp(t.app);
    await as(t.app, bola).post(`/v1/users/${ada.id}/follow`);
    await as(t.app, carl).post(`/v1/users/${ada.id}/follow`);
  });
  afterAll(() => t.close());

  it('is on by default, and says so in /v1/flags only when a real model translates', async () => {
    expect((await as(t.app, eve).get('/v1/auth/me')).body.user.translation).toEqual({ languages: [], auto: true });
    expect((await as(t.app, eve).get('/v1/me/translation')).body).toEqual({ languages: [], auto: true });
    expect((await as(t.app, null).get('/v1/flags')).body).toMatchObject({ autoTranslation: true, flags: { AUTO_TRANSLATE: true } });
    const standIn = await testApp();
    try {
      expect((await as(standIn.app, null).get('/v1/flags')).body.autoTranslation).toBe(false);
    } finally {
      await standIn.close();
    }
  });

  it('translates once, and every reader after that gets the same translation from the cache', async () => {
    const post = await newPost(french());
    expect(post.lang).toBe('fr');
    const before = model.calls.length;
    const first = await batch(bola, [{ kind: 'post', id: post.id }]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ auto: true, pending: [] });
    expect(first.body.items).toEqual([
      expect.objectContaining({ kind: 'post', id: post.id, sourceLanguage: 'fr', targetLanguage: 'en', machine: true, cached: false, provider: 'stub' }),
    ]);
    expect(first.body.items[0].text).toMatch(/^EN: Bonjour à tous|^EN: Merci beaucoup/);
    const second = await batch(carl, [{ kind: 'post', id: post.id }]);
    expect(second.body.items).toEqual([expect.objectContaining({ id: post.id, cached: true, text: first.body.items[0].text })]);
    expect(model.calls.length).toBe(before + 1);
    // Logged: the new translation for Bola (scope "auto"), one entry for Carl's whole batch from the cache.
    const log = async (u: TestUser) =>
      (await t.ctx.db.query(`SELECT context_scopes FROM ai_tool_calls WHERE user_id = $1 AND task = 'translate' ORDER BY id`, [u.id])).rows.map(
        (r) => r.context_scopes,
      );
    expect(await log(bola)).toContainEqual([`post:${post.id}`, 'auto']);
    expect(await log(carl)).toContainEqual(['auto', 'cache', `post:${post.id}`]);
  });

  it('never returns what the reader can’t see: audiences, blocks, stories and chats they’re not in', async () => {
    const open = await newPost(french());
    const followers = await newPost(french(), { visibility: 'followers' });
    // Bola's screen makes the followers-only translation first: it's cached, and still never reaches Eve.
    expect((await batch(bola, [{ kind: 'post', id: followers.id }])).body.items).toHaveLength(1);
    const story = (await as(t.app, ada).post('/v1/moments', { body: french(), visibility: 'followers' })).body.moment;
    const conv = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation;
    const msg = (await as(t.app, ada).post(`/v1/conversations/${conv.id}/messages`, { body: french() })).body.message;
    const all = [
      { kind: 'post', id: open.id },
      { kind: 'post', id: followers.id },
      { kind: 'story', id: story.id },
      { kind: 'message', id: msg.id },
    ];

    const forEve = await batch(eve, all);
    expect(forEve.status).toBe(200);
    expect(forEve.body.items.map((i: { id: string }) => i.id)).toEqual([open.id]);
    expect(forEve.body.pending).toEqual([]);
    expect(JSON.stringify(forEve.body)).not.toContain(followers.id);

    const forBola = await batch(bola, all);
    expect(forBola.body.items.map((i: { id: string }) => i.id).sort()).toEqual([open.id, followers.id, story.id, msg.id].sort());

    // Blocking either way hides everything at once, cached translations included.
    await as(t.app, carl).post(`/v1/users/${ada.id}/block`);
    expect((await batch(carl, all)).body.items).toEqual([]);
    await as(t.app, ada).post(`/v1/users/${eve.id}/block`);
    expect((await batch(eve, all)).body.items).toEqual([]);
    await as(t.app, carl).del(`/v1/users/${ada.id}/block`);

    // Ids that don't exist are left out too, and a bad request is refused.
    expect((await batch(bola, [{ kind: 'comment', id: '00000000-0000-4000-8000-000000000000' }])).body.items).toEqual([]);
    expect((await batch(bola, [{ kind: 'nope', id: open.id }])).status).toBe(400);
    expect(
      (
        await batch(
          bola,
          Array.from({ length: 51 }, () => ({ kind: 'post', id: open.id })),
        )
      ).status,
    ).toBe(400);
  });

  it('leaves alone text in a language the reader understands, view-once messages, and text with too few words', async () => {
    const post = await newPost(french());
    const dan = await signUp(t.app);
    await as(t.app, dan).put('/v1/me/translation', { languages: ['fr'], auto: true });
    const before = model.calls.length;
    expect((await batch(dan, [{ kind: 'post', id: post.id }])).body).toEqual({ items: [], pending: [], auto: true });
    // The app's language always counts: a French reader gets nothing for French text.
    expect((await batch(bola, [{ kind: 'post', id: post.id }], 'fr')).body.items).toEqual([]);
    const english = await newPost('Just landed in Lagos, so happy to be home with everyone');
    expect((await batch(bola, [{ kind: 'post', id: english.id }])).body.items).toEqual([]);
    const tags = await newPost(`#FêteDeLaMusique @${bola.username} https://example.com 🎉`);
    expect((await batch(bola, [{ kind: 'post', id: tags.id }])).body.items).toEqual([]);
    const conv = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation;
    const once = await as(t.app, ada).post(`/v1/conversations/${conv.id}/messages`, { body: french(), viewOnce: true });
    if (once.status === 201) expect((await batch(bola, [{ kind: 'message', id: once.body.message.id }])).body.items).toEqual([]);
    expect(model.calls.length).toBe(before);

    expect(worthTranslating('Bonjour à tous')).toBe(true);
    expect(worthTranslating('Lagos')).toBe(false);
    expect(worthTranslating('😀🎉 #tbt @ada https://example.com')).toBe(false);
    expect(worthTranslating('谢谢大家')).toBe(true);
  });

  it('an edit makes a new translation, and the old one is gone', async () => {
    const post = await newPost('Bonjour à tous, quelle belle journée à la plage avec mes amis');
    const before = (await batch(bola, [{ kind: 'post', id: post.id }])).body.items[0];
    expect(before.text).toContain('plage');
    expect((await as(t.app, ada).patch(`/v1/posts/${post.id}`, { body: 'Bonsoir à tous, quelle belle soirée à la montagne avec mes amis' })).status).toBe(200);
    const after = (await batch(carl, [{ kind: 'post', id: post.id }])).body.items[0];
    expect(after).toMatchObject({ cached: false });
    expect(after.text).toContain('montagne');
    const rows = await t.ctx.db.query(`SELECT body FROM translations WHERE kind = 'post' AND item_id = $1`, [post.id]);
    expect(rows.rows.map((r) => r.body)).toEqual([after.text]);
  });

  it('stops for the reader whose switch is off, and for everyone when AUTO_TRANSLATE is off', async () => {
    const post = await newPost(french());
    const fay = await signUp(t.app);
    await as(t.app, fay).put('/v1/me/translation', { languages: [], auto: false });
    expect((await batch(fay, [{ kind: 'post', id: post.id }])).body).toEqual({ items: [], pending: [], auto: false });
    await setFlag('AUTO_TRANSLATE', false);
    try {
      expect((await batch(bola, [{ kind: 'post', id: post.id }])).body).toEqual({ items: [], pending: [], auto: false });
      expect((await as(t.app, null).get('/v1/flags')).body.autoTranslation).toBe(false);
      // "See translation" still works.
      expect((await as(t.app, bola).post('/v1/translate', { kind: 'post', id: post.id, target: 'en' })).status).toBe(200);
    } finally {
      await setFlag('AUTO_TRANSLATE', null);
    }
    expect((await batch(bola, [{ kind: 'post', id: post.id }])).body.items).toHaveLength(1);
  });

  it('keeps to the hourly limit per reader: past it, cached translations still come and new ones wait', async () => {
    const limited = await testApp({ AUTO_TRANSLATE_PER_HOUR: '2' }, { translator: stubModel().provider });
    try {
      const writer = await signUp(limited.app);
      const reader = await signUp(limited.app);
      const other = await signUp(limited.app);
      const posts = [];
      for (let i = 0; i < 3; i++) posts.push(await newPost(french(), {}, writer, limited));
      const items = posts.map((p) => ({ kind: 'post', id: p.id }));
      const r = await batch(reader, items, 'en', limited);
      expect(r.body.auto).toBe(false);
      expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([posts[0]!.id, posts[1]!.id]);
      // Someone else makes the third one; the limited reader then gets all three from the cache.
      const o = await batch(other, [items[2]!], 'en', limited);
      expect(o.body.items).toHaveLength(1);
      const again = await batch(reader, items, 'en', limited);
      expect(again.body.items).toHaveLength(3);
      expect(again.body.auto).toBe(true);
      // Their "See translation" has its own limit.
      expect((await as(limited.app, reader).post('/v1/translate', { kind: 'post', id: posts[0]!.id, target: 'es' })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('keeps to the day’s budget for everyone, then falls back to "See translation"', async () => {
    const used = (await t.ctx.db.query(`SELECT coalesce((SELECT used FROM translation_budget WHERE day = (now() AT TIME ZONE 'utc')::date), 0) AS n`)).rows[0]
      .n as number;
    const tight = await testApp({ AUTO_TRANSLATE_DAILY_LIMIT: String(used + 1) }, { translator: stubModel().provider });
    try {
      const writer = await signUp(tight.app);
      const reader = await signUp(tight.app);
      const a = await newPost(french(), {}, writer, tight);
      const b = await newPost(french(), {}, writer, tight);
      const r = await batch(
        reader,
        [
          { kind: 'post', id: a.id },
          { kind: 'post', id: b.id },
        ],
        'en',
        tight,
      );
      expect(r.body.items).toHaveLength(1);
      expect(r.body.auto).toBe(false);
      // "See translation" isn't part of the budget.
      expect((await as(tight.app, reader).post('/v1/translate', { kind: 'post', id: b.id, target: 'en' })).status).toBe(200);
    } finally {
      await tight.close();
    }
  });

  it('with the offline stand-in: never automatic, and in production not even "See translation"', async () => {
    const standIn = await testApp();
    try {
      const writer = await signUp(standIn.app);
      const reader = await signUp(standIn.app);
      const post = await newPost(french(), {}, writer, standIn);
      expect((await batch(reader, [{ kind: 'post', id: post.id }], 'en', standIn)).body).toEqual({ items: [], pending: [], auto: false });
      // Development: the manual, marked pseudo-translation still works, and is cached...
      const manual = await as(standIn.app, reader).post('/v1/translate', { kind: 'post', id: post.id, target: 'en' });
      expect(manual.body.translation.text).toMatch(/^\[fr→en\]/);
      // ...but never served as an automatic one.
      expect((await batch(reader, [{ kind: 'post', id: post.id }], 'en', standIn)).body.items).toEqual([]);
      // Nor to a real model's readers.
      expect((await batch(reader, [{ kind: 'post', id: post.id }])).body.items[0].text).toMatch(/^EN: /);

      const production = new AiGateway(standIn.ctx.db, devProvider(), null, { realTranslationsOnly: true });
      await expect(production.translateItem({ userId: reader.id, kind: 'post', id: post.id, target: 'en' })).rejects.toMatchObject({
        status: 503,
        code: 'translation_unavailable',
      });
    } finally {
      await standIn.close();
    }
  });

  it('answers with what is ready, the rest as pending, and readers asking at once share one translation', async () => {
    const slow = stubModel(300);
    const gw = new AiGateway(t.ctx.db, devProvider(), null, { translator: slow.provider });
    const post = await newPost(french());
    const ask = (userId: string, waitMs: number) =>
      gw.translateMany({ userId, target: 'en', items: [{ kind: 'post', id: post.id }], understood: ['en'], perHour: 100, dailyLimit: 1_000_000, waitMs });
    const [first, second] = await Promise.all([ask(bola.id, 20), ask(carl.id, 20)]);
    expect(first).toEqual({ items: [], pending: [{ kind: 'post', id: post.id }], auto: true });
    expect(second.pending).toEqual([{ kind: 'post', id: post.id }]);
    await new Promise((r) => setTimeout(r, 450));
    const later = await ask(bola.id, 20);
    expect(later.items).toEqual([expect.objectContaining({ id: post.id, cached: true })]);
    expect(slow.calls).toHaveLength(1);
  });

  it('translates caption tracks for people who can see the video, once for everyone', async () => {
    const stored = await t.ctx.storage.put(Buffer.from('not really a video'), 'mp4', 'video/mp4');
    const media = (
      await t.ctx.db.query(`INSERT INTO media (owner_id, kind, url, mime, storage_key) VALUES ($1,'video',$2,'video/mp4',$3) RETURNING id`, [
        ada.id,
        stored.url,
        stored.key,
      ])
    ).rows[0].id as string;
    const cues = [
      { start: 0, end: 2, text: 'Bonjour à tous' },
      { start: 2, end: 4, text: 'Regardez #plage et @ada' },
    ];
    expect((await as(t.app, ada).put(`/v1/media/${media}/captions/fr`, { label: 'Français', cues })).status).toBe(200);
    expect(
      (await as(t.app, ada).post('/v1/posts', { body: 'Vidéo', visibility: 'followers', media: [{ id: media, url: stored.url, kind: 'video' }] })).status,
    ).toBe(201);
    const url = (target: string, format = 'json') => `/v1/media/${media}/captions/fr/translation?target=${target}&format=${format}`;

    const before = model.calls.length;
    const json = await as(t.app, bola).get(url('en'));
    expect(json.status).toBe(200);
    expect(json.body).toMatchObject({ sourceLanguage: 'fr', targetLanguage: 'en', machine: true });
    expect(json.body.cues).toEqual([
      { start: 0, end: 2, text: 'EN: Bonjour à tous' },
      { start: 2, end: 4, text: 'EN: Regardez #plage et @ada' },
    ]);
    // The model saw markers, never the tag or the name.
    expect(model.calls.at(-1)).not.toMatch(/#plage|@ada/);
    const vtt = await t.app.inject({ method: 'GET', url: url('en', 'vtt'), headers: { authorization: `Bearer ${bola.token}` } });
    expect(vtt.statusCode).toBe(200);
    expect(vtt.headers['content-type']).toMatch(/^text\/vtt/);
    expect(vtt.body).toMatch(/^WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nEN: Bonjour à tous/);
    expect(model.calls.length).toBe(before + 1);

    expect((await as(t.app, eve).get(url('en'))).status).toBe(404);
    expect((await as(t.app, null).get(url('en'))).status).toBe(401);
    expect((await as(t.app, bola).get(url('fr'))).body.error.code).toBe('same_language');

    // A new file for the track: the old translation goes.
    await as(t.app, ada).put(`/v1/media/${media}/captions/fr`, { label: 'Français', cues: [{ start: 0, end: 2, text: 'Bonsoir' }] });
    expect((await t.ctx.db.query(`SELECT 1 FROM translations WHERE kind = 'caption'`)).rows.length).toBe(0);
    expect((await as(t.app, bola).get(url('en'))).body.cues).toEqual([{ start: 0, end: 2, text: 'EN: Bonsoir' }]);
  });

  it('the recommender keeps a mild preference for languages the reader understands', () => {
    const base: Features = {
      id: 'p',
      authorId: 'a',
      createdAt: new Date(),
      topics: [],
      kind: 'text',
      format: 'post',
      own: false,
      friend: false,
      followed: false,
      member: false,
      collabFriend: false,
      collabFollowed: false,
      interestN: 0,
      moreN: 0,
      lessN: 0,
      topicAff: 0,
      creatorAff: 0,
      similarPeople: 0,
      likes: 10,
      comments: 2,
      impressions: 50,
      completes: 0,
      skips: 0,
      shares: 0,
      saves: 0,
      trend: 0,
      ageHours: 3,
      newCreator: false,
    };
    const read = scoreOf(base, true);
    const translated = scoreOf({ ...base, unreadLanguage: 'translated' }, true);
    const unread = scoreOf({ ...base, unreadLanguage: 'unread' }, true);
    expect(translated).toBeCloseTo(read + RANKING.weights.unreadLanguageTranslated);
    expect(unread).toBeLessThan(translated);
    // A good post in another language can still beat a weaker one in yours.
    expect(scoreOf({ ...base, unreadLanguage: 'translated', likes: 60, comments: 15 }, true)).toBeGreaterThan(read);
    // Your connections' posts are never held back for their language.
    expect(scoreOf({ ...base, followed: true, unreadLanguage: 'unread' }, true)).toBe(scoreOf({ ...base, followed: true }, true));
    // Without personalization, nothing changes.
    expect(scoreOf({ ...base, unreadLanguage: 'unread' }, false)).toBe(scoreOf(base, false));
  });
});
