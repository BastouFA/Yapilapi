import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { ASK_LIMITS } from '@yapilapi/shared';

let t: BuiltApp;
let mod: TestUser;

beforeAll(async () => {
  t = await testApp();
  mod = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const minor = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
const befriend = (a: TestUser, b: TestUser) => {
  const [x, y] = [a.id, b.id].sort();
  return db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
};
const follow = (a: TestUser, b: TestUser) => as(t.app, a).post(`/v1/users/${b.id}/follow`);
const openBox = (u: TestUser, body: Record<string, unknown> = {}) => as(t.app, u).put('/v1/me/ask-box', { enabled: true, ...body });
const ask = (from: TestUser | null, to: TestUser, body = 'What camera do you use?', hideName = false) =>
  as(t.app, from).post(`/v1/users/${to.id}/questions`, { body, hideName });
const inbox = async (u: TestUser, filter = 'new') => {
  const r = await as(t.app, u).get(`/v1/me/questions?filter=${filter}`);
  expect(r.status).toBe(200);
  return r.body;
};
const profileOf = async (viewer: TestUser | null, u: TestUser) => (await as(t.app, viewer).get(`/v1/users/${u.username}`)).body.profile;
/** Whether any part of a response mentions this person. */
const mentions = (body: unknown, u: TestUser) => {
  const s = JSON.stringify(body);
  return s.includes(u.id) || s.toLowerCase().includes(u.username.toLowerCase());
};

describe('question box settings', () => {
  it('starts off, saves the prompt and choices, and shows the box on the profile', async () => {
    const ada = await adult();
    const bola = await adult();
    expect((await as(t.app, ada).get('/v1/me/ask-box')).body.box).toEqual({
      enabled: false,
      prompt: null,
      audience: 'everyone',
      allowHiddenNames: false,
      hiddenNamesAvailable: true,
    });
    expect(await profileOf(bola, ada)).toMatchObject({ ask: null });
    expect((await profileOf(bola, ada)).tabs).not.toContain('answers');

    const r = await openBox(ada, { prompt: '  Ask me about film photography ', allowHiddenNames: true });
    expect(r.status).toBe(200);
    expect(r.body.box).toMatchObject({ enabled: true, prompt: 'Ask me about film photography', allowHiddenNames: true });
    expect((await profileOf(bola, ada)).ask).toEqual({
      enabled: true,
      prompt: 'Ask me about film photography',
      hiddenNamesAllowed: true,
      canAsk: true,
      answers: 0,
    });
    expect((await profileOf(bola, ada)).tabs).toContain('answers');
    // Your own profile shows your box, but you can't ask yourself.
    expect((await profileOf(ada, ada)).ask).toMatchObject({ enabled: true, canAsk: false, refusal: 'self' });
    // Signed out: the box shows, asking needs an account.
    expect((await profileOf(null, ada)).ask).toMatchObject({ canAsk: false, refusal: 'signed_out' });

    for (const body of [{ prompt: 'x'.repeat(121) }, { prompt: 'see www.example.com' }, { audience: 'strangers' }, { enabled: 'yes' }])
      expect((await as(t.app, ada).put('/v1/me/ask-box', body)).status, JSON.stringify(body)).toBe(400);
  });

  it('adds Answers to a profile that chose its tabs, once, when the box is turned on', async () => {
    const ada = await adult();
    expect((await as(t.app, ada).patch('/v1/me/profile', { tabs: ['reels', 'posts'] })).status).toBe(200);
    await openBox(ada);
    expect((await profileOf(ada, ada)).tabs).toEqual(['reels', 'posts', 'answers']);
    // Moved or hidden afterwards, it stays where they put it.
    expect((await as(t.app, ada).patch('/v1/me/profile', { tabs: ['answers', 'posts'] })).status).toBe(200);
    await as(t.app, ada).put('/v1/me/ask-box', { prompt: 'Anything' });
    expect((await profileOf(ada, ada)).tabs).toEqual(['answers', 'posts']);
    await as(t.app, ada).put('/v1/me/ask-box', { enabled: false });
    // Off with no answers: the tab isn't listed (and a profile never ends up with none).
    expect((await profileOf(ada, ada)).tabs).toEqual(['posts']);
  });

  it('never lets people under 18 get questions without a name', async () => {
    const teen = await minor();
    expect((await as(t.app, teen).get('/v1/me/ask-box')).body.box).toMatchObject({ hiddenNamesAvailable: false, allowHiddenNames: false });
    const r = await openBox(teen, { allowHiddenNames: true });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('minor_protection');
    expect((await openBox(teen)).status).toBe(200);
    // Even a value saved some other way isn't honoured.
    await db().query(`UPDATE ask_boxes SET allow_hidden_names = true WHERE user_id = $1`, [teen.id]);
    const friend = await minor();
    await befriend(teen, friend);
    await follow(friend, teen);
    const hidden = await ask(friend, teen, 'Who is your favourite band?', true);
    expect(hidden.status).toBe(403);
    expect(hidden.body.error.code).toBe('hidden_names_off');
    expect((await ask(friend, teen, 'Who is your favourite band?')).status).toBe(201);
  });
});

describe('who can ask', () => {
  it('needs an account, and refuses yourself and a box that is off', async () => {
    const ada = await adult();
    const bola = await adult();
    expect((await ask(bola, ada)).status).toBe(403);
    await openBox(ada);
    expect((await ask(null, ada)).status).toBe(401);
    expect((await ask(ada, ada)).status).toBe(400);
    expect((await ask(bola, ada)).status).toBe(201);
    expect((await as(t.app, bola).post(`/v1/users/00000000-0000-4000-8000-000000000000/questions`, { body: 'Hi?' })).status).toBe(404);
  });

  it('applies blocks both ways, with or without a name', async () => {
    const ada = await adult();
    const bola = await adult();
    const cat = await adult();
    await openBox(ada, { allowHiddenNames: true });
    await as(t.app, ada).post(`/v1/users/${bola.id}/block`);
    await as(t.app, cat).post(`/v1/users/${ada.id}/block`);
    for (const who of [bola, cat])
      for (const hide of [false, true]) {
        const r = await ask(who, ada, 'Hello?', hide);
        expect(r.status).toBe(403);
        expect(r.body.error.message).toBe('You can’t ask this person questions.');
      }
  });

  it('follows the box audience and private accounts', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada, { audience: 'following' });
    expect((await ask(bola, ada)).body.error.code).toBe('ask_audience');
    await follow(ada, bola);
    expect((await ask(bola, ada)).status).toBe(201);

    await as(t.app, ada).put('/v1/me/ask-box', { audience: 'friends' });
    expect((await ask(bola, ada)).body.error.code).toBe('ask_audience');
    await befriend(ada, bola);
    expect((await ask(bola, ada)).status).toBe(201);

    const priv = await adult();
    const cat = await adult();
    await as(t.app, priv).patch('/v1/me/profile', { isPrivate: true });
    await openBox(priv);
    expect((await profileOf(cat, priv)).ask).toMatchObject({ canAsk: false, refusal: 'private' });
    expect((await ask(cat, priv)).body.error.code).toBe('ask_private');
    await follow(cat, priv);
    expect((await ask(cat, priv)).status).toBe(201);
  });

  it('refuses adults asking people under 18 they are not friends with', async () => {
    const teen = await minor();
    const grown = await adult();
    const peer = await minor();
    await openBox(teen);
    await follow(grown, teen);
    await follow(peer, teen);
    const r = await ask(grown, teen);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('minor_protection');
    expect((await profileOf(grown, teen)).ask).toMatchObject({ canAsk: false, refusal: 'minor' });
    // Another teen can ask; an adult friend can too.
    expect((await ask(peer, teen)).status).toBe(201);
    await befriend(teen, grown);
    expect((await ask(grown, teen)).status).toBe(201);
  });

  it('refuses a name hidden when the box asks for names', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada);
    const r = await ask(bola, ada, 'Secret?', true);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('hidden_names_off');
    expect((await as(t.app, bola).post(`/v1/users/${ada.id}/questions`, { body: 'x'.repeat(301) })).status).toBe(400);
    expect((await as(t.app, bola).post(`/v1/users/${ada.id}/questions`, { body: '   ' })).status).toBe(400);
  });
});

