import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { inQuietHours } from '../src/lib/interactions.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const notes = async (userId: string, type: string) =>
  (await t.ctx.db.query(`SELECT actor_id FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows;

describe('account and sign-in', () => {
  it('shows your own account details, date of birth included', async () => {
    const ada = await signUp(t.app, { birthDate: '1994-05-17' });
    const r = await as(t.app, ada).get('/v1/me/account');
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({ email: ada.email, emailVerified: false, phone: null, birthDate: '1994-05-17' });
    expect((await as(t.app, null).get('/v1/me/account')).status).toBe(401);
  });

  it('keeps you signed in by default, and only for the browser session when you ask', async () => {
    const ada = await adult();
    const login = (remember?: boolean) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: ada.email, password: ada.password, ...(remember === undefined ? {} : { remember }) },
      });
    const kept = await login();
    expect(kept.statusCode).toBe(200);
    expect(String(kept.headers['set-cookie'])).toMatch(/Max-Age=\d+/);
    const short = await login(false);
    expect(short.statusCode).toBe(200);
    expect(String(short.headers['set-cookie'])).not.toMatch(/Max-Age/);
    const { rows } = await t.ctx.db.query(`SELECT expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [ada.id]);
    expect(new Date(rows[0].expires_at).getTime() - Date.now()).toBeLessThanOrEqual(86400_000);
  });

  it('logs out of every device at once', async () => {
    const ada = await adult();
    const other = (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: ada.email, password: ada.password } })).json().token;
    const r = await as(t.app, ada).post('/v1/auth/logout-all');
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBeGreaterThanOrEqual(2);
    expect((await as(t.app, ada).get('/v1/auth/me')).status).toBe(401);
    expect((await as(t.app, { ...ada, token: other }).get('/v1/auth/me')).status).toBe(401);
  });

  it('changes the password and signs other devices out', async () => {
    const ada = await adult();
    const other = (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: ada.email, password: ada.password } })).json().token;
    expect((await as(t.app, ada).post('/v1/auth/password/change', { currentPassword: 'wrong-password', newPassword: 'a-new-long-password' })).status).toBe(400);
    expect((await as(t.app, ada).post('/v1/auth/password/change', { currentPassword: ada.password, newPassword: 'a-new-long-password' })).status).toBe(200);
    expect((await as(t.app, ada).get('/v1/auth/me')).status).toBe(200);
    expect((await as(t.app, { ...ada, token: other }).get('/v1/auth/me')).status).toBe(401);
  });
});

describe('report a problem', () => {
  it('keeps what went wrong for the team, and the reporter can find it in their data', async () => {
    const ada = await adult();
    expect((await as(t.app, ada).post('/v1/me/problems', { body: 'ok', platform: 'web' })).status).toBe(400);
    const r = await as(t.app, ada).post('/v1/me/problems', { body: 'The camera button does nothing', platform: 'ios', appVersion: '1.2.0' });
    expect(r.status).toBe(201);
    const exported = (await as(t.app, ada).get('/v1/me/export')).body;
    expect(exported.problemReports).toMatchObject([{ body: 'The camera button does nothing', platform: 'ios' }]);
    expect((await as(t.app, ada).get('/v1/admin/problems')).status).toBe(403);
  });
});

describe('muted and restricted people', () => {
  it('lists them so they can be undone from Settings', async () => {
    const ada = await adult();
    const bola = await adult();
    const cy = await adult();
    await as(t.app, ada).post(`/v1/users/${bola.id}/mute`);
    await as(t.app, ada).post(`/v1/users/${cy.id}/restrict`);
    expect((await as(t.app, ada).get('/v1/me/muted')).body.items.map((u: { id: string }) => u.id)).toEqual([bola.id]);
    expect((await as(t.app, ada).get('/v1/me/restricted')).body.items.map((u: { id: string }) => u.id)).toEqual([cy.id]);
    await as(t.app, ada).del(`/v1/users/${bola.id}/mute`);
    expect((await as(t.app, ada).get('/v1/me/muted')).body.items).toEqual([]);
  });
});

