import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { AiGateway } from '../src/lib/ai/gateway.ts';
import { AI_LIMITS, devCaptions, devReplies } from '../src/lib/ai/assists.ts';
import type { AiProvider, CompletionRequest } from '../src/lib/ai/providers.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * AI helpers: Catch me up on Pulse, suggested replies in chats, photo descriptions, and
 * caption and hashtag ideas. What must hold for any model: only what the person can see
 * right now reaches it (and comes back), the feature flags and switches turn things off,
 * per-person limits apply, every call is in the audit log, and the offline dev provider
 * gives marked, deterministic output.
 */
describe('AI helpers', () => {
  let t: BuiltApp;
  let ada: TestUser; // the reader
  let bola: TestUser; // someone Ada follows
  let cleo: TestUser; // Ada's friend
  let dan: TestUser; // followed, then blocks Ada
  let eve: TestUser; // a stranger

  const setFlag = (key: string, on: boolean) =>
    t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled`, [key, on]);
  const calls = async (userId: string, task: string) =>
    (
      await t.ctx.db.query<{ status: string; context_scopes: string[]; provider: string }>(
        `SELECT status, context_scopes, provider FROM ai_tool_calls WHERE user_id = $1 AND task = $2 ORDER BY id`,
        [userId, task],
      )
    ).rows;

  /** A provider that records what it was given and answers with a fixed text. */
  const spy = (reply: string | ((req: CompletionRequest) => string)) => {
    const seen: CompletionRequest[] = [];
    const provider: AiProvider = {
      name: 'spy',
      model: 'spy-1',
      complete: async (req) => {
        seen.push(req);
        return { text: typeof reply === 'string' ? reply : reply(req), provider: 'spy', model: 'spy-1' };
      },
    };
    return { provider, seen, gateway: new AiGateway(t.ctx.db, provider, t.ctx.storage) };
  };

  const post = async (u: TestUser, body: string, extra: Record<string, unknown> = {}) => {
    const r = await as(t.app, u).post('/v1/posts', { body, visibility: 'public', ...extra });
    expect(r.status).toBe(201);
    return r.body.post as { id: string };
  };

  const photo = async (owner: TestUser, kind: 'image' | 'video' = 'image') => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
      .png()
      .toBuffer();
    const stored = await t.ctx.storage.put(png, 'png', 'image/png');
    const { rows } = await t.ctx.db.query<{ id: string }>(
      `INSERT INTO media (owner_id, kind, url, mime, width, height, storage_key, moderation) VALUES ($1,$2,$3,'image/png',64,48,$4,'ok') RETURNING id`,
      [owner.id, kind, stored.url, stored.key],
    );
    return rows[0]!.id;
  };

  beforeAll(async () => {
    t = await testApp();
    ada = await signUp(t.app);
    bola = await signUp(t.app);
    cleo = await signUp(t.app);
    dan = await signUp(t.app);
    eve = await signUp(t.app);
    await as(t.app, ada).post(`/v1/users/${bola.id}/follow`);
    await as(t.app, ada).post(`/v1/users/${dan.id}/follow`);
    const [a, b] = [ada.id, cleo.id].sort();
    await t.ctx.db.query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2)`, [a, b]);
  });
  afterAll(() => t.close());

  describe('Catch me up', () => {
    const visible: Record<string, string> = {};
    const hidden: Record<string, string> = {};

    it('offers nothing on a first visit, then after 12 hours away offers a catch-up of posts Ada can see', async () => {
      expect((await as(t.app, ada).post('/v1/pulse/visit')).body).toEqual({ offer: false });

      visible.birthday = (await post(bola, 'Happy birthday to me, 30 today and feeling great about it.')).id;
      visible.plans = (await post(cleo, 'Dinner at our place tomorrow night, who is in?', { visibility: 'friends' })).id;
      visible.popular = (await post(bola, 'The new mural on Broad Street is finally finished.')).id;
      hidden.private = (await post(bola, 'Private note: the spare key is under the blue pot.', { visibility: 'private' })).id;
      hidden.stranger = (await post(eve, 'Stranger post about the harbour at dawn.')).id;
      hidden.blocked = (await post(dan, 'Dan shares the gate code for the rooftop party.')).id;
      await as(t.app, dan).post(`/v1/users/${ada.id}/block`);
      hidden.selected = (await post(cleo, 'Only for Eve: surprise planning for the weekend.', { visibility: 'selected', audience: [eve.id] })).id;

      // Still the same visit: no offer.
      expect((await as(t.app, ada).post('/v1/pulse/visit')).body.offer).toBe(false);
      await t.ctx.db.query(`UPDATE pulse_visits SET last_seen_at = now() - interval '13 hours' WHERE user_id = $1`, [ada.id]);
      const offer = (await as(t.app, ada).post('/v1/pulse/visit')).body;
      expect(offer).toMatchObject({ offer: true, postCount: 3 });
      // Coming back again a minute later keeps the same window.
      expect((await as(t.app, ada).post('/v1/pulse/visit')).body).toEqual(offer);
    });

    it('sends the model only posts Ada can see, and keeps only lines about them', async () => {
      const s = spy(
        JSON.stringify({
          moments: [{ text: 'Bola turned 30.', posts: [1, 2, 3] }],
          plans: [{ text: 'Made-up line about a post that was never sent.', posts: [42] }],
          popular: [],
        }),
      );
      const out = await s.gateway.assists.catchUp(ada.id);
      const prompt = s.seen.map((r) => `${r.system}\n${r.prompt}`).join('\n');
      expect(prompt).toContain('Happy birthday to me');
      expect(prompt).toContain('Dinner at our place');
      for (const text of ['spare key', 'Stranger post', 'gate code', 'surprise planning']) expect(prompt).not.toContain(text);
      const ids = out.sections.flatMap((x) => x.lines.flatMap((l) => l.posts.map((p) => p.id)));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(Object.values(visible)).toContain(id);
      expect(out.sections.map((x) => x.kind)).toEqual(['moments']);
      expect(s.seen[0]!.schema).toBeTruthy();
      await t.ctx.db.query(`DELETE FROM ai_catchups WHERE user_id = $1`, [ada.id]);
    });

    it('with the dev provider: grouped, marked, cached for the visit, checked again on every read, and logged', async () => {
      const first = await as(t.app, ada).post('/v1/ai/catch-up');
      expect(first.status).toBe(200);
      const c = first.body.catchUp;
      expect(c).toMatchObject({ postCount: 3, peopleCount: 2, provider: 'dev', cached: false });
      expect(c.notice).toMatch(/development provider/);
      const kinds = Object.fromEntries(
        c.sections.map((x: { kind: string; lines: { posts: { id: string }[] }[] }) => [x.kind, x.lines.flatMap((l) => l.posts.map((p) => p.id))]),
      );
      expect(kinds.moments).toEqual([visible.birthday]);
      expect(kinds.plans).toEqual([visible.plans]);
      expect(kinds.popular).toEqual([visible.popular]);

      const again = (await as(t.app, ada).post('/v1/ai/catch-up')).body.catchUp;
      expect(again.cached).toBe(true);
      expect(again.sections).toEqual(c.sections);

      // Deleted since: gone from the cached catch-up too.
      expect((await as(t.app, bola).del(`/v1/posts/${visible.birthday}`)).status).toBe(200);
      const after = (await as(t.app, ada).post('/v1/ai/catch-up')).body.catchUp;
      expect(after.sections.map((x: { kind: string }) => x.kind)).toEqual(['plans', 'popular']);

      const log = await calls(ada.id, 'catch_up');
      expect(log.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(log[1]!.context_scopes).toEqual(['pulse:people', 'posts:3']);
      expect(log[2]!.context_scopes).toContain('cache');
    });

    it('says there is nothing to catch up on outside a visit window, and hides the card on “Not now” and in Settings', async () => {
      expect((await as(t.app, eve).post('/v1/ai/catch-up')).status).toBe(404);
      expect((await calls(eve.id, 'catch_up')).map((r) => r.status)).toEqual(['denied']);

      expect((await as(t.app, ada).post('/v1/ai/catch-up/dismiss')).status).toBe(200);
      expect((await as(t.app, ada).post('/v1/pulse/visit')).body.offer).toBe(false);

      expect((await as(t.app, ada).put('/v1/me/ai-settings', { catchUp: false })).body).toEqual({ smartReplies: true, catchUp: false });
      expect((await t.ctx.db.query(`SELECT 1 FROM pulse_visits WHERE user_id = $1`, [ada.id])).rowCount).toBe(0);
      expect((await as(t.app, ada).post('/v1/pulse/visit')).body.offer).toBe(false);
      expect((await t.ctx.db.query(`SELECT 1 FROM pulse_visits WHERE user_id = $1`, [ada.id])).rowCount).toBe(0);
      await as(t.app, ada).put('/v1/me/ai-settings', { catchUp: true });
    });

    it('follows the feature flag and the per-person limit', async () => {
      await as(t.app, cleo).post('/v1/pulse/visit');
      await post(bola, 'Something new for Cleo to catch up on later.');
      await t.ctx.db.query(`UPDATE pulse_visits SET last_seen_at = now() - interval '2 days' WHERE user_id = $1`, [cleo.id]);
      await setFlag('AI_CATCH_UP', false);
      try {
        expect((await as(t.app, cleo).post('/v1/pulse/visit')).body.offer).toBe(false);
        expect((await as(t.app, cleo).post('/v1/ai/catch-up')).body.error.code).toBe('feature_disabled');
      } finally {
        await setFlag('AI_CATCH_UP', true);
      }
      await t.ctx.db.query(`UPDATE pulse_visits SET last_seen_at = now() - interval '2 days' WHERE user_id = $1`, [cleo.id]);
      // Cleo follows nobody: nothing of hers to catch up on.
      expect((await as(t.app, cleo).post('/v1/pulse/visit')).body.offer).toBe(false);
      await t.ctx.db.query(
        `INSERT INTO ai_tool_calls (user_id, task, provider, model, status) SELECT $1, 'catch_up', 'dev', 'dev-rules-1', 'ok' FROM generate_series(1, $2)`,
        [cleo.id, AI_LIMITS.catch_up.max],
      );
      const limited = await as(t.app, cleo).post('/v1/ai/catch-up');
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('ai_limit');
    });
  });

  describe('Suggested replies', () => {
    let direct: string;
    let group: string;
    const send = async (u: TestUser, conv: string, body: string) => {
      const r = await as(t.app, u).post(`/v1/conversations/${conv}/messages`, { body });
      expect(r.status).toBe(201);
      return r.body.message as { id: string };
    };
    const suggest = (u: TestUser, conv: string) => as(t.app, u).post(`/v1/conversations/${conv}/smart-replies`);

    beforeAll(async () => {
      await as(t.app, bola).post(`/v1/users/${ada.id}/follow`);
      direct = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation.id;
      group = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id, cleo.id], title: 'Weekend' })).body.conversation.id;
    });

    it('suggests up to three replies to the last message received, in its language, marked, cached and logged', async () => {
      const m = await send(bola, direct, 'Are you coming to the dinner tonight?');
      const r = await suggest(ada, direct);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ messageId: m.id, suggestions: devReplies('?', 'en'), language: 'en', provider: 'dev' });
      expect(r.body.notice).toMatch(/development provider/);
      expect((await suggest(ada, direct)).body.suggestions).toEqual(r.body.suggestions);
      const log = await calls(ada.id, 'smart_replies');
      expect(log.map((x) => x.status)).toEqual(['ok', 'ok']);
      expect(log[0]!.context_scopes).toEqual([`conversation:${direct}`]);
      expect(log[1]!.context_scopes).toContain('cache');

      await send(bola, direct, 'Bonjour, est-ce que tu viens à la fête avec nous ce soir avec tes amis ?');
      expect((await suggest(ada, direct)).body).toMatchObject({ language: 'fr', suggestions: devReplies('?', 'fr') });

      // The sender gets nothing: the last message is theirs.
      expect((await suggest(bola, direct)).body).toMatchObject({ suggestions: [], reason: 'none' });
    });

    it('never for view-once, voice or sensitive messages', async () => {
      await t.ctx.db.query(`INSERT INTO messages (conversation_id, sender_id, body, view_once) VALUES ($1,$2,'',true)`, [direct, bola.id]);
      expect((await suggest(ada, direct)).body).toMatchObject({ suggestions: [], reason: 'view_once' });
      await t.ctx.db.query(
        `INSERT INTO messages (conversation_id, sender_id, body, kind, attachments) VALUES ($1,$2,'','yap','[{"kind":"audio","url":"/x.m4a"}]')`,
        [direct, bola.id],
      );
      expect((await suggest(ada, direct)).body).toMatchObject({ suggestions: [], reason: 'voice' });
      await send(bola, direct, 'My grandmother passed away this morning.');
      expect((await suggest(ada, direct)).body).toMatchObject({ suggestions: [], reason: 'sensitive' });
    });

    it('only for members, and only from messages the person can see', async () => {
      expect((await suggest(eve, direct)).status).toBe(404);
      expect((await calls(eve.id, 'smart_replies')).map((x) => x.status)).toEqual(['denied']);

      await as(t.app, ada).put(`/v1/conversations/${group}/smart-replies`, { enabled: true });
      await send(ada, group, 'Planning the picnic for Saturday afternoon.');
      await send(bola, group, 'The quiet park near the river works for me.');
      await send(cleo, group, 'Cleo’s secret: I will bring the lemon cake?');
      await as(t.app, ada).post(`/v1/users/${cleo.id}/block`);
      await send(bola, group, 'Shall we meet at noon by the gate?');
      const s = spy(JSON.stringify({ replies: ['Noon works', 'Can we do one?', 'noon works', 'Sure', 'Fine'] }));
      const out = await s.gateway.assists.smartReplies(ada.id, group, true);
      expect(s.seen).toHaveLength(1);
      expect(s.seen[0]!.prompt).toContain('quiet park near the river');
      expect(s.seen[0]!.prompt).not.toContain('lemon cake');
      expect(s.seen[0]!.prompt).not.toContain('passed away'); // another chat
      expect(out.suggestions).toEqual(['Noon works', 'Can we do one?', 'Sure']);
      await as(t.app, ada).del(`/v1/users/${cleo.id}/block`);
    });

    it('is off by default in groups, and follows the chat switch, the Settings switch and the flag', async () => {
      const g2 = (await as(t.app, bola).post('/v1/conversations', { memberIds: [ada.id, cleo.id], title: 'Book club' })).body.conversation;
      expect(g2.smartReplies).toEqual({ on: false, setting: null, defaultOn: false, everywhere: true });
      await send(bola, g2.id, 'Which book should we read next month?');
      expect((await suggest(ada, g2.id)).body).toMatchObject({ suggestions: [], reason: 'off' });
      const set = await as(t.app, ada).put(`/v1/conversations/${g2.id}/smart-replies`, { enabled: true });
      expect(set.body.smartReplies).toEqual({ on: true, setting: true, defaultOn: false, everywhere: true });
      expect((await suggest(ada, g2.id)).body.suggestions).toHaveLength(3);
      expect((await as(t.app, ada).get(`/v1/conversations/${direct}`)).body.conversation.smartReplies).toMatchObject({ on: true, defaultOn: true });

      await as(t.app, ada).put('/v1/me/ai-settings', { smartReplies: false });
      expect((await as(t.app, ada).get(`/v1/conversations/${g2.id}`)).body.conversation.smartReplies.on).toBe(false);
      await send(bola, g2.id, 'Or should we pick a film instead this time?');
      expect((await suggest(ada, g2.id)).body.reason).toBe('off');
      await as(t.app, ada).put('/v1/me/ai-settings', { smartReplies: true });

      await setFlag('AI_SMART_REPLIES', false);
      try {
        const off = await suggest(ada, g2.id);
        expect(off.status).toBe(404);
        expect(off.body.error.code).toBe('feature_disabled');
        expect((await as(t.app, ada).get(`/v1/conversations/${g2.id}`)).body.conversation.smartReplies.on).toBe(false);
      } finally {
        await setFlag('AI_SMART_REPLIES', true);
      }
    });

    it('is off by default for people under 18, who can turn it on', async () => {
      const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-03-01` });
      expect((await as(t.app, teen).get('/v1/me/ai-settings')).body).toEqual({ smartReplies: false, catchUp: true });
      expect((await as(t.app, teen).put('/v1/me/ai-settings', { smartReplies: true })).body.smartReplies).toBe(true);
    });

    it('has a per-person limit', async () => {
      await t.ctx.db.query(
        `INSERT INTO ai_tool_calls (user_id, task, provider, model, status) SELECT $1, 'smart_replies', 'dev', 'dev-rules-1', 'ok' FROM generate_series(1, $2)`,
        [bola.id, AI_LIMITS.smart_replies.max],
      );
      await send(ada, direct, 'See you at the dinner then.');
      const r = await suggest(bola, direct);
      expect(r.status).toBe(429);
      expect(r.body.error.code).toBe('ai_limit');
    });
  });

  describe('Photo descriptions', () => {
    it('suggests a marked placeholder in development, for your own photos only, and logs it', async () => {
      const id = await photo(ada);
      const r = await as(t.app, ada).post('/v1/ai/alt-text', { mediaId: id });
      expect(r.status).toBe(200);
      expect(r.body.suggestion.text).toMatch(/^\[Placeholder\] Photo \(64 × 48\)/);
      expect(r.body.suggestion.notice).toMatch(/development provider/);
      // Nothing is saved: the description is only a suggestion.
      expect((await t.ctx.db.query(`SELECT alt_text FROM media WHERE id = $1`, [id])).rows[0].alt_text).toBeNull();

      expect((await as(t.app, bola).post('/v1/ai/alt-text', { mediaId: id })).status).toBe(404);
      expect((await calls(bola.id, 'alt_text')).map((x) => x.status)).toEqual(['denied']);
      expect((await calls(ada.id, 'alt_text'))[0]).toMatchObject({ status: 'ok', context_scopes: [`media:${id}`] });

      expect((await as(t.app, ada).post('/v1/ai/alt-text', { mediaId: await photo(ada, 'video') })).status).toBe(400);
    });

    it('sends the photo itself to a vision model, made smaller', async () => {
      const id = await photo(ada);
      const s = spy('A small orange square on a plain background.');
      const out = await s.gateway.assists.altText(ada.id, id);
      expect(out.text).toBe('A small orange square on a plain background.');
      expect(s.seen[0]!.images).toHaveLength(1);
      expect(s.seen[0]!.images![0]!.mime).toBe('image/jpeg');
      const meta = await sharp(Buffer.from(s.seen[0]!.images![0]!.base64, 'base64')).metadata();
      expect(meta.format).toBe('jpeg');
    });

    it('follows the flag', async () => {
      await setFlag('AI_ALT_TEXT', false);
      try {
        expect((await as(t.app, ada).post('/v1/ai/alt-text', { mediaId: await photo(ada) })).body.error.code).toBe('feature_disabled');
      } finally {
        await setFlag('AI_ALT_TEXT', true);
      }
    });
  });

  describe('Caption and hashtag ideas', () => {
    beforeAll(async () => {
      await post(bola, 'Golden hour over the lagoon #lagos #sunset');
      await post(cleo, 'Evening swim #sunset #beachday');
      await post(eve, 'Market run #lagoslife');
      await post(bola, 'Hidden spot, tell no one #secretcove', { visibility: 'private' });
    });

    it('gives three marked captions and hashtags people already use, never ones from posts others can’t see', async () => {
      const r = await as(t.app, ada).post('/v1/ai/captions', { text: 'Sunset walk in Lagos with friends, near the secretcove.' });
      expect(r.status).toBe(200);
      const ideas = r.body.ideas;
      expect(ideas.captions).toEqual(devCaptions('Sunset walk in Lagos with friends, near the secretcove.', []));
      expect(ideas.hashtags).toEqual(expect.arrayContaining(['lagos', 'sunset']));
      expect(ideas.hashtags).not.toContain('secretcove');
      expect(ideas.hashtags).not.toContain('friends');
      expect(ideas.notice).toMatch(/development provider/);
      // Tags already in the text aren't suggested again.
      expect((await as(t.app, ada).post('/v1/ai/captions', { text: 'Sunset in #lagos' })).body.ideas.hashtags).not.toContain('lagos');
      expect((await calls(ada.id, 'caption_ideas'))[0]).toMatchObject({ status: 'ok', context_scopes: ['input', 'hashtags'] });
    });

    it('only uses your own photos, keeps model hashtags to existing ones, and leaves your posts out when Personalization is off', async () => {
      const theirs = await photo(bola);
      expect((await as(t.app, ada).post('/v1/ai/captions', { text: 'x', mediaIds: [theirs] })).status).toBe(404);
      expect((await as(t.app, ada).post('/v1/ai/captions', { text: '' })).status).toBe(400);

      await post(ada, 'My own earlier post about slow mornings and strong coffee.');
      const mine = await photo(ada);
      const s = spy(JSON.stringify({ captions: ['Golden light #glow', 'Evening walk', 'Evening walk'], hashtags: ['#Sunset', 'madeuptag', 'secretcove'] }));
      const out = await s.gateway.assists.captionIdeas(ada.id, { text: 'Evening by the water', mediaIds: [mine], format: 'post' });
      expect(out.captions).toEqual(['Golden light', 'Evening walk']);
      expect(out.hashtags).toEqual(['sunset']);
      expect(s.seen[0]!.images).toHaveLength(1);
      expect(s.seen[0]!.prompt).toContain('slow mornings');
      expect(s.seen[0]!.prompt).not.toContain('secretcove');

      await as(t.app, ada).put('/v1/me/consents', { purpose: 'personalization', granted: false });
      await s.gateway.assists.captionIdeas(ada.id, { text: 'Evening by the water', mediaIds: [], format: 'post' });
      expect(s.seen[1]!.prompt).not.toContain('slow mornings');
      await as(t.app, ada).put('/v1/me/consents', { purpose: 'personalization', granted: true });
    });

    it('follows the flag and the per-person limit', async () => {
      await setFlag('AI_CAPTIONS', false);
      try {
        expect((await as(t.app, cleo).post('/v1/ai/captions', { text: 'hello there' })).body.error.code).toBe('feature_disabled');
      } finally {
        await setFlag('AI_CAPTIONS', true);
      }
      await t.ctx.db.query(
        `INSERT INTO ai_tool_calls (user_id, task, provider, model, status) SELECT $1, 'caption_ideas', 'dev', 'dev-rules-1', 'ok' FROM generate_series(1, $2)`,
        [cleo.id, AI_LIMITS.caption_ideas.max],
      );
      expect((await as(t.app, cleo).post('/v1/ai/captions', { text: 'hello there' })).status).toBe(429);
    });
  });

  it('dev provider output is deterministic', () => {
    expect(devReplies('Are you in?', 'en')).toEqual(['Yes', 'Not sure yet', 'Let me check']);
    expect(devReplies('Merci pour hier soir', 'fr')).toEqual(['Ça marche', 'Merci', 'À bientôt']);
    expect(devReplies('Hello', 'xx')).toEqual(devReplies('Hello', 'en'));
    expect(devCaptions('', ['A red bicycle against a wall.'])).toEqual([
      'A red bicycle against a wall.',
      'A red bicycle against a wall. More soon.',
      'Today: a red bicycle against a wall',
    ]);
  });
});