describe('pace', () => {
  it('limits questions to one person a day, per asker an hour and per box an hour', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada);
    for (let i = 0; i < ASK_LIMITS.perAskerPerRecipientPerDay; i++) expect((await ask(bola, ada, `Question number ${i}?`)).status).toBe(201);
    const r = await ask(bola, ada, 'One more?');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('slow_down');

    // Across everyone, in the last hour.
    const cat = await adult();
    const others = await Promise.all([adult(), adult()]);
    for (const o of others) await openBox(o);
    await db().query(`INSERT INTO ask_questions (recipient_id, asker_id, body) SELECT $2, $1, 'Earlier question ' || g FROM generate_series(1, $3) g`, [
      cat.id,
      others[0]!.id,
      ASK_LIMITS.perAskerPerHour,
    ]);
    const tooMany = await ask(cat, others[1]!);
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error.code).toBe('slow_down');

    // A box getting a flood of questions says so.
    const busy = await adult();
    const filler = await adult();
    await openBox(busy);
    await db().query(`INSERT INTO ask_questions (recipient_id, asker_id, body) SELECT $1, $3, 'Flood question ' || g FROM generate_series(1, $2) g`, [
      busy.id,
      ASK_LIMITS.perRecipientPerHour,
      filler.id,
    ]);
    const dave = await adult();
    const flooded = await ask(dave, busy);
    expect(flooded.status).toBe(429);
    expect(flooded.body.error.code).toBe('box_busy');
  });
});

