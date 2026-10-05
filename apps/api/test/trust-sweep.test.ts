import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * The trust and safety, admin and developer platform sweep (2026-10-05): minor-safety reports hide
 * every kind of content at once, decisions fit what was reported (warnings, no "removing" an account),
 * overturned appeals undo the decision and the person hears the outcome, suspended people can appeal
 * from the sign-in page, admins can't demote themselves, and deleting a developer app disconnects it
 * everywhere.
 */

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('MINI_APPS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'MINI_APPS'`);
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
async function asRole(role: 'moderator' | 'admin') {
  const u = await adult();
  await db().query(`UPDATE users SET role = $2 WHERE id = $1`, [u.id, role]);
  return u;
}
async function follow(follower: TestUser, followee: TestUser) {
  await db().query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [follower.id, followee.id]);
}
async function caseFor(targetId: string) {
  return (await db().query(`SELECT id FROM moderation_cases WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1`, [targetId])).rows[0].id as string;
}
const decide = (mod: TestUser, caseId: string, decision: string) => as(t.app, mod).post(`/v1/admin/moderation/cases/${caseId}/decide`, { decision });
const notes = async (u: TestUser, type: string) => ((await as(t.app, u).get('/v1/notifications?limit=50')).body.items as any[]).filter((n) => n.type === type);
const outbox = async () => (await t.app.inject({ url: '/dev/outbox' })).json().items as { to: string; subject: string; text: string }[];
const login = (u: TestUser) => t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: u.email, password: u.password } });
async function photo(owner: TestUser) {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, moderation, variants) VALUES ($1,'image','http://localhost:4000/media/item.jpg','image/jpeg','ready','ok',
       '{"thumb":"http://localhost:4000/media/item_thumb.webp","medium":"http://localhost:4000/media/item_medium.webp"}') RETURNING id`,
    [owner.id],
  );
  return rows[0].id as string;
}

describe('admin roles', () => {
  it("refuses an unknown account, and an admin's own role", async () => {
    const admin = await asRole('admin');
    expect((await as(t.app, admin).put('/v1/admin/users/00000000-0000-4000-8000-000000000000/role', { role: 'moderator' })).status).toBe(404);
    expect((await as(t.app, admin).put(`/v1/admin/users/${admin.id}/role`, { role: 'user' })).status).toBe(400);
    expect((await db().query(`SELECT role FROM users WHERE id = $1`, [admin.id])).rows[0].role).toBe('admin');
    const someone = await adult();
    expect((await as(t.app, admin).put(`/v1/admin/users/${someone.id}/role`, { role: 'moderator' })).status).toBe(200);
    const log = (await db().query(`SELECT metadata FROM audit_logs WHERE action = 'user.role' AND entity_id = $1`, [someone.id])).rows[0];
    expect(log.metadata).toMatchObject({ role: 'moderator', before: 'user' });
  });

  it('finds people by username as typed, underscores and all', async () => {
    const admin = await asRole('admin');
    const someone = await adult();
    // Test usernames look like "t_abc123": the underscore used to be dropped, so nothing matched.
    const found = (await as(t.app, admin).get(`/v1/admin/users?q=${encodeURIComponent(`@${someone.username}`)}`)).body.items as any[];
    expect(found[0]).toMatchObject({ id: someone.id, username: someone.username });
    // "_" is a letter here, not a wildcard.
    const none = (await as(t.app, admin).get(`/v1/admin/users?q=${encodeURIComponent(someone.username.replace('_', 'x'))}`)).body.items as any[];
    expect(none.some((u) => u.id === someone.id)).toBe(false);
  });
});

describe('minor-safety reports', () => {
  it('hide every kind of content at once, until a moderator decides', async () => {
    const author = await adult();
    const reporter = await adult();
    const viewer = await adult();
    const mod = await asRole('moderator');
    for (const u of [reporter, viewer]) await follow(u, author);
    await follow(author, reporter);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'A post with a comment' })).body.post;
    const comment = (await as(t.app, author).post(`/v1/posts/${post.id}/comments`, { body: 'A comment' })).body.comment;
    const story = (await as(t.app, author).post('/v1/moments', { body: 'A story', visibility: 'followers' })).body.moment;
    const mix = (await as(t.app, author).post('/v1/mixes', { title: 'Songs for the road', visibility: 'public' })).body.mix;
    const conv = (await as(t.app, author).post('/v1/conversations', { memberIds: [reporter.id] })).body.conversation;
    const message = (await as(t.app, author).post(`/v1/conversations/${conv.id}/messages`, { body: 'Hello there', clientId: 'c1-minor' })).body.message;
    await db().query(`UPDATE profiles SET country = 'NG' WHERE user_id = ANY($1)`, [[author.id, reporter.id, viewer.id]]);
    const listing = (
      await as(t.app, author).post('/v1/market/listings', {
        title: 'Wooden study desk for sale',
        description: 'Solid desk with two drawers.',
        category: 'furniture',
        condition: 'good',
        priceCents: 2_500_000,
        photos: [{ mediaId: await photo(author), altText: 'A brown desk' }],
        area: 'Yaba, Lagos',
        place: { lat: 6.51234, lng: 3.37891 },
        delivery: ['pickup'],
      })
    ).body.listing;
    const event = (await as(t.app, author).post('/v1/events', { title: 'Street party', startsAt: new Date(Date.now() + 864e5).toISOString() })).body.event;

    for (const [targetType, targetId] of [
      ['comment', comment.id],
      ['story', story.id],
      ['mix', mix.id],
      ['message', message.id],
      ['listing', listing.id],
      ['event', event.id],
    ])
      expect((await as(t.app, reporter).post('/v1/reports', { targetType, targetId, reason: 'minor_safety' })).status).toBe(201);

    const status = async (table: string, id: string) =>
      (await db().query(`SELECT moderation_status FROM ${table} WHERE id = $1`, [id])).rows[0].moderation_status;
    expect(await status('comments', comment.id)).toBe('restricted');
    expect(await status('messages', message.id)).toBe('review');
    expect((await as(t.app, viewer).get(`/v1/moments/${story.id}`)).status).toBe(404);
    expect((await as(t.app, author).get(`/v1/moments/${story.id}`)).status).toBe(200);
    expect((await as(t.app, viewer).get(`/v1/mixes/${mix.id}`)).status).toBe(404);
    expect((await as(t.app, viewer).get(`/v1/market/listings/${listing.id}`)).status).toBe(404);
    // The comment leaves the post's count; the message leaves the reporter's chat.
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}`)).body.post.counts.comments).toBe(0);
    const chat = (await as(t.app, reporter).get(`/v1/conversations/${conv.id}/messages`)).body.items as any[];
    expect(chat.some((m) => m.id === message.id)).toBe(false);
    // One report doesn't take down a whole event: it waits, escalated, at the top of the queue.
    expect((await as(t.app, viewer).get(`/v1/events/${event.id}`)).status).toBe(200);
    const queue = (await as(t.app, mod).get('/v1/admin/moderation/cases')).body.items as any[];
    expect(queue.find((c) => c.target_id === event.id)).toMatchObject({ risk: 'escalate', excerpt: expect.stringContaining('Street party') });

    // "No action" lets them back; the story's case shows what it said.
    expect(queue.find((c) => c.target_id === story.id).excerpt).toBe('A story');
    expect((await decide(mod, await caseFor(story.id), 'no_action')).status).toBe(200);
    expect((await decide(mod, await caseFor(message.id), 'no_action')).status).toBe(200);
    expect((await as(t.app, viewer).get(`/v1/moments/${story.id}`)).status).toBe(200);
    expect(await status('messages', message.id)).toBe('normal');
  });
});