describe('who can reach you', () => {
  let ada: TestUser;
  let bola: TestUser;
  beforeAll(async () => {
    ada = await adult();
    bola = await adult();
  });

  it('starts open to everyone', async () => {
    const r = await as(t.app, ada).get('/v1/me/interactions');
    expect(r.body.settings).toEqual({
      messagesFrom: 'everyone',
      commentsFrom: 'everyone',
      mentionsFrom: 'everyone',
      quietHours: null,
      sensitiveMedia: 'standard',
      sensitiveLocked: false,
    });
  });

  it('limits who can message you, but a chat you started can always be answered', async () => {
    expect((await as(t.app, ada).put('/v1/me/interactions', { messagesFrom: 'friends' })).body.settings.messagesFrom).toBe('friends');
    const denied = await as(t.app, bola).post('/v1/conversations', { memberIds: [ada.id] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('messages_limited');
    // Ada writes first: Bola can answer.
    const conv = (await as(t.app, ada).post('/v1/conversations', { memberIds: [bola.id] })).body.conversation.id;
    expect((await as(t.app, ada).post(`/v1/conversations/${conv}/messages`, { body: 'Hi Bola' })).status).toBe(201);
    expect((await as(t.app, bola).post(`/v1/conversations/${conv}/messages`, { body: 'Hi Ada' })).status).toBe(201);
    await as(t.app, ada).put('/v1/me/interactions', { messagesFrom: 'everyone' });
  });

  it('limits who can comment on your posts', async () => {
    await as(t.app, ada).put('/v1/me/interactions', { commentsFrom: 'following' });
    const post = (await as(t.app, ada).post('/v1/posts', { body: 'Sunday lunch' })).body.post;
    expect(post.viewer?.canComment ?? true).toBe(true);
    const seen = (await as(t.app, bola).get(`/v1/posts/${post.id}`)).body.post;
    expect(seen.viewer.canComment).toBe(false);
    expect((await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { body: 'Looks good' })).status).toBe(403);
    await as(t.app, ada).post(`/v1/users/${bola.id}/follow`);
    expect((await as(t.app, bola).post(`/v1/posts/${post.id}/comments`, { body: 'Looks good' })).status).toBe(201);
    await as(t.app, ada).put('/v1/me/interactions', { commentsFrom: 'everyone' });
  });

  it('stops mentions from people you chose not to hear from', async () => {
    const cy = await adult();
    await as(t.app, cy).put('/v1/me/interactions', { mentionsFrom: 'nobody' });
    await as(t.app, ada).post('/v1/posts', { body: `Lunch with @${cy.username}` });
    expect(await notes(cy.id, 'post_mention')).toHaveLength(0);
    await as(t.app, cy).put('/v1/me/interactions', { mentionsFrom: 'everyone' });
    await as(t.app, ada).post('/v1/posts', { body: `Dinner with @${cy.username}` });
    expect(await notes(cy.id, 'post_mention')).toHaveLength(1);
  });

  it('keeps quiet hours and checks them', async () => {
    const now = new Date();
    const hh = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
    const r = await as(t.app, ada).put('/v1/me/interactions', {
      quietHours: { start: hh(now.getUTCHours() - 1), end: hh(now.getUTCHours() + 1), timezone: 'UTC' },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.quietHours).toMatchObject({ timezone: 'UTC' });
    expect(await inQuietHours(t.ctx.db, ada.id)).toBe(true);
    expect((await as(t.app, ada).put('/v1/me/interactions', { quietHours: { start: '22:00', end: '22:00', timezone: 'UTC' } })).status).toBe(400);
    expect((await as(t.app, ada).put('/v1/me/interactions', { quietHours: null })).body.settings.quietHours).toBeNull();
    expect(await inQuietHours(t.ctx.db, ada.id)).toBe(false);
  });

  it('keeps sensitive media hidden under 18', async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-01-01` });
    const r = await as(t.app, teen).get('/v1/me/interactions');
    expect(r.body.settings).toMatchObject({ sensitiveMedia: 'less', sensitiveLocked: true });
    expect((await as(t.app, teen).put('/v1/me/interactions', { sensitiveMedia: 'standard' })).status).toBe(403);
    expect((await as(t.app, ada).put('/v1/me/interactions', { sensitiveMedia: 'less' })).body.settings.sensitiveMedia).toBe('less');
  });
});