describe('answering', () => {
  it('answers, notifies the asker, shows the card on the Answers tab and hides and deletes', async () => {
    const ada = await adult();
    const bola = await adult();
    const cat = await adult();
    await openBox(ada, { prompt: 'Ask me anything' });
    const q = await ask(bola, ada, 'What camera do you use?');
    expect(q.status).toBe(201);
    const id = q.body.question.id as string;

    const box = await inbox(ada);
    expect(box.counts).toEqual({ new: 1, answered: 0, hidden: 0 });
    expect(box.items[0]).toMatchObject({ id, question: 'What camera do you use?', askedWithoutName: false, state: 'new', asker: { id: bola.id } });
    const received = (await as(t.app, ada).get('/v1/notifications')).body.items.find((n: any) => n.type === 'question_received');
    expect(received).toMatchObject({ entityType: 'question', entityId: id, actor: { id: bola.id } });

    // Only the owner can answer.
    expect((await as(t.app, cat).post(`/v1/questions/${id}/answer`, { answer: 'Mine' })).status).toBe(404);
    const a = await as(t.app, ada).post(`/v1/questions/${id}/answer`, { answer: 'A Pentax K1000.' });
    expect(a.status).toBe(200);
    expect(a.body.question).toMatchObject({ state: 'answered', answer: 'A Pentax K1000.', held: false });
    expect(a.body.post).toBeUndefined();
    expect((await as(t.app, ada).post(`/v1/questions/${id}/answer`, { answer: 'Again' })).status).toBe(409);

    const told = (await as(t.app, bola).get('/v1/notifications')).body.items.find((n: any) => n.type === 'question_answered');
    expect(told).toMatchObject({ entityType: 'question', entityId: id, actor: { id: ada.id } });

    const answers = await as(t.app, cat).get(`/v1/users/${ada.id}/answers`);
    expect(answers.body.items).toEqual([
      expect.objectContaining({
        id,
        question: 'What camera do you use?',
        askedWithoutName: false,
        asker: expect.objectContaining({ id: bola.id, username: bola.username }),
        answer: 'A Pentax K1000.',
        owner: expect.objectContaining({ id: ada.id }),
      }),
    ]);
    expect((await as(t.app, cat).get(`/v1/questions/${id}`)).body.answer.id).toBe(id);
    expect((await profileOf(cat, ada)).ask).toMatchObject({ answers: 1 });

    // Hidden: gone from the tab until it's brought back.
    expect((await as(t.app, ada).post(`/v1/questions/${id}/hide`)).body.question.state).toBe('hidden');
    expect((await as(t.app, cat).get(`/v1/users/${ada.id}/answers`)).body.items).toEqual([]);
    expect((await as(t.app, cat).get(`/v1/questions/${id}`)).status).toBe(404);
    expect((await as(t.app, ada).del(`/v1/questions/${id}/hide`)).body.question.state).toBe('answered');
    expect((await as(t.app, cat).get(`/v1/users/${ada.id}/answers`)).body.items).toHaveLength(1);
    // Nobody else can hide or delete it.
    expect((await as(t.app, bola).post(`/v1/questions/${id}/hide`)).status).toBe(404);
    expect((await as(t.app, bola).del(`/v1/questions/${id}`)).status).toBe(404);
    expect((await as(t.app, ada).del(`/v1/questions/${id}`)).status).toBe(200);
    expect((await as(t.app, cat).get(`/v1/users/${ada.id}/answers`)).body.items).toEqual([]);
    expect((await inbox(ada, 'answered')).items).toEqual([]);
  });

  it('shares an answer as a post quoting the question', async () => {
    const ada = await adult();
    const bola = await adult();
    const cat = await adult();
    await openBox(ada);
    const id = (await ask(bola, ada, 'Favourite film stock?')).body.question.id;
    const a = await as(t.app, ada).post(`/v1/questions/${id}/answer`, { answer: 'Portra 400, always.', share: { visibility: 'public' } });
    expect(a.status).toBe(200);
    expect(a.body.post).toMatchObject({
      body: 'Portra 400, always.',
      visibility: 'public',
      question: { id, question: 'Favourite film stock?', askedWithoutName: false },
    });
    const seen = await as(t.app, cat).get(`/v1/posts/${a.body.post.id}`);
    expect(seen.body.post.question).toMatchObject({ id, question: 'Favourite film stock?', asker: { id: bola.id } });
    // Deleting the question leaves the post, without the quote.
    await as(t.app, ada).del(`/v1/questions/${id}`);
    expect((await as(t.app, cat).get(`/v1/posts/${a.body.post.id}`)).body.post.question).toBeNull();
    expect((await as(t.app, ada).post(`/v1/questions/${id}/answer`, { answer: 'x', share: { visibility: 'circle' } })).status).toBe(400);
  });

  it('keeps answers on a private account for its followers', async () => {
    const priv = await adult();
    const fan = await adult();
    const stranger = await adult();
    await as(t.app, priv).patch('/v1/me/profile', { isPrivate: true });
    await openBox(priv);
    await follow(fan, priv);
    const id = (await ask(fan, priv)).body.question.id;
    await as(t.app, priv).post(`/v1/questions/${id}/answer`, { answer: 'A small one.' });
    expect((await as(t.app, fan).get(`/v1/users/${priv.id}/answers`)).body.items).toHaveLength(1);
    expect((await as(t.app, stranger).get(`/v1/users/${priv.id}/answers`)).body.items).toEqual([]);
    expect((await as(t.app, null).get(`/v1/users/${priv.id}/answers`)).body.items).toEqual([]);
  });
});

