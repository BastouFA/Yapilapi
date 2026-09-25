import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import { notify } from '../src/lib/notify.js';
import { MemoryPushSender } from '../src/lib/push.js';
import {
  shouldDeliver,
  sendEmailDigests,
  purgeOldNotifications,
} from '../src/modules/notifications/index.js';

let t: TestApp;
let push: MemoryPushSender;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  push = new MemoryPushSender();
  t.ctx.push = push;
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
const teenUser = () => signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
const settle = () => new Promise((r) => setTimeout(r, 120)); // push dispatch is fire-and-forget
const EXPO = (s = uniq('t')) => `ExponentPushToken[${s}]`;
const registerToken = async (u: TestUser, token = EXPO()) => {
  const r = await u.client.post('/v1/notifications/push-tokens', { token, platform: 'ios' });
  expect(r.status).toBeLessThan(300);
  return token;
};
const give = (u: TestUser, kind: string, extra: Record<string, unknown> = {}) =>
  notify(t.ctx, { userId: u.id, kind, ...extra } as any);
const list = async (u: TestUser, query: Record<string, string> = {}) =>
  (await u.client.get('/v1/notifications', query)).body;
/** A window of `spanMin` minutes around the current UTC minute. */
const windowAroundNow = (spanMin = 30) => {
  const now = new Date();
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return { start: (m - spanMin + 1440) % 1440, end: (m + spanMin) % 1440 };
};

