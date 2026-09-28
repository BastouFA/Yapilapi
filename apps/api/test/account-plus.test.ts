import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceName, placeName, signInEmail, signInFingerprint } from '../src/lib/sign-in-alerts.ts';
import { SEND_LATER_JOB } from '../src/modules/chat-later.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser, jobRunner, type JobRunner } from './helpers.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0';

let seq = 0;
const name = (prefix: string) => `${prefix}_${Date.now().toString(36)}${++seq}`.slice(0, 30);

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

async function direct(a: TestUser, b: TestUser): Promise<string> {
  await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id;
}

const notes = async (userId: string, type: string) =>
  (await db().query(`SELECT entity_type, entity_id, data FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [userId, type])).rows;

const outbox = async () => (await t.app.inject({ url: '/dev/outbox' })).json().items as { to: string; subject: string; text: string }[];

/** Emails go out in the background: wait a moment for them. */
async function mailsTo(to: string, subject: string, expected: number) {
  for (let i = 0; i < 40; i++) {
    const found = (await outbox()).filter((m) => m.to === to && m.subject === subject);
    if (found.length >= expected) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await outbox()).filter((m) => m.to === to && m.subject === subject);
}

async function login(u: TestUser, ua?: string) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: u.email, password: u.password },
    headers: ua ? { 'user-agent': ua } : {},
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string };
}

/** Pretend the last username change happened this many days ago. */
const changedDaysAgo = (u: TestUser, days: number) =>
  db().query(`UPDATE username_history SET changed_at = now() - make_interval(days => $2) WHERE user_id = $1`, [u.id, days]);

describe('changing your username', () => {
  it('checks names as you type', async () => {
    const ada = await signUp(t.app);
    const other = await signUp(t.app);
    const check = (username: string, mode = 'change', who: TestUser | null = ada) => as(t.app, who).post('/v1/auth/check-username', { username, mode });
    expect((await check('admin')).body).toMatchObject({ available: false, reason: 'reserved' });
    expect((await check('Support')).body).toMatchObject({ available: false, reason: 'reserved' });
    expect((await check('the_yapilapi_team')).body).toMatchObject({ available: false, reason: 'reserved' });
    expect((await check('no.dots')).body).toMatchObject({ available: false, reason: 'invalid' });
    expect((await check('ab')).body).toMatchObject({ available: false, reason: 'invalid' });
    expect((await check(other.username)).body).toMatchObject({ available: false, reason: 'taken' });
    expect((await check(ada.username.toUpperCase())).body).toMatchObject({ available: false, reason: 'current' });
    expect((await check(name('free'))).body).toEqual({ available: true });
    // Sign-up keeps its own rules (dots are fine there), without an account.
    expect((await check(name('with.dot').replace('_', '.'), 'signup', null)).body).toEqual({ available: true });
  });

  it('changes it, holds the old one for 14 days and sends old links to the new name', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const old = ada.username;
    const fresh = name('ada_new');

    const status = await as(t.app, ada).get('/v1/me/username');
    expect(status.body.status).toMatchObject({ username: old, changedAt: null, nextChangeAt: null });

    const r = await as(t.app, ada).put('/v1/me/username', { username: fresh });
    expect(r.status).toBe(200);
    expect(r.body.user.username).toBe(fresh);
    expect(r.body.status.nextChangeAt).toBeTruthy();
    expect(new Date(r.body.status.nextChangeAt).getTime() - Date.now()).toBeGreaterThan(13.9 * 86_400_000);

    // Old profile links still find the account, now under its new name.
    const byOld = await as(t.app, bola).get(`/v1/users/${old}`);
    expect(byOld.status).toBe(200);
    expect(byOld.body.profile.username).toBe(fresh);
    const pub = await as(t.app, null).get(`/v1/public/users/${old}`);
    expect(pub.status).toBe(200);
    expect(pub.body.profile.username).toBe(fresh);

    // Nobody else can take the old name meanwhile.
    expect((await as(t.app, bola).post('/v1/auth/check-username', { username: old, mode: 'change' })).body).toMatchObject({ available: false, reason: 'held' });
    expect((await as(t.app, bola).put('/v1/me/username', { username: old })).status).toBe(409);
    const taken = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${name('x')}@example.test`, password: 'correct-horse-battery', username: old, displayName: 'X', birthDate: '1990-01-01' },
    });
    expect(taken.statusCode).toBe(409);

    // @mentions of the old name still reach the person.
    const post = await as(t.app, bola).post('/v1/posts', { body: `Lunch with @${old} today`, visibility: 'public' });
    expect(post.status).toBe(201);
    expect((await notes(ada.id, 'post_mention')).map((n) => n.entity_id)).toContain(post.body.post.id);

    // It shows in the account's activity.
    const events = await as(t.app, ada).get('/v1/auth/security-events');
    expect(events.body.items.map((e: { type: string }) => e.type)).toContain('username_changed');
  });

  it('allows one change every 14 days', async () => {
    const ada = await signUp(t.app);
    expect((await as(t.app, ada).put('/v1/me/username', { username: name('first') })).status).toBe(200);
    const again = await as(t.app, ada).put('/v1/me/username', { username: name('second') });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('username_cooldown');
    expect(again.body.error.details.nextChangeAt).toBeTruthy();
    await changedDaysAgo(ada, 15);
    expect((await as(t.app, ada).put('/v1/me/username', { username: name('third') })).status).toBe(200);
  });

  it('keeps the rules for new names', async () => {
    const ada = await signUp(t.app);
    for (const bad of ['admin', 'api', 'Settings', 'has.dot', 'has space', 'x'])
      expect((await as(t.app, ada).put('/v1/me/username', { username: bad })).status, bad).toBe(400);
    expect((await as(t.app, ada).put('/v1/me/username', { username: ada.username })).status).toBe(400);
  });

  it('lets you take back your own old name, and frees it for others after 14 days', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const old = ada.username;
    await as(t.app, ada).put('/v1/me/username', { username: name('moved') });
    await changedDaysAgo(ada, 15);
    // Back to the old one: allowed, it was held for Ada.
    const back = await as(t.app, ada).put('/v1/me/username', { username: old });
    expect(back.status).toBe(200);
    expect(back.body.user.username).toBe(old);

    // Another account's hold ends after 14 days: the name is free and old links stop working.
    const cleo = await signUp(t.app);
    const cleoOld = cleo.username;
    await as(t.app, cleo).put('/v1/me/username', { username: name('cleo2') });
    await db().query(`UPDATE username_history SET held_until = now() - interval '1 second' WHERE user_id = $1`, [cleo.id]);
    expect((await as(t.app, bola).get(`/v1/users/${cleoOld}`)).status).toBe(404);
    expect((await as(t.app, bola).post('/v1/auth/check-username', { username: cleoOld, mode: 'change' })).body).toEqual({ available: true });
  });

  it('keeps reserved names out of sign-up', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `${name('r')}@example.test`, password: 'correct-horse-battery', username: 'Support', displayName: 'S', birthDate: '1990-01-01' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('sign-in alerts', () => {
  it('describes devices and places', () => {
    expect(deviceName(CHROME_MAC)).toBe('Chrome on macOS');
    expect(deviceName(FIREFOX_WIN)).toBe('Firefox on Windows');
    expect(deviceName(null)).toBe('Unknown device');
    expect(signInFingerprint('Chrome on macOS', 'NG')).toBe('chrome on macos|NG');
    expect(signInFingerprint('Chrome on macOS', null)).toBe('chrome on macos|');
    expect(signInFingerprint('Chrome on macOS', 'bad')).toBe('chrome on macos|');
    expect(placeName('NG')).toBe('Nigeria');
    expect(placeName(null)).toBeNull();
    const mail = signInEmail('a@example.test', 'ada', 'https://yapilapi.test,https://other.test', {
      device: 'Chrome on macOS',
      place: 'Nigeria',
      at: new Date('2026-09-27T20:00:00Z'),
    });
    expect(mail.subject).toBe('New sign-in to your account');
    expect(mail.text).toContain('Device: Chrome on macOS');
    expect(mail.text).toContain('Approximate place: Nigeria');
    // The date and time in the reader's language, said to be UTC.
    expect(mail.text).toMatch(/^When: Sunday, September 27, 2026 .*8:00\sPM UTC$/m);
    expect(mail.text).toContain("This wasn't me: https://yapilapi.test/settings/security?review=sign-in");
    expect(signInEmail('a@example.test', 'ada', 'https://y.test', { device: 'App on iOS', place: null, at: new Date() }).text).not.toContain(
      'Approximate place',
    );
  });

  it('tells you about a sign-in from a new device, once, and not about the sign-up', async () => {
    const ada = await signUp(t.app);
    expect(await notes(ada.id, 'new_sign_in')).toEqual([]);
    // Same device as the sign-up: nothing to say.
    await login(ada);
    expect(await notes(ada.id, 'new_sign_in')).toEqual([]);

    await login(ada, CHROME_MAC);
    const [n] = await notes(ada.id, 'new_sign_in');
    expect(n).toMatchObject({ entity_type: 'session', data: { device: 'Chrome on macOS', place: null } });
    const mails = await mailsTo(ada.email, 'New sign-in to your account', 1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Device: Chrome on macOS');
    expect(mails[0]!.text).toContain('/settings/security?review=sign-in');

    // The same device again is known now.
    await login(ada, CHROME_MAC);
    expect(await notes(ada.id, 'new_sign_in')).toHaveLength(1);
  });

  it('can stop the emails; the notification in the app still comes', async () => {
    const ada = await signUp(t.app);
    expect((await as(t.app, ada).get('/v1/me/sign-in-alerts')).body).toEqual({ email: true });
    expect((await as(t.app, ada).put('/v1/me/sign-in-alerts', { email: false })).body).toEqual({ email: false });
    expect((await as(t.app, ada).get('/v1/me/sign-in-alerts')).body).toEqual({ email: false });
    await login(ada, FIREFOX_WIN);
    expect(await notes(ada.id, 'new_sign_in')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));
    expect((await outbox()).filter((m) => m.to === ada.email && m.subject === 'New sign-in to your account')).toEqual([]);
  });

  it('says nothing on the first sign-in of an account from before alerts', async () => {
    const ada = await signUp(t.app);
    await db().query(`DELETE FROM known_sign_ins WHERE user_id = $1`, [ada.id]);
    await login(ada, CHROME_MAC);
    expect(await notes(ada.id, 'new_sign_in')).toEqual([]);
    await login(ada, FIREFOX_WIN);
    expect(await notes(ada.id, 'new_sign_in')).toHaveLength(1);
  });
});

describe('send later', () => {
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  /** Make a scheduled message due now and run the worker. */
  async function runDue(id: string) {
    await db().query(`UPDATE scheduled_messages SET send_at = now() - interval '1 second' WHERE id = $1`, [id]);
    await db().query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'id' = $2 AND status = 'queued'`, [
      SEND_LATER_JOB,
      id,
    ]);
    await runJobs(t.ctx.jobs, 50);
  }

  const messages = async (u: TestUser, conversationId: string) => (await as(t.app, u).get(`/v1/conversations/${conversationId}/messages`)).body.items as any[];

  it('keeps it to the sender until its time, then delivers it as a normal message', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const chat = await direct(ada, bola);
    const r = await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: 'Happy birthday', sendAt: inMinutes(90) });
    expect(r.status).toBe(201);
    expect(r.body.scheduled).toMatchObject({ body: 'Happy birthday', status: 'scheduled', conversationId: chat });

    expect((await as(t.app, ada).get(`/v1/conversations/${chat}/scheduled`)).body.items).toHaveLength(1);
    expect((await as(t.app, bola).get(`/v1/conversations/${chat}/scheduled`)).body.items).toEqual([]);
    expect(await messages(bola, chat)).toEqual([]);

    // Messages turned to disappear after it was written: the timer at delivery applies.
    expect((await as(t.app, bola).put(`/v1/conversations/${chat}/disappearing`, { seconds: 86_400 })).status).toBe(200);

    await runDue(r.body.scheduled.id);
    const seen = (await messages(bola, chat)).filter((m) => m.kind !== 'system');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ body: 'Happy birthday', sender: { id: ada.id } });
    expect(seen[0].expiresAt).toBeTruthy();
    expect((await as(t.app, ada).get(`/v1/conversations/${chat}/scheduled`)).body.items).toEqual([]);
    const row = (await db().query(`SELECT status, message_id FROM scheduled_messages WHERE id = $1`, [r.body.scheduled.id])).rows[0];
    expect(row).toMatchObject({ status: 'sent', message_id: seen[0].id });
    // Running the job again sends nothing twice.
    await runJobs(t.ctx.jobs, 50);
    expect((await messages(bola, chat)).filter((m) => m.kind !== 'system')).toHaveLength(1);
  });

  it('can be edited, sent now or cancelled', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const chat = await direct(ada, bola);
    const one = (await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: 'Draft', sendAt: inMinutes(60) })).body.scheduled;
    const later = inMinutes(24 * 60);
    const edited = await as(t.app, ada).patch(`/v1/scheduled-messages/${one.id}`, { body: 'See you at eight', sendAt: later });
    expect(edited.status).toBe(200);
    expect(edited.body.scheduled).toMatchObject({ body: 'See you at eight', sendAt: new Date(later).toISOString() });
    // Only the sender can touch it.
    expect((await as(t.app, bola).patch(`/v1/scheduled-messages/${one.id}`, { body: 'x' })).status).toBe(404);
    expect((await as(t.app, bola).post(`/v1/scheduled-messages/${one.id}/send-now`)).status).toBe(404);

    const now = await as(t.app, ada).post(`/v1/scheduled-messages/${one.id}/send-now`);
    expect(now.status).toBe(200);
    expect(now.body.message.body).toBe('See you at eight');
    expect((await messages(bola, chat)).map((m) => m.body)).toEqual(['See you at eight']);
    // The job at its old time finds it sent already.
    await runDue(one.id);
    expect(await messages(bola, chat)).toHaveLength(1);

    const two = (await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: 'Never mind', sendAt: inMinutes(30) })).body.scheduled;
    expect((await as(t.app, ada).del(`/v1/scheduled-messages/${two.id}`)).status).toBe(200);
    await runDue(two.id);
    expect(await messages(bola, chat)).toHaveLength(1);
    expect((await as(t.app, ada).post(`/v1/scheduled-messages/${two.id}/send-now`)).status).toBe(409);
  });

  it('checks the time and who can schedule', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const eve = await signUp(t.app);
    const chat = await direct(ada, bola);
    expect((await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: 'x', sendAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(
      400,
    );
    expect(
      (await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: 'x', sendAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status,
    ).toBe(400);
    expect((await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: '', sendAt: inMinutes(10) })).status).toBe(400);
    expect((await as(t.app, eve).post(`/v1/conversations/${chat}/scheduled`, { body: 'hi', sendAt: inMinutes(10) })).status).toBe(404);
  });

  it("doesn't deliver past a block, and tells the sender why", async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const chat = await direct(ada, bola);
    const s = (await as(t.app, ada).post(`/v1/conversations/${chat}/scheduled`, { body: 'Hello later', sendAt: inMinutes(15) })).body.scheduled;
    expect((await as(t.app, bola).post(`/v1/users/${ada.id}/block`)).status).toBeLessThan(300);
    await runDue(s.id);
    expect(await messages(bola, chat)).toEqual([]);
    const [failed] = (await as(t.app, ada).get(`/v1/conversations/${chat}/scheduled`)).body.items;
    expect(failed).toMatchObject({ id: s.id, status: 'failed' });
    expect(failed.failure).toBeTruthy();
    expect(await notes(ada.id, 'scheduled_message_failed')).toEqual([expect.objectContaining({ entity_type: 'conversation', entity_id: chat })]);
    // Dismissing it clears the list.
    expect((await as(t.app, ada).del(`/v1/scheduled-messages/${s.id}`)).status).toBe(200);
    expect((await as(t.app, ada).get(`/v1/conversations/${chat}/scheduled`)).body.items).toEqual([]);
  });

  it("doesn't deliver into a chat the sender left", async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const cleo = await signUp(t.app);
    await befriend(ada, bola);
    await befriend(ada, cleo);
    const g = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id, cleo.id], title: 'Crew' })).body.conversation.id;
    const s = (await as(t.app, bola).post(`/v1/conversations/${g}/scheduled`, { body: 'Late note', sendAt: inMinutes(5) })).body.scheduled;
    expect((await as(t.app, bola).post(`/v1/conversations/${g}/leave`)).status).toBe(200);
    await runDue(s.id);
    expect((await messages(ada, g)).filter((m) => m.body === 'Late note')).toEqual([]);
    const row = (await db().query(`SELECT status, failure FROM scheduled_messages WHERE id = $1`, [s.id])).rows[0];
    expect(row).toMatchObject({ status: 'failed', failure: 'You’re no longer in this chat.' });
  });
});

describe('chat wallpapers and colours', () => {
  it('sets one look for everyone, with a line saying who changed it', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const cleo = await signUp(t.app);
    await befriend(ada, bola);
    await befriend(ada, cleo);
    const g = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id, cleo.id], title: 'Crew' })).body.conversation.id;
    expect((await as(t.app, bola).get(`/v1/conversations/${g}`)).body.conversation.theme).toEqual({ wallpaper: 'plain', accent: 'yapi' });

    // Any member of a group can change it, not only admins.
    const r = await as(t.app, bola).put(`/v1/conversations/${g}/theme`, { wallpaper: 'dusk', accent: 'ocean' });
    expect(r.status).toBe(200);
    expect(r.body.theme).toEqual({ wallpaper: 'dusk', accent: 'ocean' });
    expect(r.body.message).toMatchObject({ kind: 'system', system: { type: 'theme', wallpaper: 'dusk', accent: 'ocean' }, sender: { id: bola.id } });
    expect((await as(t.app, cleo).get(`/v1/conversations/${g}`)).body.conversation.theme).toEqual({ wallpaper: 'dusk', accent: 'ocean' });
    const lines = (await as(t.app, cleo).get(`/v1/conversations/${g}/messages`)).body.items.filter((m: any) => m.kind === 'system');
    expect(lines).toHaveLength(1);

    // Just the colour; the wallpaper stays.
    expect((await as(t.app, ada).put(`/v1/conversations/${g}/theme`, { accent: 'forest' })).body.theme).toEqual({ wallpaper: 'dusk', accent: 'forest' });
    // No change, no line.
    expect((await as(t.app, ada).put(`/v1/conversations/${g}/theme`, { accent: 'forest' })).body.message).toBeNull();

    // Trying a few looks in a row leaves one line: Ada's newest line is replaced, Bola's stays.
    await as(t.app, ada).put(`/v1/conversations/${g}/theme`, { wallpaper: 'stripes' });
    const last = (await as(t.app, ada).put(`/v1/conversations/${g}/theme`, { accent: 'ocean' })).body.message;
    const after = (await as(t.app, cleo).get(`/v1/conversations/${g}/messages`)).body.items.filter((m: any) => m.kind === 'system');
    expect(after.map((m: any) => [m.sender.id, m.system.wallpaper, m.system.accent])).toEqual([
      [bola.id, 'dusk', 'ocean'],
      [ada.id, 'stripes', 'ocean'],
    ]);
    expect(after[1].id).toBe(last.id);

    // Once someone writes in between, the next change gets its own line.
    await as(t.app, cleo).post(`/v1/conversations/${g}/messages`, { body: 'Nice' });
    await as(t.app, ada).put(`/v1/conversations/${g}/theme`, { wallpaper: 'dots' });
    expect((await as(t.app, cleo).get(`/v1/conversations/${g}/messages`)).body.items.filter((m: any) => m.kind === 'system')).toHaveLength(3);
  });

  it('only takes known names, from people in the chat', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const eve = await signUp(t.app);
    const chat = await direct(ada, bola);
    expect((await as(t.app, ada).put(`/v1/conversations/${chat}/theme`, { wallpaper: 'neon' })).status).toBe(400);
    expect((await as(t.app, ada).put(`/v1/conversations/${chat}/theme`, {})).status).toBe(400);
    expect((await as(t.app, eve).put(`/v1/conversations/${chat}/theme`, { wallpaper: 'dots' })).status).toBe(404);
  });
});