describe('decisions', () => {
  it('fit what was reported, and a warning leaves the thing up', async () => {
    const author = await adult();
    const reporter = await adult();
    const mod = await asRole('moderator');
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Borderline joke' })).body.post;
    await as(t.app, reporter).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'hate' });
    await as(t.app, reporter).post('/v1/reports', { targetType: 'user', targetId: author.id, reason: 'hate' });
    const account = await caseFor(author.id);
    for (const d of ['remove', 'restrict']) {
      const r = await decide(mod, account, d);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("That decision doesn't apply to this kind of report.");
    }
    expect((await decide(mod, await caseFor(post.id), 'warn')).status).toBe(200);
    expect((await as(t.app, reporter).get(`/v1/posts/${post.id}`)).status).toBe(200);
    expect((await notes(author, 'enforcement'))[0].data).toMatchObject({ decision: 'warn', canAppeal: true });
    expect((await notes(reporter, 'report_outcome'))[0].data).toMatchObject({ targetType: 'post', outcome: 'actioned' });
    expect((await decide(mod, account, 'warn')).status).toBe(200);
    const mine = (await as(t.app, author).get('/v1/me/moderation')).body.items as any[];
    expect(mine.map((c) => `${c.target_type}:${c.decision}`).sort()).toEqual(['post:warn', 'user:warn']);
  });
});