describe('notification inbox', () => {
  it('requires authentication on every route', async () => {
    const anon = new Client(t);
    for (const [m, url] of [
      ['get', '/v1/notifications'],
      ['get', '/v1/notifications/unread-count'],
      ['post', '/v1/notifications/read-all'],
      ['get', '/v1/notifications/preferences'],
      ['put', '/v1/notifications/settings'],
      ['post', '/v1/notifications/push-tokens'],
      ['get', '/v1/notifications/push-tokens'],
    ] as const) {
      expect((await (anon as any)[m](url, {})).status, `${m} ${url}`).toBe(401);
    }
  });

  it('lists newest first with keyset pagination that never repeats or skips', async () => {
    const u = await signup(t);
    for (let i = 0; i < 25; i++) await give(u, 'message', { data: { n: i } });
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(u, { limit: '10', ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((n: any) => n.data.n));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 24 - i));
    expect((await u.client.get('/v1/notifications', { cursor: '!!!' })).status).toBe(400);
    expect((await u.client.get('/v1/notifications', { limit: '500' })).status).toBe(400);
  });

  it("only ever shows the caller's own notifications", async () => {
    const a = await signup(t);
    const b = await signup(t);
    await give(a, 'message', { data: { secret: 'for-a-only' } });
    await give(b, 'message', { data: { secret: 'for-b-only' } });
    expect(JSON.stringify(await list(a))).not.toContain('for-b-only');
    expect(JSON.stringify(await list(b))).not.toContain('for-a-only');
  });

  it('filters by category (exact kinds beat prefixes, unknown kinds are "system") and by unread', async () => {
    const u = await signup(t);
    await give(u, 'follow');
    await give(u, 'community_banned'); // exact: moderation, even though community_ is a communities prefix
    await give(u, 'community_new_thing'); // prefix: communities
    await give(u, 'event_reminder');
    await give(u, 'something_brand_new'); // unknown: system
    await give(u, 'message');
    const kinds = async (q: Record<string, string>) =>
      (await list(u, q)).items.map((n: any) => n.kind).sort();
    expect(await kinds({ category: 'friends' })).toEqual(['follow']);
    expect(await kinds({ category: 'moderation' })).toEqual(['community_banned']);
    expect(await kinds({ category: 'communities' })).toEqual(['community_new_thing']);
    expect(await kinds({ category: 'events' })).toEqual(['event_reminder']);
    expect(await kinds({ category: 'system' })).toEqual(['something_brand_new']);
    expect(await kinds({ category: 'messages' })).toEqual(['message']);
    expect(await kinds({ category: 'commerce' })).toEqual([]);
    expect((await u.client.get('/v1/notifications', { category: 'nonsense' })).status).toBe(400);
    const all = (await list(u)).items;
    expect(all.find((n: any) => n.kind === 'community_banned').category).toBe('moderation');
    await u.client.post(`/v1/notifications/${all[0].id}/read`);
    expect((await list(u, { unread: 'true' })).items).toHaveLength(5);
    expect((await list(u, { unread: 'false' })).items).toHaveLength(6);
  });

  it('counts unread per category, marks one or many as read, and deletes', async () => {
    const u = await signup(t);
    const other = await signup(t);
    await give(u, 'follow');
    await give(u, 'friend_request');
    await give(u, 'message');
    await give(u, 'event_reminder');
    await give(other, 'message');
    expect((await u.client.get('/v1/notifications/unread-count')).body).toMatchObject({
      total: 4,
      byCategory: { friends: 2, messages: 1, events: 1, commerce: 0 },
    });

    const items = (await list(u)).items;
    const otherItem = (await list(other)).items[0];
    expect((await other.client.post(`/v1/notifications/${items[0].id}/read`)).status).toBe(404); // not theirs
    expect((await other.client.del(`/v1/notifications/${items[0].id}`)).status).toBe(404);
    expect((await u.client.post(`/v1/notifications/${otherItem.id}/read`)).status).toBe(404);
    expect(
      (await u.client.post('/v1/notifications/00000000-0000-4000-8000-000000000000/read')).status,
    ).toBe(404);
    expect((await u.client.post('/v1/notifications/not-a-uuid/read')).status).toBe(400);

    expect((await u.client.post(`/v1/notifications/${items[0].id}/read`)).status).toBe(204);
    expect((await u.client.post(`/v1/notifications/${items[0].id}/read`)).status).toBe(204); // idempotent
    expect((await u.client.get('/v1/notifications/unread-count')).body.total).toBe(3);

    expect(
      (await u.client.post('/v1/notifications/read-all', { category: 'friends' })).body.updated,
    ).toBe(2);
    expect((await u.client.get('/v1/notifications/unread-count')).body.total).toBe(1);
    expect((await u.client.post('/v1/notifications/read-all', {})).body.updated).toBe(1);
    expect((await u.client.get('/v1/notifications/unread-count')).body.total).toBe(0);
    // the other user's unread state was never touched
    expect((await other.client.get('/v1/notifications/unread-count')).body.total).toBe(1);

    expect((await u.client.del(`/v1/notifications/${items[0].id}`)).status).toBe(204);
    expect((await u.client.del(`/v1/notifications/${items[0].id}`)).status).toBe(404);
    expect((await list(u)).items).toHaveLength(3);
  });

  it('shows the actor, and hides them once either side blocks the other', async () => {
    const u = await signup(t);
    const actor = await signup(t, { displayName: 'Friendly Actor' });
    await give(u, 'follow', { actorId: actor.id });
    expect((await list(u)).items[0].actor).toMatchObject({
      id: actor.id,
      username: actor.username,
      displayName: 'Friendly Actor',
    });
    await sql('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)', [u.id, actor.id]);
    expect((await list(u)).items[0].actor).toBeNull();
  });

  it('does not notify people about their own actions or about users they blocked', async () => {
    const u = await signup(t);
    const blocked = await signup(t);
    await give(u, 'follow', { actorId: u.id });
    await sql('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)', [
      u.id,
      blocked.id,
    ]);
    await give(u, 'follow', { actorId: blocked.id });
    expect((await list(u)).items).toHaveLength(0);
  });

  it('retention purge removes only old notifications', async () => {
    const u = await signup(t);
    await give(u, 'message');
    await give(u, 'message');
    await sql(
      `UPDATE notifications SET created_at = now() - interval '100 days' WHERE id = (SELECT id FROM notifications WHERE user_id = $1 LIMIT 1)`,
      [u.id],
    );
    expect(await purgeOldNotifications(t.ctx, 90)).toBeGreaterThanOrEqual(1);
    expect((await list(u)).items).toHaveLength(1);
  });
});

