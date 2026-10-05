import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t as translate } from '@yapilapi/shared/i18n';
import type { BuiltApp } from '../src/app.ts';
import type { PushMessage } from '../src/lib/push.ts';
import { setPushSender } from '../src/lib/services.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
let admin: TestUser;
let dev: TestUser;
let appId: string;
const pushes: { userId: string; msg: PushMessage }[] = [];
beforeAll(async () => {
  t = await testApp();
  // Tests run without a push service; this one records what would go out.
  setPushSender(async (userId, msg) => {
    pushes.push({ userId, msg });
  });
  admin = await signUp(t.app);
  await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
  dev = await signUp(t.app);
  // The developer reads YAPILAPI in French: pushes come in French.
  await t.ctx.db.query(`UPDATE profiles SET locale = 'fr' WHERE user_id = $1`, [dev.id]);
  appId = (await as(t.app, dev).post('/v1/developer/apps', { name: 'Polls+' })).body.app.id;
});
afterAll(async () => {
  setPushSender(null);
  await t.close();
});

async function submit(name: string): Promise<string> {
  const r = await as(t.app, dev).post(`/v1/developer/apps/${appId}/mini-apps`, { name, entryUrl: 'https://polls.example/app', surfaces: ['conversation'] });
  expect(r.status).toBe(201);
  return r.body.miniApp.id;
}
const notices = async (id: string) =>
  (
    await t.ctx.db.query(`SELECT type, category, actor_id, entity_type, data FROM notifications WHERE user_id = $1 AND entity_id = $2 ORDER BY created_at`, [
      dev.id,
      id,
    ])
  ).rows;
const mine = async (id: string) => (await as(t.app, dev).get(`/v1/developer/apps/${appId}/mini-apps`)).body.items.find((m: { id: string }) => m.id === id);
/** Pushes go out in the background: wait a moment for them. */
async function pushFor(type: string, entityId: string) {
  for (let i = 0; i < 80; i++) {
    const p = pushes.findLast((x) => x.userId === dev.id && x.msg.tag === type && x.msg.data?.entityId === entityId);
    if (p) return p.msg;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no ${type} push`);
}

describe('Mini App review', () => {
  it('tells the developer it was turned down, with the reason, which the developers page shows', async () => {
    const id = await submit('Polls+');
    const r = await as(t.app, admin).post(`/v1/admin/mini-apps/${id}/decide`, { approve: false, reason: '  The address shows an error page.  ' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id, status: 'rejected' });
    // From YAPILAPI, not from a named admin.
    expect(await notices(id)).toEqual([
      {
        type: 'mini_app_rejected',
        category: 'moderation',
        actor_id: null,
        entity_type: 'mini_app',
        data: { title: 'Polls+', appId, reason: 'The address shows an error page.' },
      },
    ]);
    expect(await mine(id)).toMatchObject({ status: 'rejected', rejectionReason: 'The address shows an error page.' });
    // The push is in the developer's language, and keeps the reason off the lock screen.
    const push = await pushFor('mini_app_rejected', id);
    expect(push.body).toBe(translate('push.mini_app_rejected', 'fr'));
    expect(push.body).not.toContain('error page');
    expect(push.data).toMatchObject({ type: 'mini_app_rejected', entityType: 'mini_app', entityId: id });
    // The reason is in the audit log too.
    const log = await t.ctx.db.query(`SELECT action, metadata FROM audit_logs WHERE entity_id = $1`, [id]);
    expect(log.rows).toEqual([{ action: 'mini_app.reject', metadata: { reason: 'The address shows an error page.' } }]);
  });

  it('turns down without a reason, and approving later clears it', async () => {
    const id = await submit('Quiz night');
    expect((await as(t.app, admin).post(`/v1/admin/mini-apps/${id}/decide`, { approve: false, reason: 'Fix the icon' })).status).toBe(200);
    expect((await as(t.app, admin).post(`/v1/admin/mini-apps/${id}/decide`, { approve: false })).status).toBe(200);
    expect((await notices(id)).at(-1)!.data).toEqual({ title: 'Quiz night', appId, reason: null });
    expect((await mine(id)).rejectionReason).toBeNull();

    // A reason is only kept for turning down.
    expect((await as(t.app, admin).post(`/v1/admin/mini-apps/${id}/decide`, { approve: true, reason: 'ignored' })).status).toBe(200);
    const last = (await notices(id)).at(-1)!;
    expect(last).toMatchObject({ type: 'mini_app_approved', actor_id: null, data: { title: 'Quiz night', appId, reason: null } });
    expect(await mine(id)).toMatchObject({ status: 'approved', rejectionReason: null });
    expect((await t.ctx.db.query(`SELECT review_reason FROM mini_apps WHERE id = $1`, [id])).rows[0].review_reason).toBeNull();
    expect((await pushFor('mini_app_approved', id)).body).toBe('Ta mini-app a été approuvée');
  });

  it('is for admins only, and checks what it is given', async () => {
    const id = await submit('Trivia');
    expect((await as(t.app, dev).post(`/v1/admin/mini-apps/${id}/decide`, { approve: true })).status).toBe(403);
    expect((await as(t.app, admin).post(`/v1/admin/mini-apps/${id}/decide`, { approve: false, reason: 'x'.repeat(2001) })).status).toBe(400);
    expect((await as(t.app, admin).post(`/v1/admin/mini-apps/00000000-0000-4000-8000-000000000000/decide`, { approve: true })).status).toBe(404);
    expect(await notices(id)).toEqual([]);
    expect((await mine(id)).status).toBe('review');
  });

  it("doesn't notify when the developer turned off moderation notifications, but still decides", async () => {
    const id = await submit('Bingo');
    await t.ctx.db.query(
      `INSERT INTO user_preferences (user_id, notification_categories) VALUES ($1, '{"moderation": false}')
       ON CONFLICT (user_id) DO UPDATE SET notification_categories = '{"moderation": false}'`,
      [dev.id],
    );
    try {
      expect((await as(t.app, admin).post(`/v1/admin/mini-apps/${id}/decide`, { approve: false, reason: 'Broken' })).status).toBe(200);
      expect(await notices(id)).toEqual([]);
      expect(await mine(id)).toMatchObject({ status: 'rejected', rejectionReason: 'Broken' });
    } finally {
      await t.ctx.db.query(`UPDATE user_preferences SET notification_categories = '{}' WHERE user_id = $1`, [dev.id]);
    }
  });
});