describe('appeals', () => {
  it('undo an overturned removal and tell the person; an upheld one stays as it was', async () => {
    const author = await adult();
    const reporter = await adult();
    const first = await asRole('moderator');
    const second = await asRole('moderator');
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Taken down by mistake' })).body.post;
    const kept = (await as(t.app, author).post('/v1/posts', { body: 'Rightly taken down' })).body.post;
    for (const p of [post, kept]) await as(t.app, reporter).post('/v1/reports', { targetType: 'post', targetId: p.id, reason: 'spam' });
    const wrong = await caseFor(post.id);
    const right = await caseFor(kept.id);
    for (const c of [wrong, right]) expect((await decide(first, c, 'remove')).status).toBe(200);
    expect((await as(t.app, reporter).get(`/v1/posts/${post.id}`)).status).toBe(404);
    for (const c of [wrong, right]) expect((await as(t.app, author).post('/v1/appeals', { caseId: c, statement: 'Please look again.' })).status).toBe(201);

    expect((await decide(second, wrong, 'no_action')).status).toBe(200);
    expect((await as(t.app, reporter).get(`/v1/posts/${post.id}`)).status).toBe(200);
    expect((await decide(second, right, 'remove')).status).toBe(200);
    expect((await as(t.app, reporter).get(`/v1/posts/${kept.id}`)).status).toBe(404);

    const outcomes = await notes(author, 'appeal_decided');
    expect(outcomes.map((n) => n.data.outcome).sort()).toEqual(['overturned', 'upheld']);
    // The overturned case stays in Settings, as what it was and how the appeal ended.
    const mine = (await as(t.app, author).get('/v1/me/moderation')).body.items as any[];
    expect(mine.find((c) => c.id === wrong)).toMatchObject({ decision: 'remove', final_decision: 'no_action', appeal_status: 'overturned' });
    expect(mine.find((c) => c.id === right)).toMatchObject({ decision: 'remove', appeal_status: 'upheld' });
    // The first enforcement ends with an overturn; an upheld one isn't recorded twice.
    const enf = (await db().query(`SELECT case_id, expires_at FROM enforcements WHERE user_id = $1`, [author.id])).rows;
    expect(enf.filter((e) => e.case_id === right)).toHaveLength(1);
    expect(enf.find((e) => e.case_id === wrong).expires_at).not.toBeNull();
    // "No action" can't be appealed.
    const fine = (await as(t.app, author).post('/v1/posts', { body: 'Nothing wrong' })).body.post;
    await as(t.app, reporter).post('/v1/reports', { targetType: 'post', targetId: fine.id, reason: 'spam' });
    const cleared = await caseFor(fine.id);
    await decide(first, cleared, 'no_action');
    expect((await as(t.app, author).post('/v1/appeals', { caseId: cleared, statement: 'Why?' })).status).toBe(400);
  });
});

describe('suspensions', () => {
  it('reach the person by email, and can be appealed from the sign-in page', async () => {
    const someone = await adult();
    const reporter = await adult();
    const admin = await asRole('admin');
    const other = await asRole('admin');
    await as(t.app, reporter).post('/v1/reports', { targetType: 'user', targetId: someone.id, reason: 'spam' });
    const c = await caseFor(someone.id);
    expect((await decide(admin, c, 'suspend_user')).status).toBe(200);
    expect((await outbox()).filter((m) => m.to === someone.email).pop()?.subject).toBe('Your YAPILAPI account is suspended');

    // The right password gives a token that only appeals; a wrong one says nothing about the account.
    expect((await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: someone.email, password: 'not-the-password' } })).statusCode).toBe(
      401,
    );
    const refused = await login(someone);
    expect(refused.statusCode).toBe(403);
    const err = refused.json().error;
    expect(err.code).toBe('account_suspended');
    const token = err.details.appeal.token as string;
    expect(token.length).toBeGreaterThan(20);
    const appeal = (body: unknown) => t.app.inject({ method: 'POST', url: '/v1/appeals/suspension', payload: body as object });
    expect((await appeal({ token: 'x'.repeat(30), statement: 'Let me back in.' })).statusCode).toBe(400);
    expect((await appeal({ token, statement: 'Someone else used my account.' })).statusCode).toBe(201);
    expect((await appeal({ token, statement: 'Again.' })).statusCode).toBe(400);
    expect((await login(someone)).json().error.details.appeal).toEqual({ status: 'open' });

    // The admin who suspended can't decide it; another can, and the person is told.
    expect((await decide(admin, c, 'no_action')).status).toBe(403);
    expect((await decide(other, c, 'no_action')).status).toBe(200);
    expect((await outbox()).filter((m) => m.to === someone.email).pop()?.subject).toBe('Your account is active again');
    const back = await login(someone);
    expect(back.statusCode).toBe(200);
    someone.token = back.json().token;
    expect((await notes(someone, 'appeal_decided'))[0].data.outcome).toBe('overturned');
  });

  it('from the console are cases too, ended by reinstating', async () => {
    const someone = await adult();
    const admin = await asRole('admin');
    expect((await as(t.app, admin).put(`/v1/admin/users/${someone.id}/status`, { status: 'suspended', note: 'Spam' })).status).toBe(200);
    const mc = (await db().query(`SELECT source, status, decision, reviewer_id FROM moderation_cases WHERE subject_user_id = $1`, [someone.id])).rows;
    expect(mc).toEqual([{ source: 'admin', status: 'decided', decision: 'suspend_user', reviewer_id: admin.id }]);
    expect((await login(someone)).json().error.details.appeal.token).toBeTruthy();
    expect((await as(t.app, admin).put(`/v1/admin/users/${someone.id}/status`, { status: 'active' })).status).toBe(200);
    expect((await login(someone)).statusCode).toBe(200);
    const enf = (await db().query(`SELECT expires_at FROM enforcements WHERE user_id = $1`, [someone.id])).rows;
    expect(enf[0].expires_at).not.toBeNull();
  });
});