describe('questions without a name', () => {
  it('never says who asked, to the owner, visitors or the asker, anywhere', async () => {
    const ada = await adult();
    const bola = await adult();
    const cat = await adult();
    await openBox(ada, { allowHiddenNames: true });
    const q = await ask(bola, ada, 'Do you ever get nervous on stage?', true);
    expect(q.status).toBe(201);
    const id = q.body.question.id as string;
    // It is stored.
    expect((await db().query(`SELECT asker_id FROM ask_questions WHERE id = $1`, [id])).rows[0].asker_id).toBe(bola.id);

    const box = await inbox(ada);
    expect(box.items[0]).toMatchObject({ id, askedWithoutName: true, asker: null });
    expect(mentions(box, bola)).toBe(false);
    const notes = await as(t.app, ada).get('/v1/notifications');
    const n = notes.body.items.find((x: any) => x.type === 'question_received');
    expect(n).toMatchObject({ entityId: id, actor: null });
    expect(mentions(notes.body, bola)).toBe(false);

    const answered = await as(t.app, ada).post(`/v1/questions/${id}/answer`, { answer: 'Every time.', share: { visibility: 'public' } });
    expect(mentions(answered.body, bola)).toBe(false);
    expect(answered.body.post.question).toMatchObject({ askedWithoutName: true, asker: null });

    for (const viewer of [ada, cat, bola, null]) {
      const tab = await as(t.app, viewer).get(`/v1/users/${ada.id}/answers`);
      expect(tab.body.items[0]).toMatchObject({ id, askedWithoutName: true, asker: null });
      expect(mentions(tab.body, bola)).toBe(false);
      const one = await as(t.app, viewer).get(`/v1/questions/${id}`);
      expect(mentions(one.body, bola)).toBe(false);
      const post = await as(t.app, viewer).get(`/v1/posts/${answered.body.post.id}`);
      expect(mentions(post.body, bola)).toBe(false);
    }
    const feed = await as(t.app, cat).get(`/v1/users/${ada.username}/posts`);
    expect(mentions(feed.body, bola)).toBe(false);
    for (const filter of ['new', 'answered', 'hidden']) expect(mentions(await inbox(ada, filter), bola)).toBe(false);

    // The owner's data export leaves the asker out too.
    const exported = await as(t.app, ada).get('/v1/me/export');
    expect(exported.body.questionsReceived[0]).toMatchObject({ body: 'Do you ever get nervous on stage?', hide_name: true, asker_id: null });
    expect(mentions(exported.body.questionsReceived, bola)).toBe(false);
    // The asker's export has their own question.
    const theirs = await as(t.app, bola).get('/v1/me/export');
    expect(theirs.body.questionsAsked[0]).toMatchObject({
      recipient_id: ada.id,
      body: 'Do you ever get nervous on stage?',
      hide_name: true,
      answer: 'Every time.',
    });
  });

  it('can be reported by the owner; moderators see who asked', async () => {
    const ada = await adult();
    const bola = await adult();
    const cat = await adult();
    await openBox(ada, { allowHiddenNames: true });
    const id = (await ask(bola, ada, 'Why do you even post?', true)).body.question.id;
    // Only the person asked can report a question.
    expect((await as(t.app, cat).post('/v1/reports', { targetType: 'question', targetId: id, reason: 'harassment' })).status).toBe(404);
    const r = await as(t.app, ada).post('/v1/reports', { targetType: 'question', targetId: id, reason: 'harassment' });
    expect(r.status).toBe(201);
    expect(mentions(r.body, bola)).toBe(false);
    const cases = await as(t.app, mod).get('/v1/admin/moderation/cases');
    const c = cases.body.items.find((x: any) => x.target_type === 'question' && x.target_id === id);
    expect(c).toMatchObject({ subject_user_id: bola.id, subject_username: bola.username, excerpt: 'Why do you even post?' });
    // Removed: gone from the inbox.
    expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${c.id}/decide`, { decision: 'remove' })).status).toBe(200);
    expect((await inbox(ada)).items).toEqual([]);
  });

  it('blocks the asker by question without saying who they are', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada, { allowHiddenNames: true });
    const id = (await ask(bola, ada, 'Can I ask another?', true)).body.question.id;
    const b = await as(t.app, ada).post(`/v1/questions/${id}/block-asker`);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ blocked: true, scope: 'questions', question: { state: 'hidden', askerBlocked: true, asker: null } });
    expect(mentions(b.body, bola)).toBe(false);
    // Not in the blocked list, and their profile doesn't show as blocked.
    const blocked = await as(t.app, ada).get('/v1/me/blocked');
    expect(mentions(blocked.body, bola)).toBe(false);
    expect((await profileOf(ada, bola)).relationship.blocked).toBe(false);
    // They can't ask again, with or without a name, and no longer see the box.
    for (const hide of [true, false]) expect((await ask(bola, ada, 'Please?', hide)).status).toBe(403);
    expect((await profileOf(bola, ada)).ask).toBeNull();
    // Undone from the same question.
    const u = await as(t.app, ada).del(`/v1/questions/${id}/block-asker`);
    expect(u.body.question.askerBlocked).toBe(false);
    expect((await ask(bola, ada, 'Now?', true)).status).toBe(201);
  });

  it('blocks a named asker with an ordinary block', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada);
    const id = (await ask(bola, ada)).body.question.id;
    const b = await as(t.app, ada).post(`/v1/questions/${id}/block-asker`);
    expect(b.body).toMatchObject({ blocked: true, scope: 'account' });
    expect((await as(t.app, ada).get('/v1/me/blocked')).body.items.map((x: any) => x.id)).toContain(bola.id);
    expect((await ask(bola, ada)).status).toBe(403);
  });
});

describe('moderation and accounts', () => {
  it('holds a flagged question until a moderator lets it through', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada);
    const r = await ask(bola, ada, 'Why are you such an idiot?');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ noticeCode: 'question_held', notice: 'Your question will reach them once our team has reviewed it.' });
    expect((await inbox(ada)).items).toEqual([]);
    expect((await as(t.app, ada).get('/v1/notifications')).body.items.some((n: any) => n.type === 'question_received')).toBe(false);
    const c = (await as(t.app, mod).get('/v1/admin/moderation/cases')).body.items.find((x: any) => x.target_id === r.body.question.id);
    expect(c).toMatchObject({ target_type: 'question', source: 'automated', subject_user_id: bola.id });
    await as(t.app, mod).post(`/v1/admin/moderation/cases/${c.id}/decide`, { decision: 'no_action' });
    expect((await inbox(ada)).items.map((q: any) => q.id)).toEqual([r.body.question.id]);
    expect((await as(t.app, ada).get('/v1/notifications')).body.items.some((n: any) => n.type === 'question_received')).toBe(true);
    // Refused outright when it may put someone at risk.
    expect((await ask(bola, ada, 'go kill yourself')).status).toBe(422);
  });

  it('holds a flagged answer, visible only to the owner, and lets others report answers', async () => {
    const ada = await adult();
    const bola = await adult();
    const cat = await adult();
    await openBox(ada);
    const id = (await ask(bola, ada)).body.question.id;
    const a = await as(t.app, ada).post(`/v1/questions/${id}/answer`, { answer: 'Only an idiot would ask.' });
    expect(a.body.question.held).toBe(true);
    expect(a.body.moderation).toEqual({ status: 'review', code: 'answer_held', message: 'Your answer is visible only to you until it has been reviewed.' });
    expect((await as(t.app, ada).get(`/v1/users/${ada.id}/answers`)).body.items[0]).toMatchObject({ id, held: true });
    expect((await as(t.app, cat).get(`/v1/users/${ada.id}/answers`)).body.items).toEqual([]);
    expect((await as(t.app, bola).get('/v1/notifications')).body.items.some((n: any) => n.type === 'question_answered')).toBe(false);

    const q2 = (await ask(cat, ada, 'Coffee or tea?')).body.question.id;
    await as(t.app, ada).post(`/v1/questions/${q2}/answer`, { answer: 'Tea.' });
    expect((await as(t.app, bola).post('/v1/reports', { targetType: 'answer', targetId: q2, reason: 'spam' })).status).toBe(201);
    expect((await as(t.app, bola).post('/v1/reports', { targetType: 'answer', targetId: id, reason: 'spam' })).status).toBe(404);
  });

  it('deletes questions and answers with the account', async () => {
    const ada = await adult();
    const bola = await adult();
    await openBox(ada);
    await openBox(bola);
    const asked = (await ask(bola, ada)).body.question.id;
    const received = (await ask(ada, bola)).body.question.id;
    await as(t.app, ada).post(`/v1/questions/${asked}/answer`, { answer: 'Sure.' });
    expect((await as(t.app, bola).del('/v1/me', { password: bola.password })).status).toBe(200);
    const left = await db().query(`SELECT id FROM ask_questions WHERE id = ANY($1::uuid[])`, [[asked, received]]);
    expect(left.rowCount).toBe(0);
    expect((await db().query(`SELECT 1 FROM ask_boxes WHERE user_id = $1`, [bola.id])).rowCount).toBe(0);
    expect((await as(t.app, ada).get(`/v1/users/${ada.id}/answers`)).body.items).toEqual([]);
  });
});

describe('spam checks', () => {
  it('holds the same question sent to many people, like comments and messages', async () => {
    const s = await testApp({ SPAM_CHECKS: 'true' });
    try {
      const asker = await signUp(s.app);
      const boxes = await Promise.all(Array.from({ length: 5 }, () => signUp(s.app)));
      const ids: string[] = [];
      for (const b of boxes) {
        await as(s.app, b).put('/v1/me/ask-box', { enabled: true });
        const r = await as(s.app, asker).post(`/v1/users/${b.id}/questions`, { body: 'What is your favourite place to eat?' });
        expect(r.status).toBe(201);
        ids.push(r.body.question.id);
      }
      const status = await s.ctx.db.query(`SELECT id, moderation_status FROM ask_questions WHERE id = ANY($1::uuid[])`, [ids]);
      const held = status.rows.filter((r) => r.moderation_status === 'review').map((r) => r.id);
      expect(held).toEqual([ids[4]]);
      const signal = await s.ctx.db.query(`SELECT kind, target_type FROM risk_signals WHERE user_id = $1 AND target_id = $2`, [asker.id, ids[4]]);
      expect(signal.rows).toEqual([{ kind: 'duplicate_text', target_type: 'question' }]);
      expect((await as(s.app, boxes[4]!).get('/v1/me/questions')).body.items).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