describe('notification preferences', () => {
  it('shows defaults, including that security and safety in-app cannot be turned off', async () => {
    const u = await signup(t);
    const p = (await u.client.get('/v1/notifications/preferences')).body;
    const cat = (name: string) => p.categories.find((c: any) => c.category === name);
    expect(cat('friends').channels).toMatchObject({
      in_app: { enabled: true, custom: false },
      push: { enabled: true },
      email: { enabled: false },
    });
    expect(cat('creators').channels.push.enabled).toBe(false);
    expect(cat('security')).toMatchObject({ inAppLocked: true });
    expect(cat('moderation')).toMatchObject({ inAppLocked: true });
    expect(cat('friends').inAppLocked).toBe(false);
    expect(p.settings).toMatchObject({ focusMode: false, pausedUntil: null, quietHours: null });
  });

  it('rejects turning off in-app security/safety notices, unknown keys and bad channels', async () => {
    const u = await signup(t);
    const put = (items: unknown[]) => u.client.put('/v1/notifications/preferences', { items });
    expect((await put([{ key: 'security', channel: 'in_app', enabled: false }])).status).toBe(400);
    expect((await put([{ key: 'moderation', channel: 'in_app', enabled: false }])).status).toBe(
      400,
    );
    expect(
      (await put([{ key: 'account_suspended', channel: 'in_app', enabled: false }])).status,
    ).toBe(400); // a kind inside an undisableable category
    expect(
      (await put([{ key: 'login_new_device', channel: 'in_app', enabled: false }])).status,
    ).toBe(400);
    expect((await put([{ key: 'not_a_thing', channel: 'push', enabled: false }])).status).toBe(400);
    expect(
      (await put([{ key: 'friends', channel: 'carrier_pigeon', enabled: false }])).status,
    ).toBe(400);
    expect((await put([])).status).toBe(400);
    // but push/email for those categories can be changed, and other categories can go fully quiet
    expect(
      (
        await put([
          { key: 'security', channel: 'push', enabled: false },
          { key: 'friends', channel: 'in_app', enabled: false },
        ])
      ).status,
    ).toBe(200);
  });

  it('turning a category off in-app stops the notification from being created; security still arrives', async () => {
    const u = await signup(t);
    await u.client.put('/v1/notifications/preferences', {
      items: [{ key: 'creators', channel: 'in_app', enabled: false }],
    });
    await give(u, 'reaction');
    await give(u, 'comment');
    expect((await list(u)).items).toHaveLength(0);
    await give(u, 'security_alert');
    await give(u, 'account_suspended');
    expect((await list(u)).items.map((n: any) => n.kind).sort()).toEqual([
      'account_suspended',
      'security_alert',
    ]);
    const state = (await u.client.get('/v1/notifications/preferences')).body;
    expect(
      state.categories.find((c: any) => c.category === 'creators').channels.in_app,
    ).toMatchObject({ enabled: false, custom: true, default: true });
  });

  it('a kind-level preference overrides its category, and reset restores the default', async () => {
    const u = await signup(t);
    await u.client.put('/v1/notifications/preferences', {
      items: [
        { key: 'friends', channel: 'in_app', enabled: false },
        { key: 'friend_request', channel: 'in_app', enabled: true },
      ],
    });
    await give(u, 'follow');
    await give(u, 'friend_request');
    expect((await list(u)).items.map((n: any) => n.kind)).toEqual(['friend_request']);
    const prefs = (await u.client.get('/v1/notifications/preferences')).body;
    expect(prefs.overrides).toEqual([
      { kind: 'friend_request', category: 'friends', channel: 'in_app', enabled: true },
    ]);
    expect((await u.client.del('/v1/notifications/preferences/friends')).status).toBe(204);
    await give(u, 'follow');
    expect((await list(u)).items).toHaveLength(2);
    expect((await u.client.del('/v1/notifications/preferences/bogus_key')).status).toBe(404);
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = $1 AND kind = $2',
          [u.id, 'friends'],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('preferences are per user', async () => {
    const a = await signup(t);
    const b = await signup(t);
    await a.client.put('/v1/notifications/preferences', {
      items: [{ key: 'messages', channel: 'in_app', enabled: false }],
    });
    await give(a, 'message');
    await give(b, 'message');
    expect((await list(a)).items).toHaveLength(0);
    expect((await list(b)).items).toHaveLength(1);
  });

  it('teens cannot enable non-essential email', async () => {
    const teen = await teenUser();
    expect(
      (
        await teen.client.put('/v1/notifications/preferences', {
          items: [{ key: 'friends', channel: 'email', enabled: true }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await teen.client.put('/v1/notifications/preferences', {
          items: [{ key: 'security', channel: 'email', enabled: true }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await teen.client.put('/v1/notifications/preferences', {
          items: [{ key: 'friends', channel: 'push', enabled: false }],
        })
      ).status,
    ).toBe(200);
  });
});

describe('quiet hours, focus and pause', () => {
  it('validates settings', async () => {
    const u = await signup(t);
    expect(
      (await u.client.put('/v1/notifications/settings', { quietHours: { start: 600, end: 600 } }))
        .status,
    ).toBe(400);
    expect(
      (await u.client.put('/v1/notifications/settings', { quietHours: { start: -1, end: 20 } }))
        .status,
    ).toBe(400);
    expect(
      (await u.client.put('/v1/notifications/settings', { quietHours: { start: 10, end: 1440 } }))
        .status,
    ).toBe(400);
    expect(
      (await u.client.put('/v1/notifications/settings', { timezone: 'Mars/Olympus' })).status,
    ).toBe(400);
    expect((await u.client.put('/v1/notifications/settings', { pauseForMinutes: 0 })).status).toBe(
      400,
    );
    expect(
      (await u.client.put('/v1/notifications/settings', { pauseForMinutes: 999_999 })).status,
    ).toBe(400);
    const ok = await u.client.put('/v1/notifications/settings', {
      quietHours: { start: 22 * 60, end: 7 * 60 },
      focusMode: true,
      timezone: 'Europe/Paris',
    });
    expect(ok.body).toMatchObject({
      quietHours: { start: 1320, end: 420, isDefault: false },
      focusMode: true,
      timezone: 'Europe/Paris',
    });
    expect(
      (await u.client.put('/v1/notifications/settings', { quietHours: null })).body.quietHours,
    ).toBeNull();
  });

  it('quiet hours keep the in-app row but suppress push; outside the window push flows', async () => {
    const u = await signup(t);
    await registerToken(u);
    await u.client.put('/v1/notifications/settings', { quietHours: windowAroundNow() });
    await give(u, 'message');
    await settle();
    expect((await list(u)).items).toHaveLength(1);
    expect(push.sent).toHaveLength(0);
    expect((await shouldDeliver(t.ctx, u.id, 'message')).suppressedBy).toBe('quiet_hours');
    // same instant, but a window that is not "now"
    const w = windowAroundNow(10);
    await u.client.put('/v1/notifications/settings', {
      quietHours: { start: (w.start + 300) % 1440, end: (w.start + 360) % 1440 },
    });
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(1);
  });

  it('pause suppresses push until it expires or is cleared; security notices still get through', async () => {
    const u = await signup(t);
    await registerToken(u);
    const s = await u.client.put('/v1/notifications/settings', { pauseForMinutes: 60 });
    expect(new Date(s.body.pausedUntil).getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(0);
    await give(u, 'security_alert');
    await settle();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.data.category).toBe('security');
    expect(
      (await u.client.put('/v1/notifications/settings', { pauseForMinutes: null })).body
        .pausedUntil,
    ).toBeNull();
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(2);
    // an expired pause has no effect
    await sql(
      `UPDATE user_preferences SET notifications_paused_until = now() - interval '1 minute' WHERE user_id = $1`,
      [u.id],
    );
    expect((await shouldDeliver(t.ctx, u.id, 'message')).suppressedBy).toBeNull();
    expect(
      (await u.client.get('/v1/notifications/preferences')).body.settings.pausedUntil,
    ).toBeNull();
  });

  it('focus mode suppresses push but never the inbox', async () => {
    const u = await signup(t);
    await registerToken(u);
    await u.client.put('/v1/notifications/settings', { focusMode: true });
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(0);
    expect((await list(u)).items).toHaveLength(1);
    await u.client.put('/v1/notifications/settings', { focusMode: false });
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(1);
  });

  it('teens have default quiet hours they can move but not switch off', async () => {
    const teen = await teenUser();
    const s = (await teen.client.get('/v1/notifications/preferences')).body.settings;
    expect(s.quietHours).toMatchObject({ start: 1320, end: 420, isDefault: true });
    expect(
      (
        await teen.client.put('/v1/notifications/settings', {
          quietHours: { start: 600, end: 600 },
        })
      ).status,
    ).toBe(403);
    expect(
      (await teen.client.put('/v1/notifications/settings', { quietHours: null })).body.quietHours,
    ).toMatchObject({ isDefault: true });
    const night = new Date('2026-03-10T23:30:00Z');
    expect((await shouldDeliver(t.ctx, teen.id, 'message', night)).suppressedBy).toBe(
      'quiet_hours',
    );
    const adult = await signup(t);
    expect((await shouldDeliver(t.ctx, adult.id, 'message', night)).suppressedBy).toBeNull();
    expect((await shouldDeliver(t.ctx, teen.id, 'security_alert', night)).push).toBe(true);
    // shouldDeliver honours the user's timezone
    await teen.client.put('/v1/notifications/settings', { timezone: 'Asia/Tokyo' }); // 23:30Z is 08:30 in Tokyo: outside 22:00-07:00
    expect((await shouldDeliver(t.ctx, teen.id, 'message', night)).suppressedBy).toBeNull();
  });
});

describe('push tokens and dispatch', () => {
  it('registers idempotently, validates Expo tokens, masks tokens and unregisters', async () => {
    const u = await signup(t);
    const token = EXPO('abc123');
    const first = await u.client.post('/v1/notifications/push-tokens', { token, platform: 'ios' });
    expect(first.status).toBe(201);
    const again = await u.client.post('/v1/notifications/push-tokens', { token, platform: 'ios' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(
      (
        await u.client.post('/v1/notifications/push-tokens', {
          token: 'not-an-expo-token-at-all',
          platform: 'ios',
        })
      ).status,
    ).toBe(400);
    expect(
      (await u.client.post('/v1/notifications/push-tokens', { token, platform: 'toaster' })).status,
    ).toBe(400);
    expect(
      (
        await u.client.post('/v1/notifications/push-tokens', {
          token: EXPO(),
          platform: 'ios',
          deviceId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    const l = (await u.client.get('/v1/notifications/push-tokens')).body.items;
    expect(l).toHaveLength(1);
    expect(JSON.stringify(l)).not.toContain('abc123');
    expect(l[0]).toMatchObject({ platform: 'ios', provider: 'expo', active: true });
    expect((await u.client.del('/v1/notifications/push-tokens', { token })).status).toBe(204);
    expect((await u.client.del('/v1/notifications/push-tokens', { token })).status).toBe(204); // idempotent
    expect((await u.client.get('/v1/notifications/push-tokens')).body.items).toHaveLength(0);
  });

  it('a token that moves to another account leaves the previous owner', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const token = await registerToken(a);
    await registerToken(b, token);
    expect((await a.client.get('/v1/notifications/push-tokens')).body.items).toHaveLength(0);
    expect((await b.client.get('/v1/notifications/push-tokens')).body.items).toHaveLength(1);
    await give(a, 'message');
    await give(b, 'message');
    await settle();
    expect(push.sent).toHaveLength(1);
    // one user cannot remove another user's device
    const id = (await b.client.get('/v1/notifications/push-tokens')).body.items[0].id;
    expect((await a.client.del(`/v1/notifications/push-tokens/${id}`)).status).toBe(404);
    expect((await b.client.del(`/v1/notifications/push-tokens/${id}`)).status).toBe(204);
  });

  it('keeps at most 10 tokens per user', async () => {
    const u = await signup(t);
    for (let i = 0; i < 12; i++) await registerToken(u, EXPO(`cap${i}-${uniq('x')}`));
    expect((await u.client.get('/v1/notifications/push-tokens')).body.items).toHaveLength(10);
  });

  it('pushes are content-free and identify the notification by id only', async () => {
    const u = await signup(t);
    const actor = await signup(t, { displayName: 'Very Private Name' });
    await registerToken(u);
    await give(u, 'message', {
      actorId: actor.id,
      targetType: 'conversation',
      targetId: crypto.randomUUID(),
      data: { preview: 'my secret message text' },
    });
    await settle();
    expect(push.sent).toHaveLength(1);
    const m = push.sent[0]!;
    const blob = JSON.stringify(m);
    expect(blob).not.toContain('secret message');
    expect(blob).not.toContain('Very Private Name');
    expect(blob).not.toContain(actor.username);
    expect(m).toMatchObject({
      title: 'New message',
      data: { category: 'messages', kind: 'message', targetType: 'conversation' },
    });
    const stored = (await sql('SELECT id, pushed_at FROM notifications WHERE user_id = $1', [u.id]))
      .rows[0];
    expect(m.data.notificationId).toBe(stored.id);
    expect(stored.pushed_at).not.toBeNull();
  });

  it('respects channel preferences: push off means no push but the inbox row remains', async () => {
    const u = await signup(t);
    await registerToken(u);
    await u.client.put('/v1/notifications/preferences', {
      items: [{ key: 'messages', channel: 'push', enabled: false }],
    });
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(0);
    expect((await list(u)).items).toHaveLength(1);
    expect(
      (await sql('SELECT pushed_at FROM notifications WHERE user_id = $1', [u.id])).rows[0]
        .pushed_at,
    ).toBeNull();
  });

  it('disables tokens the provider reports as dead, and stops sending to them', async () => {
    const u = await signup(t);
    const dead = await registerToken(u);
    push.invalid.add(dead);
    await give(u, 'message');
    await settle();
    expect((await u.client.get('/v1/notifications/push-tokens')).body.items[0].active).toBe(false);
    await give(u, 'message');
    await settle();
    expect(push.sent).toHaveLength(0);
  });

  it('a failing push adapter never breaks notification creation', async () => {
    const u = await signup(t);
    await registerToken(u);
    t.ctx.push = {
      send: async () => {
        throw new Error('provider down');
      },
    };
    await give(u, 'message');
    await settle();
    expect((await list(u)).items).toHaveLength(1);
  });
});

describe('email digests', () => {
  const verified = async (u: TestUser) =>
    sql('UPDATE users SET email_verified_at = now() WHERE id = $1', [u.id]);
  const optIn = (u: TestUser, key = 'friends') =>
    u.client.put('/v1/notifications/preferences', {
      items: [{ key, channel: 'email', enabled: true }],
    });

  it('emails a content-free digest only for categories the user opted in to, once, and marks items as emailed', async () => {
    const u = await signup(t, { displayName: 'Hidden Name' });
    const other = await signup(t, { displayName: 'Actor Person' });
    await verified(u);
    await optIn(u, 'friends');
    await give(u, 'follow', { actorId: other.id, data: { text: 'private text' } });
    await give(u, 'friend_request', { actorId: other.id });
    await give(u, 'message'); // email not enabled for messages
    t.email.sent.length = 0;
    const res = await sendEmailDigests(t.ctx);
    expect(res.sent).toBeGreaterThanOrEqual(1);
    const mail = t.email.last(u.email)!;
    expect(mail.subject).toContain('2 unread notifications');
    expect(mail.text).toContain('Friends and follows: 2');
    expect(mail.text).not.toContain('Messages');
    for (const secret of ['Hidden Name', 'Actor Person', 'private text', other.username])
      expect(mail.text + mail.subject).not.toContain(secret);
    expect(mail.text).toContain('/settings/notifications');
    const flags = (
      await sql('SELECT kind, emailed_at FROM notifications WHERE user_id = $1 ORDER BY kind', [
        u.id,
      ])
    ).rows;
    expect(
      flags
        .filter((f) => f.emailed_at)
        .map((f) => f.kind)
        .sort(),
    ).toEqual(['follow', 'friend_request']);
    // a second run has nothing to do (already emailed, and the per-user interval)
    t.email.sent.length = 0;
    await give(u, 'follow', { actorId: other.id });
    await sendEmailDigests(t.ctx);
    expect(t.email.last(u.email)).toBeUndefined();
    expect(
      (await sql('SELECT count(*)::int AS n FROM email_digest_log WHERE user_id = $1', [u.id]))
        .rows[0].n,
    ).toBe(1);
    // after the interval, the new item goes out
    await sendEmailDigests(t.ctx, { now: new Date(Date.now() + 21 * 3_600_000) });
    expect(t.email.last(u.email)?.subject).toContain('1 unread notification');
  });

  it('includes security and safety notices by default, but skips read items and unverified addresses', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    for (const u of [a, b, c]) await give(u, 'security_alert');
    await verified(a);
    await verified(b);
    // b reads it before the digest runs; c never verified their email
    await b.client.post('/v1/notifications/read-all', {});
    t.email.sent.length = 0;
    await sendEmailDigests(t.ctx);
    expect(t.email.last(a.email)).toBeDefined();
    expect(t.email.last(a.email)!.text).toContain('Security and privacy: 1');
    expect(t.email.last(b.email)).toBeUndefined();
    expect(t.email.last(c.email)).toBeUndefined();
    expect(
      (await sql('SELECT emailed_at FROM notifications WHERE user_id = $1', [c.id])).rows[0]
        .emailed_at,
    ).toBeNull();
  });

  it('honours quiet hours and pause for non-urgent mail (items stay queued), but not for security', async () => {
    const u = await signup(t);
    await verified(u);
    await optIn(u, 'friends');
    await u.client.put('/v1/notifications/settings', { pauseForMinutes: 120 });
    await give(u, 'follow');
    t.email.sent.length = 0;
    await sendEmailDigests(t.ctx);
    expect(t.email.last(u.email)).toBeUndefined();
    expect(
      (await sql('SELECT emailed_at FROM notifications WHERE user_id = $1', [u.id])).rows[0]
        .emailed_at,
    ).toBeNull();
    await give(u, 'security_alert');
    await sendEmailDigests(t.ctx);
    expect(t.email.last(u.email)!.text).toContain('Security and privacy: 1');
    expect(t.email.last(u.email)!.text).not.toContain('Friends');
    // pause over: the queued friend item goes out in the next digest
    await u.client.put('/v1/notifications/settings', { pauseForMinutes: null });
    await sendEmailDigests(t.ctx, { now: new Date(Date.now() + 21 * 3_600_000) });
    expect(t.email.last(u.email)!.text).toContain('Friends and follows: 1');
  });

  it('releases items when sending fails so the next run retries', async () => {
    const u = await signup(t);
    await verified(u);
    await give(u, 'security_alert');
    const realSend = t.ctx.email.send.bind(t.ctx.email);
    t.ctx.email.send = async () => {
      throw new Error('smtp down');
    };
    try {
      const res = await sendEmailDigests(t.ctx);
      expect(res.failed).toBeGreaterThanOrEqual(1);
      expect(
        (await sql('SELECT emailed_at FROM notifications WHERE user_id = $1', [u.id])).rows[0]
          .emailed_at,
      ).toBeNull();
      expect(
        (await sql('SELECT count(*)::int AS n FROM email_digest_log WHERE user_id = $1', [u.id]))
          .rows[0].n,
      ).toBe(0);
    } finally {
      t.ctx.email.send = realSend;
    }
    t.email.sent.length = 0;
    await sendEmailDigests(t.ctx);
    expect(t.email.last(u.email)).toBeDefined();
  });

  it('never emails suspended or deleted accounts', async () => {
    const u = await signup(t);
    await verified(u);
    await give(u, 'security_alert');
    await sql(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
    t.email.sent.length = 0;
    await sendEmailDigests(t.ctx);
    expect(t.email.last(u.email)).toBeUndefined();
  });
});