describe('developer apps', () => {
  it('take a web address for a website, and deleting one disconnects it everywhere', async () => {
    const dev = await adult();
    const person = await adult();
    const friend = await adult();
    expect((await as(t.app, dev).post('/v1/developer/apps', { name: 'Scripted', website: 'javascript:alert(1)' })).status).toBe(400);
    const app = (await as(t.app, dev).post('/v1/developer/apps', { name: 'Lists', website: 'https://lists.example' })).body.app;
    const redirect = 'https://lists.example/cb';
    await as(t.app, dev).put(`/v1/developer/apps/${app.id}/redirect-uris`, { redirectUris: [redirect] });
    const verifier = randomBytes(40).toString('base64url');
    const query = {
      response_type: 'code',
      client_id: app.id,
      redirect_uri: redirect,
      scope: 'read',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    };
    const approved = await as(t.app, person).post('/v1/oauth/authorize', { ...query, approve: true });
    const code = new URL(approved.body.redirectTo).searchParams.get('code');
    const tokens = (
      await t.app.inject({
        method: 'POST',
        url: '/v1/oauth/token',
        payload: { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: app.id, code_verifier: verifier },
      })
    ).json();

    // A Mini App of the same developer app, on the developer's profile.
    const mini = (
      await as(t.app, dev).post(`/v1/developer/apps/${app.id}/mini-apps`, {
        name: 'Shared lists',
        entryUrl: 'https://lists.example/mini',
        permissions: ['profile'],
        surfaces: ['profile'],
      })
    ).body.miniApp;
    const listed = (await as(t.app, dev).get(`/v1/developer/apps/${app.id}/mini-apps`)).body.items;
    expect(listed).toMatchObject([{ id: mini.id, status: 'review', installs: 0 }]);
    await db().query(`UPDATE mini_apps SET status = 'approved' WHERE id = $1`, [mini.id]);
    expect((await as(t.app, dev).post(`/v1/mini-apps/${mini.id}/install`, { surface: 'profile', surfaceId: dev.id })).status).toBe(201);
    expect((await as(t.app, friend).get(`/v1/mini-apps/installed?surface=profile&surfaceId=${dev.id}`)).body.items).toHaveLength(1);
    // Not across a block.
    await as(t.app, dev).post(`/v1/users/${friend.id}/block`);
    expect((await as(t.app, friend).get(`/v1/mini-apps/installed?surface=profile&surfaceId=${dev.id}`)).status).toBe(404);
    await as(t.app, dev).del(`/v1/users/${friend.id}/block`);

    expect((await as(t.app, dev).del(`/v1/developer/apps/${app.id}`)).status).toBe(200);
    expect((await as(t.app, person).get('/v1/me/connected-apps')).body.items).toEqual([]);
    const refreshed = await t.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: app.id },
    });
    expect(refreshed.statusCode).toBe(400);
    expect((await as(t.app, friend).get(`/v1/mini-apps/installed?surface=profile&surfaceId=${dev.id}`)).body.items).toEqual([]);
    expect(((await as(t.app, friend).get('/v1/mini-apps?surface=profile')).body.items as any[]).some((m) => m.id === mini.id)).toBe(false);
  });
});
