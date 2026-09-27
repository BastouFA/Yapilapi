import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLanguage, needsTranslation } from '@yapilapi/shared';
import { AiGateway } from '../src/lib/ai/gateway.ts';
import type { AiProvider } from '../src/lib/ai/providers.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * "See translation": language detection on write, who may translate what, the
 * cache (and how edits invalidate it), the feature flag, the per-person limit,
 * and #tags, @names and links coming through unchanged.
 */
describe('translation', () => {
  let t: BuiltApp;
  let ada: TestUser; // writes in French
  let bola: TestUser; // reads in English
  let eve: TestUser; // an outsider

  beforeAll(async () => {
    t = await testApp();
    ada = await signUp(t.app);
    bola = await signUp(t.app);
    eve = await signUp(t.app);
    await as(t.app, bola).post(`/v1/users/${ada.id}/follow`);
    await as(t.app, ada).post(`/v1/users/${bola.id}/follow`);
  });
  afterAll(() => t.close());

  const translate = (u: TestUser, kind: string, id: string, target = 'en') => as(t.app, u).post('/v1/translate', { kind, id, target });
  const newPost = async (body: string, extra: Record<string, unknown> = {}) => {
    const r = await as(t.app, ada).post('/v1/posts', { body, visibility: 'public', ...extra });
    expect(r.status).toBe(201);
    return r.body.post as { id: string; lang?: string | null };
  };

  it('detects the language of text in the app’s languages, and says nothing when it can’t tell', () => {
    expect(detectLanguage('Bonjour à tous, quelle belle journée avec mes amis')).toBe('fr');
    expect(detectLanguage('Hola a todos, qué día tan bonito con mis amigos')).toBe('es');
    expect(detectLanguage('Olá pessoal, que dia lindo com meus amigos')).toBe('pt');
    expect(detectLanguage('Habari za leo marafiki, siku nzuri sana')).toBe('sw');
    expect(detectLanguage('Ẹ káàárọ̀ o, ṣé dáadáa ni gbogbo yín wà?')).toBe('yo');
    expect(detectLanguage('Sannu da zuwa, yaya aiki? Muna gode wa Allah')).toBe('ha');
    expect(detectLanguage('مرحبا بالجميع، يوم جميل على الشاطئ')).toBe('ar');
    expect(detectLanguage('Just landed in Lagos, so happy to be home')).toBe('en');
    expect(detectLanguage('😀🎉 https://example.com #tbt @ada')).toBeNull();
    expect(detectLanguage('ok')).toBeNull();
    // The app's language always counts as understood; others only when listed.
    expect(needsTranslation('fr', 'en')).toBe(true);
    expect(needsTranslation('fr', 'en', ['fr'])).toBe(false);
    expect(needsTranslation('en', 'en-GB')).toBe(false);
    expect(needsTranslation(null, 'en')).toBe(false);
  });

  it('stores the detected language of posts, comments, stories and messages when they are written', async () => {
    const post = await newPost('Bonjour à tous, quelle belle journée à la plage avec mes amis');
    expect(post.lang).toBe('fr');
    expect((await t.ctx.db.query(`SELECT lang FROM posts WHERE id = $1`, [post.id])).rows[0].lang).toBe('fr');

    const comment = (await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { body: 'Habari za leo, siku nzuri sana hapa' })).body.comment;
    expect(comment.lang).toBe('sw');
    expect((await t.ctx.db.query(`SELECT lang FROM comments WHERE id = $1`, [comment.id])).rows[0].lang).toBe('sw');
    const listed = (await as(t.app, ada).get(`/v1/posts/${post.id}/comments`)).body.items;
    expect(listed.find((c: { id: string }) => c.id === comment.id).lang).toBe('sw');

    const story = (await as(t.app, ada).post('/v1/moments', { body: 'Hola a todos, qué día tan bonito en la playa', visibility: 'followers' })).body.moment;
    expect((await t.ctx.db.query(`SELECT lang FROM moments WHERE id = $1`, [story.id])).rows[0].lang).toBe('es');

    const conv = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation;
    const msg = (await as(t.app, ada).post(`/v1/conversations/${conv.id}/messages`, { body: 'Sannu da zuwa, yaya aiki? Muna gode wa Allah' })).body.message;
    expect(msg.lang).toBe('ha');
    const read = (await as(t.app, bola).get(`/v1/conversations/${conv.id}/messages`)).body.items;
    expect(read.find((m: { id: string }) => m.id === msg.id).lang).toBe('ha');

    // An edit detects the language again.
    await as(t.app, ada).patch(`/v1/messages/${msg.id}`, { body: 'Olá pessoal, que dia lindo com meus amigos' });
    expect((await t.ctx.db.query(`SELECT lang FROM messages WHERE id = $1`, [msg.id])).rows[0].lang).toBe('pt');
  });

  it('translates a post, marks it as machine translation, caches it and logs every request', async () => {
    const post = await newPost('Merci à tous pour cette belle soirée, à bientôt');
    const first = await translate(bola, 'post', post.id);
    expect(first.status).toBe(200);
    expect(first.body.translation).toMatchObject({ kind: 'post', id: post.id, sourceLanguage: 'fr', targetLanguage: 'en', machine: true, cached: false, provider: 'dev' });
    // The offline provider's pseudo-translation is marked as such.
    expect(first.body.translation.text).toMatch(/^\[fr→en\] Merci à tous/);

    const again = await translate(bola, 'post', post.id);
    expect(again.body.translation).toMatchObject({ cached: true, text: first.body.translation.text });

    const log = await t.ctx.db.query(
      `SELECT status, context_scopes FROM ai_tool_calls WHERE user_id = $1 AND task = 'translate' AND $2 = ANY(context_scopes) ORDER BY id`,
      [bola.id, `post:${post.id}`],
    );
    expect(log.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(log.rows[1].context_scopes).toContain('cache');
  });

  it('refuses a translation into the language the text is already in, or of text-less items', async () => {
    const post = await newPost('Merci à tous pour cette belle soirée, à bientôt');
    expect((await translate(bola, 'post', post.id, 'fr')).body.error.code).toBe('same_language');
    expect((await translate(bola, 'post', post.id, 'xx')).status).toBe(400);
  });

  it('never alters #tags, @names or links, even when the model mangles or drops them', async () => {
    const post = await newPost(`Bonjour @${bola.username} regarde #FêteDeLaMusique et https://example.com/fete?jour=21. Écris à ada@example.org`);
    const r = await translate(bola, 'post', post.id);
    const text: string = r.body.translation.text;
    for (const token of [`@${bola.username}`, '#FêteDeLaMusique', 'https://example.com/fete?jour=21', 'ada@example.org']) expect(text).toContain(token);

    // A model that respells one marker's surroundings and drops another: nothing is lost or changed.
    const seen: string[] = [];
    const provider: AiProvider = {
      name: 'spy',
      model: 'spy-1',
      complete: async ({ prompt }) => {
        seen.push(prompt);
        return { text: prompt.replace('Bonjour', 'Hello').replace('regarde', 'look at').replace('⟦1⟧', 'the music party'), provider: 'spy', model: 'spy-1' };
      },
    };
    const gw = new AiGateway(t.ctx.db, provider);
    const out = await gw.run({ userId: bola.id, task: 'translate', input: '', item: { kind: 'post', id: post.id }, targetLanguage: 'en' });
    // The model never saw the tags, names or links themselves.
    expect(seen[0]).not.toMatch(/@|#|https?:/);
    const translated = (out.output as { translated: string }).translated;
    expect(translated).toContain(`Hello @${bola.username} look at`);
    expect(translated).toContain('#FêteDeLaMusique');
    expect(translated).toContain('https://example.com/fete?jour=21.');
    expect(translated).toContain('ada@example.org');
  });

  describe('authorization: only what the person can see right now', () => {
    it('private posts', async () => {
      const post = await newPost('Seulement pour mes abonnés, merci de ne pas partager', { visibility: 'followers' });
      expect((await translate(bola, 'post', post.id)).status).toBe(200);
      const denied = await translate(eve, 'post', post.id);
      expect(denied.status).toBe(404);
      // The refusal is audited too, and nothing was read from the cache or the model for it.
      const log = await t.ctx.db.query(`SELECT status FROM ai_tool_calls WHERE user_id = $1 AND $2 = ANY(context_scopes)`, [eve.id, `post:${post.id}`]);
      expect(log.rows.map((r) => r.status)).toEqual(['denied']);
    });

    it('posts and comments by someone the reader blocked (or who blocked them)', async () => {
      const carl = await signUp(t.app);
      const post = await newPost('Bonjour tout le monde, quelle belle journée aujourd’hui');
      const comment = (await as(t.app, carl).post(`/v1/posts/${post.id}/comments`, { body: 'Merci beaucoup, c’est vraiment très beau' })).body.comment;
      expect((await translate(eve, 'comment', comment.id)).status).toBe(200);
      await as(t.app, eve).post(`/v1/users/${carl.id}/block`);
      expect((await translate(eve, 'comment', comment.id)).status).toBe(404);
      await as(t.app, ada).post(`/v1/users/${eve.id}/block`);
      expect((await translate(eve, 'post', post.id)).status).toBe(404);
    });

    it('stories only for people who can open them', async () => {
      const story = (await as(t.app, ada).post('/v1/moments', { body: 'Bonne nuit à tous, à demain mes amis', visibility: 'followers' })).body.moment;
      expect((await translate(bola, 'story', story.id)).status).toBe(200);
      const dan = await signUp(t.app);
      expect((await translate(dan, 'story', story.id)).status).toBe(404);
    });

    it('messages only for members of the chat', async () => {
      const conv = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation;
      const msg = (await as(t.app, ada).post(`/v1/conversations/${conv.id}/messages`, { body: 'On se retrouve ce soir chez moi pour le dîner' })).body.message;
      expect((await translate(bola, 'message', msg.id)).status).toBe(200);
      const outsider = await signUp(t.app);
      expect((await translate(outsider, 'message', msg.id)).status).toBe(404);
      // Unsent: gone for everyone, cached translation included.
      await as(t.app, ada).post(`/v1/messages/${msg.id}/unsend`);
      expect((await translate(bola, 'message', msg.id)).status).toBe(404);
      expect((await t.ctx.db.query(`SELECT 1 FROM translations WHERE item_id = $1`, [msg.id])).rowCount).toBe(0);
    });
  });

  it('an edit invalidates the cached translation', async () => {
    const post = await newPost('Bonjour à tous, quelle belle journée à la plage');
    const before = (await translate(bola, 'post', post.id)).body.translation;
    expect(before.text).toContain('plage');
    const edited = await as(t.app, ada).patch(`/v1/posts/${post.id}`, { body: 'Bonsoir à tous, quelle belle soirée à la montagne' });
    expect(edited.status).toBe(200);
    const after = (await translate(bola, 'post', post.id)).body.translation;
    expect(after.cached).toBe(false);
    expect(after.text).toContain('montagne');
    expect(after.text).not.toContain('plage');
    const rows = await t.ctx.db.query(`SELECT body FROM translations WHERE kind = 'post' AND item_id = $1`, [post.id]);
    expect(rows.rows.map((r) => r.body)).toEqual([after.text]);
  });

  it('says plainly when translation is turned off', async () => {
    const post = await newPost('Bonjour à tous, quelle belle journée à la plage');
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('AI_TRANSLATION', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      const r = await translate(bola, 'post', post.id);
      expect(r.status).toBe(503);
      expect(r.body.error).toMatchObject({ code: 'translation_unavailable', message: 'Translation is turned off right now.' });
    } finally {
      await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'AI_TRANSLATION'`);
    }
    expect((await translate(bola, 'post', post.id)).status).toBe(200);
  });

  it('limits how many translations one person asks for in an hour', async () => {
    const limited = await testApp({ TRANSLATE_PER_HOUR: '3' });
    try {
      const writer = await signUp(limited.app);
      const reader = await signUp(limited.app);
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push((await as(limited.app, writer).post('/v1/posts', { body: `Bonjour à tous, quelle belle journée numéro ${i}`, visibility: 'public' })).body.post.id);
      for (const id of ids.slice(0, 3)) expect((await as(limited.app, reader).post('/v1/translate', { kind: 'post', id, target: 'en' })).status).toBe(200);
      const over = await as(limited.app, reader).post('/v1/translate', { kind: 'post', id: ids[3], target: 'en' });
      expect(over.status).toBe(429);
      expect(over.body.error.code).toBe('translation_limit');
      // Someone else still can.
      expect((await as(limited.app, writer).post('/v1/translate', { kind: 'post', id: ids[3], target: 'es' })).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('keeps "Languages I understand" and "Translate automatically" on the account', async () => {
    const me0 = (await as(t.app, eve).get('/v1/auth/me')).body.user;
    expect(me0.translation).toEqual({ languages: [], auto: false });
    const saved = await as(t.app, eve).put('/v1/me/translation', { languages: ['fr', 'yo', 'fr'], auto: true });
    expect(saved.body).toEqual({ languages: ['fr', 'yo'], auto: true });
    expect((await as(t.app, eve).get('/v1/auth/me')).body.user.translation).toEqual({ languages: ['fr', 'yo'], auto: true });
    expect((await as(t.app, eve).put('/v1/me/translation', { languages: ['klingon'], auto: false })).status).toBe(400);
  });
});
