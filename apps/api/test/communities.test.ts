import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@yapilapi/database';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import { getDeletionHooks } from '../src/lib/hooks.js';
import {
  grantCommunityMembership,
  listCommunityKnowledge,
} from '../src/modules/communities/index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const teenBirth = () => `${new Date().getUTCFullYear() - 15}-02-02`;

async function mk(owner: TestUser, over: Record<string, unknown> = {}) {
  const r = await owner.client.post('/v1/communities', { name: `Test ${uniq('n')}`, ...over });
  if (r.status !== 201)
    throw new Error(`create community failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; slug: string; name: string };
}

/** Bring a fresh user into any (non-paid) community through the real invite flow, optionally with a role. */
async function addMember(
  owner: TestUser,
  c: { id: string },
  role?: string,
  opts: Parameters<typeof signup>[1] = {},
) {
  const u = await signup(t, opts);
  const inv = await owner.client.post(`/v1/communities/${c.id}/invitations`, { userId: u.id });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await u.client.post(`/v1/communities/${c.id}/invitation/accept`);
  if (acc.status !== 200)
    throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  if (role) {
    const r = await owner.client.put(`/v1/communities/${c.id}/members/${u.id}/role`, {
      roleKey: role,
    });
    if (r.status !== 200) throw new Error(`assign failed ${r.status} ${JSON.stringify(r.body)}`);
  }
  return u;
}

const post = async (u: TestUser, communityId: string, body: string) => {
  const r = await u.client.post('/v1/posts', { body, communityId });
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
};
const auditCount = async (action: string, targetId: string) =>
  Number(
    (
      await t.ctx.db.query(
        'SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2',
        [action, targetId],
      )
    ).rows[0].n,
  );
const notifCount = async (userId: string, kind: string) =>
  Number(
    (
      await t.ctx.db.query(
        'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = $2',
        [userId, kind],
      )
    ).rows[0].n,
  );
const dbCount = async (id: string) =>
  Number(
    (await t.ctx.db.query('SELECT member_count FROM communities WHERE id = $1', [id])).rows[0]
      .member_count,
  );
const realCount = async (id: string) =>
  Number(
    (
      await t.ctx.db.query(
        `SELECT count(*)::int AS n FROM community_members WHERE community_id = $1 AND status = 'active'`,
        [id],
      )
    ).rows[0].n,
  );

describe('creating communities', () => {
  it('seeds roles, owner, default channel and member_count', async () => {
    const o = await signup(t);
    const c = await mk(o, {
      description: 'About things',
      topics: ['technology'],
      language: 'en',
      rules: [{ title: 'Be kind', body: 'Always' }],
    });
    const got = await o.client.get(`/v1/communities/${c.slug}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      id: c.id,
      visibility: 'public',
      joinPolicy: 'open',
      memberCount: 1,
      topics: ['technology'],
      language: 'en',
      access: 'full',
      rules: [{ title: 'Be kind', body: 'Always' }],
      viewer: { status: 'active', roleKey: 'owner', rank: 100 },
    });
    expect(got.body.viewer.permissions).toContain('manage_roles');
    const roles = await o.client.get(`/v1/communities/${c.id}/roles`);
    expect(roles.body.items.map((r: any) => r.key)).toEqual([
      'owner',
      'admin',
      'moderator',
      'member',
    ]);
    expect(roles.body.items.every((r: any) => r.isSystem)).toBe(true);
    const ch = await o.client.get(`/v1/communities/${c.id}/channels`);
    expect(ch.body.items).toMatchObject([{ name: 'general', kind: 'text', archived: false }]);
    expect(await auditCount('community.created', c.id)).toBe(1);
    // lookup by id works too
    expect((await anon().get(`/v1/communities/${c.id}`)).body.slug).toBe(c.slug);
  });

  it('validates input, requires auth and keeps slugs unique', async () => {
    const o = await signup(t);
    expect((await anon().post('/v1/communities', { name: 'Nope community' })).status).toBe(401);
    expect((await o.client.post('/v1/communities', { name: 'x' })).status).toBe(400);
    expect(
      (await o.client.post('/v1/communities', { name: 'Fine name', topics: ['not-a-topic'] }))
        .status,
    ).toBe(400);
    expect(
      (await o.client.post('/v1/communities', { name: 'Fine name', slug: 'Bad Slug!' })).status,
    ).toBe(400);
    expect(
      (await o.client.post('/v1/communities', { name: 'Fine name', slug: 'mine' })).status,
    ).toBe(400);
    expect(
      (
        await o.client.post('/v1/communities', {
          name: 'Fine name',
          visibility: 'secret',
          joinPolicy: 'open',
        })
      ).status,
    ).toBe(400);
    expect(
      (await o.client.post('/v1/communities', { name: 'Fine name', isPaid: true })).status,
    ).toBe(400);
    const slug = uniq('slug') + 'aa';
    expect((await o.client.post('/v1/communities', { name: 'First one', slug })).status).toBe(201);
    expect((await o.client.post('/v1/communities', { name: 'Second one', slug })).status).toBe(409);
    // derived slugs never collide: same name twice gets a suffix
    const name = `Twin ${uniq('tw')}`;
    const a = await o.client.post('/v1/communities', { name });
    const b = await o.client.post('/v1/communities', { name });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.slug).not.toBe(b.body.slug);
  });

  it('applies teen rules: private only, no paid, no secret joins', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    expect(
      (await teen.client.post('/v1/communities', { name: 'Teen public', visibility: 'public' }))
        .status,
    ).toBe(422);
    expect(
      (await teen.client.post('/v1/communities', { name: 'Teen secret', visibility: 'secret' }))
        .status,
    ).toBe(422);
    expect(
      (
        await teen.client.post('/v1/communities', {
          name: 'Teen paid',
          visibility: 'private',
          isPaid: true,
          priceCents: 500,
          currency: 'USD',
        })
      ).status,
    ).toBe(422);
    const mine = await teen.client.post('/v1/communities', { name: `Teen club ${uniq('tc')}` });
    expect(mine.status).toBe(201);
    expect(mine.body.visibility).toBe('private'); // default for teens
    // a teen may not become the public face of a community via settings either
    expect(
      (await teen.client.patch(`/v1/communities/${mine.body.id}`, { visibility: 'public' })).status,
    ).toBe(422);

    const adult = await signup(t);
    const pub = await mk(adult);
    const secret = await mk(adult, { visibility: 'secret' });
    expect((await teen.client.post(`/v1/communities/${pub.id}/join`)).status).toBe(200);
    // secret: hidden (404) unless invited; even when invited, teens cannot accept
    expect((await teen.client.post(`/v1/communities/${secret.id}/join`)).status).toBe(404);
    expect(
      (await adult.client.post(`/v1/communities/${secret.id}/invitations`, { userId: teen.id }))
        .status,
    ).toBe(201);
    expect((await teen.client.post(`/v1/communities/${secret.id}/invitation/accept`)).status).toBe(
      403,
    );
    expect((await teen.client.post(`/v1/communities/${secret.id}/join`)).status).toBe(403);
    expect(
      (await teen.client.get('/v1/me/community-invitations')).body.items.map((i: any) => i.id),
    ).not.toContain(secret.id);
    // adult moderators/owners stay visible to teens; teens are hidden from non-members' member lists
    const stranger = await signup(t);
    const list = await stranger.client.get(`/v1/communities/${pub.id}/members`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((m: any) => m.user.id)).not.toContain(teen.id);
    expect(
      (await teen.client.get(`/v1/communities/${pub.id}/members`)).body.items.map(
        (m: any) => m.user.id,
      ),
    ).toContain(adult.id);
  });
});

describe('visibility rules', () => {
  it('public / private / secret for anonymous, non-members, invitees, members and banned users', async () => {
    const o = await signup(t);
    const pub = await mk(o, { rules: [{ title: 'r1' }] });
    const priv = await mk(o, { visibility: 'private', rules: [{ title: 'r1' }] });
    const sec = await mk(o, { visibility: 'secret' });
    const stranger = await signup(t);
    const member = await addMember(o, priv);
    await addMember(o, sec).then(async (u) =>
      expect((await u.client.get(`/v1/communities/${sec.id}`)).status).toBe(200),
    );

    // public: full detail for everyone
    expect((await anon().get(`/v1/communities/${pub.id}`)).body).toMatchObject({
      access: 'full',
      rules: [{ title: 'r1' }],
    });
    // private: summary only for non-members and anonymous
    for (const c of [anon(), stranger.client]) {
      const r = await c.get(`/v1/communities/${priv.slug}`);
      expect(r.status).toBe(200);
      expect(r.body.access).toBe('summary');
      expect(r.body).not.toHaveProperty('rules');
      expect(r.body.name).toBe(priv.name);
    }
    expect((await member.client.get(`/v1/communities/${priv.id}`)).body).toMatchObject({
      access: 'full',
      rules: [{ title: 'r1' }],
    });
    // private content endpoints
    for (const path of ['feed', 'resources', 'decisions']) {
      expect((await anon().get(`/v1/communities/${priv.id}/${path}`)).status).toBe(403);
      expect((await stranger.client.get(`/v1/communities/${priv.id}/${path}`)).status).toBe(403);
      expect((await member.client.get(`/v1/communities/${priv.id}/${path}`)).status).toBe(200);
    }
    expect((await stranger.client.get(`/v1/communities/${priv.id}/members`)).status).toBe(403);
    expect((await anon().get(`/v1/communities/${priv.id}/members`)).status).toBe(401);
    expect((await stranger.client.get(`/v1/communities/${priv.id}/channels`)).status).toBe(403);
    // secret: 404 for anyone who is not a member or invitee (including banned users)
    expect((await anon().get(`/v1/communities/${sec.slug}`)).status).toBe(404);
    expect((await stranger.client.get(`/v1/communities/${sec.id}`)).status).toBe(404);
    expect((await stranger.client.get(`/v1/communities/${sec.id}/feed`)).status).toBe(404);
    expect((await stranger.client.post(`/v1/communities/${sec.id}/join`)).status).toBe(404);
    const invitee = await signup(t);
    await o.client.post(`/v1/communities/${sec.id}/invitations`, { userId: invitee.id });
    const asInvitee = await invitee.client.get(`/v1/communities/${sec.id}`);
    expect(asInvitee.status).toBe(200);
    expect(asInvitee.body).toMatchObject({ access: 'summary', viewer: { status: 'invited' } });
    expect((await invitee.client.get(`/v1/communities/${sec.id}/feed`)).status).toBe(403);
    const banned = await addMember(o, sec);
    expect((await o.client.post(`/v1/communities/${sec.id}/members/${banned.id}/ban`)).status).toBe(
      200,
    );
    expect((await banned.client.get(`/v1/communities/${sec.id}`)).status).toBe(404);
    // unknown / deleted
    expect((await anon().get('/v1/communities/does-not-exist-anywhere')).status).toBe(404);
    expect((await anon().get('/v1/communities/00000000-0000-4000-8000-000000000000')).status).toBe(
      404,
    );
  });
});

describe('browse & my communities', () => {
  it('filters by topic, text search and language; hides private/secret; paginates by keyset', async () => {
    const o = await signup(t);
    const token = uniq('zq').replace(/[^a-z0-9]/g, '');
    const mkc = (i: number, over: Record<string, unknown> = {}) =>
      mk(o, { name: `${token} club ${i}`, description: 'browse me', ...over });
    const a = await mkc(1, { topics: ['music'], language: 'en' });
    const b = await mkc(2, { topics: ['music', 'art'], language: 'fr' });
    const c = await mkc(3, { topics: ['art'], language: 'en' });
    await mkc(4, { visibility: 'private' });
    await mkc(5, { visibility: 'secret' });

    const ids = (r: any) => r.body.items.map((i: any) => i.id).sort();
    const all = await anon().get('/v1/communities', { q: token });
    expect(all.status).toBe(200);
    expect(ids(all)).toEqual([a.id, b.id, c.id].sort());
    expect(all.body.items[0]).not.toHaveProperty('rules');
    expect(ids(await anon().get('/v1/communities', { q: token, topic: 'music' }))).toEqual(
      [a.id, b.id].sort(),
    );
    expect(
      ids(await anon().get('/v1/communities', { q: token, topic: 'art', language: 'en' })),
    ).toEqual([c.id]);
    expect(ids(await anon().get('/v1/communities', { q: token, language: 'fr' }))).toEqual([b.id]);
    expect(ids(await anon().get('/v1/communities', { q: `${token} club 2` }))).toContain(b.id);
    expect(ids(await anon().get('/v1/communities', { q: token.slice(0, 6) + 'nomatch' }))).toEqual(
      [],
    );
    expect((await anon().get('/v1/communities', { limit: '0' })).status).toBe(400);
    expect((await anon().get('/v1/communities', { cursor: '!!' })).status).toBe(400);

    // wildcard characters in q are literal
    expect(ids(await anon().get('/v1/communities', { q: '%' }))).not.toContain(a.id);

    const p1 = await anon().get('/v1/communities', { q: token, limit: '2' });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await anon().get('/v1/communities', {
      q: token,
      limit: '2',
      cursor: p1.body.nextCursor,
    });
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect([...p1.body.items, ...p2.body.items].map((i: any) => i.id).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );

    // viewer status is reflected for signed-in users
    const u = await signup(t);
    await u.client.post(`/v1/communities/${a.id}/join`);
    const withStatus = await u.client.get('/v1/communities', { q: token });
    expect(withStatus.body.items.find((i: any) => i.id === a.id).viewer).toEqual({
      status: 'active',
    });
    expect(withStatus.body.items.find((i: any) => i.id === b.id).viewer).toBeNull();
  });

  it('lists my communities (including secret) with keyset pagination', async () => {
    const o = await signup(t);
    const cs = [
      await mk(o),
      await mk(o, { visibility: 'secret' }),
      await mk(o, { visibility: 'private' }),
    ];
    expect((await anon().get('/v1/me/communities')).status).toBe(401);
    const p1 = await o.client.get('/v1/me/communities', { limit: '2' });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await o.client.get('/v1/me/communities', { limit: '2', cursor: p1.body.nextCursor });
    expect(p2.body.items).toHaveLength(1);
    expect([...p1.body.items, ...p2.body.items].map((i: any) => i.id).sort()).toEqual(
      cs.map((c) => c.id).sort(),
    );
    expect(p1.body.items[0].viewer.roleKey).toBe('owner');
    const other = await signup(t);
    expect((await other.client.get('/v1/me/communities')).body.items).toEqual([]);
  });
});

describe('join policies', () => {
  it('open communities activate immediately and keep member_count exact', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const u = await signup(t);
    expect(await anon().post(`/v1/communities/${c.id}/join`)).toMatchObject({ status: 401 });
    const j = await u.client.post(`/v1/communities/${c.id}/join`);
    expect(j).toMatchObject({ status: 200, body: { status: 'active' } });
    expect((await u.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('active'); // idempotent
    expect(await dbCount(c.id)).toBe(2);
    expect((await u.client.post(`/v1/communities/${c.id}/leave`)).status).toBe(200);
    expect(await dbCount(c.id)).toBe(1);
    expect((await u.client.post(`/v1/communities/${c.id}/leave`)).status).toBe(404); // not a member any more
    expect((await u.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('active'); // may rejoin
    expect(await dbCount(c.id)).toBe(await realCount(c.id));
  });

  it('request policy queues pending requests and moderators approve or reject them', async () => {
    const o = await signup(t);
    const c = await mk(o, { visibility: 'private' }); // private defaults to request
    expect((await o.client.get(`/v1/communities/${c.id}`)).body.joinPolicy).toBe('request');
    const mod = await addMember(o, c, 'moderator');
    const plain = await addMember(o, c);
    const u1 = await signup(t);
    const u2 = await signup(t);
    expect((await u1.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('pending');
    expect((await u1.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('pending'); // idempotent
    expect((await u2.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('pending');
    expect(await notifCount(o.id, 'community_join_request')).toBeGreaterThanOrEqual(2);
    expect(await notifCount(mod.id, 'community_join_request')).toBe(2);
    expect(await notifCount(plain.id, 'community_join_request')).toBe(0);
    expect(await dbCount(c.id)).toBe(3); // pending does not count
    expect((await u1.client.get(`/v1/communities/${c.id}/feed`)).status).toBe(403);
    expect((await u1.client.get(`/v1/communities/${c.id}`)).body.viewer.status).toBe('pending');

    // queue visibility & permissions
    expect(
      (await plain.client.get(`/v1/communities/${c.id}/members`, { status: 'pending' })).status,
    ).toBe(403);
    expect(
      (await u1.client.get(`/v1/communities/${c.id}/members`, { status: 'pending' })).status,
    ).toBe(403);
    const q = await mod.client.get(`/v1/communities/${c.id}/members`, { status: 'pending' });
    expect(q.body.items.map((m: any) => m.user.id).sort()).toEqual([u1.id, u2.id].sort());
    expect(
      (await plain.client.post(`/v1/communities/${c.id}/requests/${u1.id}/approve`)).status,
    ).toBe(403);
    expect((await u1.client.post(`/v1/communities/${c.id}/requests/${u1.id}/approve`)).status).toBe(
      403,
    ); // cannot self-approve
    expect(
      (await mod.client.post(`/v1/communities/${c.id}/requests/${u1.id}/approve`)).body.status,
    ).toBe('active');
    expect(
      (await mod.client.post(`/v1/communities/${c.id}/requests/${u1.id}/approve`)).status,
    ).toBe(404);
    expect(await notifCount(u1.id, 'community_request_approved')).toBe(1);
    expect((await u1.client.get(`/v1/communities/${c.id}/feed`)).status).toBe(200);
    expect((await o.client.post(`/v1/communities/${c.id}/requests/${u2.id}/reject`)).status).toBe(
      200,
    );
    expect((await u2.client.get(`/v1/communities/${c.id}`)).body.viewer.status).toBe('left');
    expect(await dbCount(c.id)).toBe(4);
    expect(await auditCount('community.request.approved', c.id)).toBe(1);
    // a rejected user may ask again; a pending user may cancel
    expect((await u2.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('pending');
    expect((await u2.client.post(`/v1/communities/${c.id}/leave`)).status).toBe(200);
    expect(
      (await mod.client.post(`/v1/communities/${c.id}/requests/${u2.id}/approve`)).status,
    ).toBe(404);
  });

  it('invite-only communities need an invitation from a member with the invite permission', async () => {
    const o = await signup(t);
    const c = await mk(o, { joinPolicy: 'invite' });
    const stranger = await signup(t);
    expect((await stranger.client.post(`/v1/communities/${c.id}/join`)).status).toBe(403);
    const plain = await addMember(o, c);
    const mod = await addMember(o, c, 'moderator');
    // members lack `invite`; moderators have it
    expect(
      (await plain.client.post(`/v1/communities/${c.id}/invitations`, { userId: stranger.id }))
        .status,
    ).toBe(403);
    expect(
      (await stranger.client.post(`/v1/communities/${c.id}/invitations`, { userId: stranger.id }))
        .status,
    ).toBe(403);
    expect(
      (await anon().post(`/v1/communities/${c.id}/invitations`, { userId: stranger.id })).status,
    ).toBe(401);
    expect((await mod.client.post(`/v1/communities/${c.id}/invitations`, {})).status).toBe(400);
    expect(
      (await mod.client.post(`/v1/communities/${c.id}/invitations`, { userId: mod.id })).status,
    ).toBe(400);
    expect(
      (
        await mod.client.post(`/v1/communities/${c.id}/invitations`, {
          username: stranger.username,
        })
      ).status,
    ).toBe(201);
    expect(
      (await mod.client.post(`/v1/communities/${c.id}/invitations`, { userId: stranger.id }))
        .status,
    ).toBe(200); // idempotent
    expect(
      (await mod.client.post(`/v1/communities/${c.id}/invitations`, { userId: plain.id })).status,
    ).toBe(409);
    expect(await notifCount(stranger.id, 'community_invite')).toBe(1);
    const inbox = await stranger.client.get('/v1/me/community-invitations');
    expect(inbox.body.items.map((i: any) => i.id)).toContain(c.id);
    // accept
    expect(
      (await stranger.client.post(`/v1/communities/${c.id}/invitation/accept`)).body.status,
    ).toBe('active');
    expect((await stranger.client.post(`/v1/communities/${c.id}/invitation/accept`)).status).toBe(
      404,
    );
    expect(
      (await stranger.client.get('/v1/me/community-invitations')).body.items.map((i: any) => i.id),
    ).not.toContain(c.id);
    // decline
    const d = await signup(t);
    await o.client.post(`/v1/communities/${c.id}/invitations`, { userId: d.id });
    expect((await d.client.post(`/v1/communities/${c.id}/invitation/decline`)).body.status).toBe(
      'left',
    );
    expect((await d.client.post(`/v1/communities/${c.id}/join`)).status).toBe(403);
    // joining while invited on an invite-only community counts as accepting
    const e = await signup(t);
    await o.client.post(`/v1/communities/${c.id}/invitations`, { userId: e.id });
    expect((await e.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('active');
    // an unrelated user cannot accept for someone else
    expect(
      (await signup(t).then((u) => u.client.post(`/v1/communities/${c.id}/invitation/accept`)))
        .status,
    ).toBe(404);
    expect(await dbCount(c.id)).toBe(await realCount(c.id));
  });

  it('blocked users cannot be invited and secret communities are invite-only', async () => {
    const o = await signup(t);
    const c = await mk(o, { visibility: 'secret' });
    expect((await o.client.get(`/v1/communities/${c.id}`)).body.joinPolicy).toBe('invite');
    expect((await o.client.patch(`/v1/communities/${c.id}`, { joinPolicy: 'open' })).status).toBe(
      400,
    );
    const b = await signup(t);
    await b.client.put(`/v1/users/${o.username}/block`);
    expect(
      (await o.client.post(`/v1/communities/${c.id}/invitations`, { userId: b.id })).status,
    ).toBe(404);
  });
});

describe('leaving & ownership', () => {
  it('owner cannot leave without transferring ownership; transfer swaps roles', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    const plain = await addMember(o, c);
    expect((await o.client.post(`/v1/communities/${c.id}/leave`)).status).toBe(409);
    expect(
      (await admin.client.post(`/v1/communities/${c.id}/transfer-ownership`, { userId: plain.id }))
        .status,
    ).toBe(403);
    expect(
      (await plain.client.post(`/v1/communities/${c.id}/transfer-ownership`, { userId: plain.id }))
        .status,
    ).toBe(403);
    expect(
      (await o.client.post(`/v1/communities/${c.id}/transfer-ownership`, { userId: o.id })).status,
    ).toBe(400);
    expect(
      (
        await o.client.post(`/v1/communities/${c.id}/transfer-ownership`, {
          userId: (await signup(t)).id,
        })
      ).status,
    ).toBe(404); // not a member
    expect(
      (await anon().post(`/v1/communities/${c.id}/transfer-ownership`, { userId: admin.id }))
        .status,
    ).toBe(401);
    expect(
      (await o.client.post(`/v1/communities/${c.id}/transfer-ownership`, { userId: admin.id }))
        .status,
    ).toBe(200);
    expect((await admin.client.get(`/v1/communities/${c.id}`)).body.viewer.roleKey).toBe('owner');
    expect((await o.client.get(`/v1/communities/${c.id}`)).body.viewer.roleKey).toBe('admin');
    const owners = await t.ctx.db.query(
      `SELECT count(*)::int AS n FROM community_members WHERE community_id = $1 AND role_key = 'owner'`,
      [c.id],
    );
    expect(owners.rows[0].n).toBe(1);
    expect(await auditCount('community.ownership_transferred', c.id)).toBe(1);
    // the former owner may now leave; the new owner may not
    expect((await o.client.post(`/v1/communities/${c.id}/leave`)).status).toBe(200);
    expect((await admin.client.post(`/v1/communities/${c.id}/leave`)).status).toBe(409);
    expect(await dbCount(c.id)).toBe(2);
  });

  it('only the owner can delete a community', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    expect((await admin.client.del(`/v1/communities/${c.id}`)).status).toBe(403);
    expect((await o.client.del(`/v1/communities/${c.id}`)).status).toBe(204);
    expect((await anon().get(`/v1/communities/${c.id}`)).status).toBe(404);
    expect(await auditCount('community.deleted', c.id)).toBe(1);
  });
});

describe('member management: kick / ban / hierarchy', () => {
  it('enforces the permission matrix and rank hierarchy', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    const mod = await addMember(o, c, 'moderator');
    const mod2 = await addMember(o, c, 'moderator');
    const member = await addMember(o, c);
    const member2 = await addMember(o, c);
    const outsider = await signup(t);
    const kick = (actor: TestUser | null, target: TestUser) =>
      (actor?.client ?? anon()).del(`/v1/communities/${c.id}/members/${target.id}`);

    expect((await kick(null, member)).status).toBe(401);
    expect((await kick(outsider, member)).status).toBe(403); // non-member
    expect((await kick(member, member2)).status).toBe(403); // no permission
    expect((await kick(member, member)).status).toBe(403);
    expect((await kick(mod, mod)).status).toBe(400); // use leave
    expect((await kick(mod, mod2)).status).toBe(403); // equal rank
    expect((await kick(mod, admin)).status).toBe(403); // higher rank
    expect((await kick(mod, o)).status).toBe(403); // owner
    expect((await kick(admin, o)).status).toBe(403);
    expect((await kick(mod, outsider)).status).toBe(404); // not a member
    expect(await dbCount(c.id)).toBe(6);

    expect((await kick(mod, member)).status).toBe(204);
    expect(await notifCount(member.id, 'community_removed')).toBe(1);
    expect((await member.client.get(`/v1/communities/${c.id}`)).body.viewer.status).toBe('left');
    expect(await dbCount(c.id)).toBe(5);
    expect((await kick(admin, mod)).status).toBe(204);
    expect((await kick(o, admin)).status).toBe(204);
    expect(await dbCount(c.id)).toBe(3);
    expect(await auditCount('community.member.removed', c.id)).toBe(3);
    // kicked users can rejoin an open community, without keeping their old role
    expect((await mod.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('active');
    expect((await mod.client.get(`/v1/communities/${c.id}`)).body.viewer.roleKey).toBe('member');
    expect(await dbCount(c.id)).toBe(await realCount(c.id));
  });

  it('bans block rejoining, hide private content and respect hierarchy; unban restores', async () => {
    const o = await signup(t);
    const pub = await mk(o);
    const priv = await mk(o, { visibility: 'private' });
    const admin = await addMember(o, pub, 'admin');
    const mod = await addMember(o, pub, 'moderator');
    const member = await addMember(o, pub);
    const outsider = await signup(t);
    const ban = (actor: TestUser, target: TestUser, cid = pub.id) =>
      actor.client.post(`/v1/communities/${cid}/members/${target.id}/ban`, {});

    expect((await ban(member, outsider)).status).toBe(403);
    expect((await ban(mod, admin)).status).toBe(403);
    expect((await ban(mod, o)).status).toBe(403);
    expect((await ban(mod, mod)).status).toBe(400);
    expect((await ban(admin, o)).status).toBe(403);
    expect(
      (await anon().post(`/v1/communities/${pub.id}/members/${member.id}/ban`, {})).status,
    ).toBe(401);
    expect(
      (
        await mod.client.post(
          `/v1/communities/${pub.id}/members/00000000-0000-4000-8000-000000000000/ban`,
          {},
        )
      ).status,
    ).toBe(404);

    // ban an active member: removed from the count, can't rejoin, can't post, loses feed items
    const p = await post(o, pub.id, 'owner post visible to members only via the community rules');
    expect((await ban(mod, member)).body.status).toBe('banned');
    expect((await ban(mod, member)).body.status).toBe('banned'); // idempotent
    expect(await dbCount(pub.id)).toBe(3);
    expect((await member.client.post(`/v1/communities/${pub.id}/join`)).status).toBe(403);
    expect(
      (await member.client.post('/v1/posts', { body: 'still here?', communityId: pub.id })).status,
    ).toBe(403);
    expect((await member.client.get(`/v1/communities/${pub.id}/channels`)).status).toBe(403);
    expect(
      (await member.client.get(`/v1/communities/${pub.id}/feed`)).body.items.map((i: any) => i.id),
    ).not.toContain(p.id);
    expect(
      (await o.client.get(`/v1/communities/${pub.id}/feed`)).body.items.map((i: any) => i.id),
    ).toContain(p.id);
    expect((await member.client.post(`/v1/communities/${pub.id}/leave`)).status).toBe(404); // banned users cannot "leave" the ban away
    expect(await notifCount(member.id, 'community_banned')).toBe(1);
    const banned = await mod.client.get(`/v1/communities/${pub.id}/members`, { status: 'banned' });
    expect(banned.body.items.map((m: any) => m.user.id)).toEqual([member.id]);
    expect(
      (await member.client.get(`/v1/communities/${pub.id}/members`, { status: 'banned' })).status,
    ).toBe(403);
    expect(
      (await o.client.post(`/v1/communities/${pub.id}/invitations`, { userId: member.id })).status,
    ).toBe(403);

    // ban a non-member (pre-emptive) on a private community
    expect((await ban(o, outsider, priv.id)).status).toBe(200);
    expect((await outsider.client.post(`/v1/communities/${priv.id}/join`)).status).toBe(403);
    expect((await outsider.client.get(`/v1/communities/${priv.id}/feed`)).status).toBe(403);

    // unban: permissions and idempotency
    const unban = (actor: TestUser, target: TestUser, cid = pub.id) =>
      actor.client.del(`/v1/communities/${cid}/members/${target.id}/ban`);
    expect((await unban(member, member)).status).toBe(403);
    expect((await unban(admin, outsider)).status).toBe(404); // not banned here
    expect((await unban(mod, member)).status).toBe(204);
    expect((await unban(mod, member)).status).toBe(404);
    expect((await member.client.post(`/v1/communities/${pub.id}/join`)).body.status).toBe('active');
    expect(await auditCount('community.member.banned', pub.id)).toBe(1);
    expect(await auditCount('community.member.unbanned', pub.id)).toBe(1);
    expect(await dbCount(pub.id)).toBe(await realCount(pub.id));
  });

  it('a banned pending/invited/kicked user is handled; banning a pending applicant removes the request', async () => {
    const o = await signup(t);
    const c = await mk(o, { visibility: 'private' });
    const u = await signup(t);
    await u.client.post(`/v1/communities/${c.id}/join`);
    expect(
      (await o.client.post(`/v1/communities/${c.id}/members/${u.id}/ban`, { reason: 'spam' }))
        .status,
    ).toBe(200);
    expect((await o.client.post(`/v1/communities/${c.id}/requests/${u.id}/approve`)).status).toBe(
      404,
    );
    expect((await u.client.post(`/v1/communities/${c.id}/join`)).status).toBe(403);
    expect(await auditCount('community.member.banned', c.id)).toBe(1);
  });
});

describe('roles & permissions', () => {
  it('manages custom roles within the actor’s own rank and permissions', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin'); // admin lacks manage_roles
    const mod = await addMember(o, c, 'moderator');
    const member = await addMember(o, c);
    const outsider = await signup(t);
    const base = `/v1/communities/${c.id}/roles`;

    expect((await anon().get(base)).status).toBe(401);
    expect((await outsider.client.get(base)).status).toBe(403);
    expect((await member.client.get(base)).status).toBe(200);
    for (const u of [admin, mod, member, outsider]) {
      expect(
        (
          await u.client.post(base, {
            key: 'helper',
            name: 'Helper',
            permissions: ['post'],
            rank: 20,
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await o.client.post(base, {
          key: 'helper',
          name: 'Helper',
          permissions: ['post', 'comment', 'pin'],
          rank: 30,
        })
      ).status,
    ).toBe(201);
    expect(
      (await o.client.post(base, { key: 'helper', name: 'Helper', permissions: [], rank: 30 }))
        .status,
    ).toBe(409);
    expect(
      (await o.client.post(base, { key: 'member', name: 'Dupe', permissions: [], rank: 5 })).status,
    ).toBe(409);
    expect(
      (await o.client.post(base, { key: 'evil', name: 'Evil', permissions: ['post'], rank: 100 }))
        .status,
    ).toBe(400); // ranks are capped below the owner's
    expect(
      (await o.client.post(base, { key: 'evil', name: 'Evil', permissions: ['post'], rank: 150 }))
        .status,
    ).toBe(400);
    expect(
      (await o.client.post(base, { key: 'evil', name: 'Evil', permissions: ['root'], rank: 20 }))
        .status,
    ).toBe(400);
    expect(
      (await o.client.post(base, { key: 'Bad-Key', name: 'Evil', permissions: [], rank: 20 }))
        .status,
    ).toBe(400);

    // a delegated role manager cannot escalate
    expect(
      (
        await o.client.post(base, {
          key: 'boss',
          name: 'Boss',
          permissions: ['manage_roles', 'post'],
          rank: 60,
        })
      ).status,
    ).toBe(201);
    const boss = await addMember(o, c, 'boss');
    expect(
      (await boss.client.post(base, { key: 'peer', name: 'Peer', permissions: ['post'], rank: 60 }))
        .status,
    ).toBe(403); // same rank
    expect(
      (
        await boss.client.post(base, {
          key: 'strong',
          name: 'Strong',
          permissions: ['moderate'],
          rank: 40,
        })
      ).status,
    ).toBe(403); // lacks moderate
    expect(
      (
        await boss.client.post(base, {
          key: 'lesser',
          name: 'Lesser',
          permissions: ['post'],
          rank: 40,
        })
      ).status,
    ).toBe(201);
    expect((await boss.client.patch(`${base}/lesser`, { rank: 70 })).status).toBe(403);
    expect(
      (await boss.client.patch(`${base}/lesser`, { permissions: ['post', 'invite'] })).status,
    ).toBe(403);
    expect((await boss.client.patch(`${base}/lesser`, { name: 'Lesser!' })).status).toBe(200);
    expect((await boss.client.patch(`${base}/boss`, { name: 'Self' })).status).toBe(403); // own role
    expect((await boss.client.patch(`${base}/moderator`, { name: 'Xx' })).status).toBe(403); // system role
    expect((await o.client.patch(`${base}/moderator`, { name: 'Xx' })).status).toBe(403); // system roles are immutable even for the owner
    expect((await o.client.del(`${base}/owner`)).status).toBe(403);
    expect((await o.client.patch(`${base}/nothere`, { name: 'Xx' })).status).toBe(404);

    // assignment limits
    const assign = (actor: TestUser, target: TestUser, roleKey: string) =>
      actor.client.put(`/v1/communities/${c.id}/members/${target.id}/role`, { roleKey });
    expect((await assign(boss, member, 'admin')).status).toBe(403); // rank 80 >= 60
    expect((await assign(boss, member, 'owner')).status).toBe(403);
    expect((await assign(boss, admin, 'member')).status).toBe(403); // target outranks boss
    expect((await assign(boss, boss, 'member')).status).toBe(403); // cannot act on self
    expect((await assign(o, member, 'owner')).status).toBe(403); // ownership only via transfer
    expect((await assign(o, outsider, 'member')).status).toBe(404); // not a member
    expect((await assign(o, member, 'ghost')).status).toBe(404);
    expect((await assign(mod, member, 'member')).status).toBe(403);
    expect((await assign(admin, member, 'moderator')).status).toBe(403);
    expect((await assign(boss, member, 'helper')).status).toBe(200);
    expect((await assign(boss, mod, 'helper')).status).toBe(200); // moderator rank 50 < 60
    expect(await auditCount('community.role.assigned', c.id)).toBe(5);
    expect((await member.client.get(`/v1/communities/${c.id}`)).body.viewer).toMatchObject({
      roleKey: 'helper',
      rank: 30,
    });

    // custom-role permissions really take effect: helper has pin, not manage_resources
    const rs = `/v1/communities/${c.id}/resources`;
    const res = await o.client.post(rs, { title: 'Guide' });
    expect((await member.client.put(`${rs}/${res.body.id}/pin`, { pinned: true })).status).toBe(
      200,
    );
    expect((await member.client.post(rs, { title: 'Nope' })).status).toBe(403);

    // deleting a role demotes its holders to member
    expect((await boss.client.del(`${base}/moderator`)).status).toBe(403);
    expect((await boss.client.del(`${base}/boss`)).status).toBe(403);
    expect((await o.client.del(`${base}/helper`)).status).toBe(204);
    expect((await member.client.get(`/v1/communities/${c.id}`)).body.viewer.roleKey).toBe('member');
    const list = await o.client.get(`/v1/communities/${c.id}/members`);
    const helperRows = list.body.items.filter((m: any) => m.roleKey === 'helper');
    expect(helperRows).toEqual([]);
    expect((await o.client.del(`${base}/helper`)).status).toBe(404);
  });

  it('lists members with roles, highest rank first, paginated', async () => {
    const o = await signup(t);
    const c = await mk(o);
    await addMember(o, c, 'admin');
    await addMember(o, c, 'moderator');
    await addMember(o, c);
    await addMember(o, c);
    const p1 = await o.client.get(`/v1/communities/${c.id}/members`, { limit: '3' });
    expect(p1.body.items.map((m: any) => m.roleKey)).toEqual(['owner', 'admin', 'moderator']);
    const p2 = await o.client.get(`/v1/communities/${c.id}/members`, {
      limit: '3',
      cursor: p1.body.nextCursor,
    });
    expect(p2.body.items.map((m: any) => m.roleKey)).toEqual(['member', 'member']);
    expect(p2.body.nextCursor).toBeNull();
    expect(p1.body.items[0]).toMatchObject({ roleName: 'Owner', rank: 100, status: 'active' });
    expect(p1.body.items[0].user).toHaveProperty('username');
  });
});

describe('settings', () => {
  it('requires manage_settings; only the owner changes visibility; secret forces invite-only', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    const mod = await addMember(o, c, 'moderator');
    const url = `/v1/communities/${c.id}`;
    expect((await anon().patch(url, { name: 'Nope' })).status).toBe(401);
    expect((await mod.client.patch(url, { name: 'Nope' })).status).toBe(403);
    expect((await (await signup(t)).client.patch(url, { name: 'Nope' })).status).toBe(403);
    expect((await admin.client.patch(url, {})).status).toBe(400);
    expect(
      (
        await admin.client.patch(url, {
          name: 'Renamed',
          description: 'New',
          topics: ['music'],
          rules: [{ title: 'One' }, { title: 'Two', body: 'b' }],
          language: 'de',
        })
      ).status,
    ).toBe(200);
    expect((await o.client.get(url)).body).toMatchObject({
      name: 'Renamed',
      description: 'New',
      topics: ['music'],
      language: 'de',
      rules: [
        { title: 'One', body: '' },
        { title: 'Two', body: 'b' },
      ],
    });
    expect((await admin.client.patch(url, { visibility: 'private' })).status).toBe(403);
    expect(
      (await admin.client.patch(url, { isPaid: true, priceCents: 500, currency: 'USD' })).status,
    ).toBe(403);
    expect((await admin.client.patch(url, { topics: ['bogus'] })).status).toBe(400);
    expect((await o.client.patch(url, { visibility: 'secret', joinPolicy: 'open' })).status).toBe(
      400,
    );
    const s = await o.client.patch(url, { visibility: 'secret' });
    expect(s.body).toMatchObject({ visibility: 'secret', joinPolicy: 'invite' });
    expect((await anon().get(url)).status).toBe(404);
    expect(await auditCount('community.updated', c.id)).toBe(2);
  });
});

describe('governance content: rules, resources, decisions', () => {
  it('resources: CRUD gated by manage_resources and pin gated by pin; pinned first; paginated', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const mod = await addMember(o, c, 'moderator');
    const member = await addMember(o, c);
    const rs = `/v1/communities/${c.id}/resources`;
    expect((await member.client.post(rs, { title: 'x' })).status).toBe(403);
    expect((await anon().post(rs, { title: 'x' })).status).toBe(401);
    expect((await mod.client.post(rs, { title: '' })).status).toBe(400);
    expect((await mod.client.post(rs, { title: 'bad', url: 'javascript:alert(1)' })).status).toBe(
      400,
    );
    const a = (
      await mod.client.post(rs, { title: 'A', url: 'https://example.com/a', body: 'first' })
    ).body;
    const b = (await mod.client.post(rs, { title: 'B' })).body;
    const cc = (await o.client.post(rs, { title: 'C' })).body;
    expect((await member.client.put(`${rs}/${a.id}/pin`, { pinned: true })).status).toBe(403);
    expect((await mod.client.put(`${rs}/${a.id}/pin`, { pinned: true })).status).toBe(200);
    expect((await anon().get(rs)).body.items.map((r: any) => r.title)).toEqual(['A', 'C', 'B']); // public community: anyone reads, pinned first
    const p1 = await member.client.get(rs, { limit: '2' });
    const p2 = await member.client.get(rs, { limit: '2', cursor: p1.body.nextCursor });
    expect([...p1.body.items, ...p2.body.items].map((r: any) => r.title)).toEqual(['A', 'C', 'B']);
    expect((await member.client.patch(`${rs}/${b.id}`, { title: 'Bx' })).status).toBe(403);
    expect(
      (await mod.client.patch(`${rs}/${b.id}`, { title: 'Bx', url: 'https://example.com/b' })).body,
    ).toMatchObject({ title: 'Bx', url: 'https://example.com/b' });
    expect((await mod.client.patch(`${rs}/${b.id}`, { body: 'only body' })).body).toMatchObject({
      title: 'Bx',
      url: 'https://example.com/b',
      body: 'only body',
    });
    expect((await mod.client.del(`${rs}/${cc.id}`)).status).toBe(204);
    expect((await mod.client.del(`${rs}/${cc.id}`)).status).toBe(404);
    expect((await member.client.del(`${rs}/${b.id}`)).status).toBe(403);
    expect((await o.client.get(rs)).body.items.map((r: any) => r.title)).toEqual(['A', 'Bx']);
    // cross-community isolation
    const other = await mk(o);
    expect(
      (await o.client.patch(`/v1/communities/${other.id}/resources/${a.id}`, { title: 'hijack' }))
        .status,
    ).toBe(404);
  });

  it('decisions/FAQ can only be authored by members with moderate or manage_settings', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    const mod = await addMember(o, c, 'moderator');
    const member = await addMember(o, c);
    const outsider = await signup(t);
    const ds = `/v1/communities/${c.id}/decisions`;
    const body = { kind: 'faq', question: 'Where do we meet?', body: 'The library, Fridays.' };
    for (const u of [member, outsider]) expect((await u.client.post(ds, body)).status).toBe(403);
    expect((await anon().post(ds, body)).status).toBe(401);
    expect((await mod.client.post(ds, { kind: 'faq', body: 'no question' })).status).toBe(400);
    expect((await mod.client.post(ds, { kind: 'bogus', body: 'x' })).status).toBe(400);
    const d1 = await mod.client.post(ds, body);
    expect(d1.status).toBe(201);
    expect(d1.body.decidedBy).toBe(mod.id);
    const d2 = await admin.client.post(ds, { kind: 'decision', body: 'We now meet on Saturdays.' });
    expect(d2.status).toBe(201);
    expect((await member.client.patch(`${ds}/${d1.body.id}`, { body: 'hacked' })).status).toBe(403);
    expect(
      (await mod.client.patch(`${ds}/${d1.body.id}`, { body: 'Library, Saturdays.' })).body.body,
    ).toBe('Library, Saturdays.');
    expect((await member.client.del(`${ds}/${d1.body.id}`)).status).toBe(403);
    expect((await anon().get(ds)).body.items).toHaveLength(2);
    expect((await anon().get(ds, { kind: 'faq' })).body.items.map((d: any) => d.id)).toEqual([
      d1.body.id,
    ]);
    const p1 = await member.client.get(ds, { limit: '1' });
    expect(p1.body.nextCursor).toBeTruthy();
    expect(
      (await member.client.get(ds, { limit: '1', cursor: p1.body.nextCursor })).body.items,
    ).toHaveLength(1);
    expect(await auditCount('community.decision.created', c.id)).toBe(2);
    expect((await admin.client.del(`${ds}/${d2.body.id}`)).status).toBe(204);
    expect((await admin.client.del(`${ds}/${d2.body.id}`)).status).toBe(404);
  });

  it('listCommunityKnowledge returns rules, resources and decisions only to active members', async () => {
    const o = await signup(t);
    const c = await mk(o, { rules: [{ title: 'No spam' }] });
    const member = await addMember(o, c);
    const outsider = await signup(t);
    await o.client.post(`/v1/communities/${c.id}/resources`, {
      title: 'Handbook',
      url: 'https://example.com/hb',
    });
    await o.client.post(`/v1/communities/${c.id}/decisions`, {
      kind: 'decision',
      body: 'Decided X.',
    });
    const k = await listCommunityKnowledge(t.ctx, c.id, member.id);
    expect(k).toMatchObject({
      communityId: c.id,
      rules: [{ title: 'No spam' }],
      resources: [{ title: 'Handbook' }],
      decisions: [{ kind: 'decision', body: 'Decided X.' }],
    });
    expect(await listCommunityKnowledge(t.ctx, c.id, outsider.id)).toBeNull();
    // banned / left users lose access
    await o.client.post(`/v1/communities/${c.id}/members/${member.id}/ban`, {});
    expect(await listCommunityKnowledge(t.ctx, c.id, member.id)).toBeNull();
    expect(
      await listCommunityKnowledge(t.ctx, '00000000-0000-4000-8000-000000000000', o.id),
    ).toBeNull();
  });
});

describe('channels', () => {
  it('requires manage_channels to create/rename/archive; only members list channels', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    const mod = await addMember(o, c, 'moderator');
    const member = await addMember(o, c);
    const outsider = await signup(t);
    const base = `/v1/communities/${c.id}/channels`;

    expect((await anon().get(base)).status).toBe(401);
    expect((await outsider.client.get(base)).status).toBe(403);
    for (const u of [mod, member, outsider])
      expect((await u.client.post(base, { name: 'chat' })).status).toBe(403);
    expect((await admin.client.post(base, { name: 'Bad Name!' })).status).toBe(400);
    const chat = await admin.client.post(base, { name: 'chat' });
    expect(chat).toMatchObject({
      status: 201,
      body: { name: 'chat', kind: 'text', archived: false },
    });
    const voice = await o.client.post(base, { name: 'lounge', kind: 'voice' });
    expect(voice.body.kind).toBe('voice');
    expect((await admin.client.post(base, { name: 'chat' })).status).toBe(409);
    // rows are real `conversations` records for the messaging module
    const row = await t.ctx.db.query(
      'SELECT kind, community_id, channel_name, channel_kind FROM conversations WHERE id = $1',
      [chat.body.id],
    );
    expect(row.rows[0]).toEqual({
      kind: 'community_channel',
      community_id: c.id,
      channel_name: 'chat',
      channel_kind: 'text',
    });

    expect((await member.client.get(base)).body.items.map((ch: any) => ch.name)).toEqual([
      'general',
      'chat',
      'lounge',
    ]);
    expect((await member.client.patch(`${base}/${chat.body.id}`, { name: 'talk' })).status).toBe(
      403,
    );
    expect((await admin.client.patch(`${base}/${chat.body.id}`, {})).status).toBe(400);
    expect((await admin.client.patch(`${base}/${chat.body.id}`, { name: 'general' })).status).toBe(
      409,
    );
    expect((await admin.client.patch(`${base}/${chat.body.id}`, { name: 'talk' })).body.name).toBe(
      'talk',
    );
    expect(
      (await admin.client.patch(`${base}/${voice.body.id}`, { archived: true })).body.archived,
    ).toBe(true);
    // members no longer see archived channels; managers still can (to unarchive)
    expect((await member.client.get(base)).body.items.map((ch: any) => ch.name)).toEqual([
      'general',
      'talk',
    ]);
    expect((await admin.client.get(base)).body.items).toHaveLength(3);
    // an archived channel's name can be reused
    expect((await admin.client.post(base, { name: 'lounge' })).status).toBe(201);
    expect((await admin.client.patch(`${base}/${voice.body.id}`, { archived: false })).status).toBe(
      409,
    );
    // channels of another community are untouchable
    const other = await mk(o);
    expect(
      (
        await o.client.patch(`/v1/communities/${other.id}/channels/${chat.body.id}`, {
          name: 'zzz',
        })
      ).status,
    ).toBe(404);
    expect(await auditCount('community.channel.created', c.id)).toBe(3);
  });
});

describe('community content & moderation', () => {
  it('community posts respect membership across all states', async () => {
    const o = await signup(t);
    const pub = await mk(o);
    const priv = await mk(o, { visibility: 'private' });
    const outsider = await signup(t);
    const m = await addMember(o, priv);

    // posting requires active membership
    expect(
      (await outsider.client.post('/v1/posts', { body: 'hi', communityId: priv.id })).status,
    ).toBe(403);
    expect(
      (await outsider.client.post('/v1/posts', { body: 'hi', communityId: pub.id })).status,
    ).toBe(403);
    const pp = await post(m, priv.id, 'inside the private community');
    const bp = await post(o, pub.id, 'public community post');
    const seen = async (u: Client, id: string) => (await u.get(`/v1/posts/${id}`)).status === 200;
    expect(await seen(m.client, pp.id)).toBe(true);
    expect(await seen(o.client, pp.id)).toBe(true);
    expect(await seen(outsider.client, pp.id)).toBe(false);
    expect(await seen(anon(), pp.id)).toBe(false);
    expect(await seen(anon(), bp.id)).toBe(true);
    // feed
    expect(
      (await m.client.get(`/v1/communities/${priv.id}/feed`)).body.items.map((i: any) => i.id),
    ).toEqual([pp.id]);
    expect((await m.client.get(`/v1/communities/${priv.id}/feed`)).body.items[0]).toMatchObject({
      communityId: priv.id,
      visibility: 'community',
      author: { id: m.id },
    });
    expect(
      (await anon().get(`/v1/communities/${pub.id}/feed`)).body.items.map((i: any) => i.id),
    ).toEqual([bp.id]);
    // leaving revokes access to private posts immediately; rejoining via approval restores it
    await m.client.post(`/v1/communities/${priv.id}/leave`);
    expect(await seen(m.client, pp.id)).toBe(true); // author always sees their own posts
    const m2 = await addMember(o, priv);
    expect(await seen(m2.client, pp.id)).toBe(true);
    await o.client.del(`/v1/communities/${priv.id}/members/${m2.id}`);
    expect(await seen(m2.client, pp.id)).toBe(false);
    expect((await m2.client.get(`/v1/communities/${priv.id}/feed`)).status).toBe(403);
  });

  it('keyset-paginates the community feed', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await post(o, c.id, `feed post ${i}`)).id);
    const p1 = await o.client.get(`/v1/communities/${c.id}/feed`, { limit: '2' });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await o.client.get(`/v1/communities/${c.id}/feed`, {
      limit: '2',
      cursor: p1.body.nextCursor,
    });
    expect(p2.body.items).toHaveLength(1);
    expect([...p1.body.items, ...p2.body.items].map((i: any) => i.id)).toEqual([...ids].reverse());
    expect((await o.client.get(`/v1/communities/${c.id}/feed`, { cursor: 'garbage' })).status).toBe(
      400,
    );
  });

  it('moderators remove posts and comments with an audit trail and author notification', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const admin = await addMember(o, c, 'admin');
    const mod = await addMember(o, c, 'moderator');
    const author = await addMember(o, c);
    const other = await addMember(o, c);
    const outsider = await signup(t);
    const p = await post(author, c.id, 'a post that will be removed');
    const ownerPost = await post(o, c.id, 'owner post');
    const modPost = await post(mod, c.id, 'mod post');
    const rm = (u: TestUser | null, id: string, body?: unknown) =>
      (u?.client ?? anon()).del(`/v1/communities/${c.id}/posts/${id}`, body);

    expect((await rm(null, p.id)).status).toBe(401);
    expect((await rm(outsider, p.id)).status).toBe(403);
    expect((await rm(other, p.id)).status).toBe(403);
    expect((await rm(author, p.id)).status).toBe(403); // authors use DELETE /v1/posts/:id
    expect((await rm(mod, ownerPost.id)).status).toBe(403); // hierarchy
    expect((await rm(admin, ownerPost.id)).status).toBe(403);
    expect((await rm(admin, modPost.id)).status).toBe(204);
    expect((await rm(mod, p.id, { reason: 'off topic' })).status).toBe(204);
    expect((await rm(mod, p.id)).status).toBe(404);
    expect((await author.client.get(`/v1/posts/${p.id}`)).status).toBe(404);
    expect((await o.client.get(`/v1/posts/${p.id}`)).status).toBe(404);
    expect(
      (await o.client.get(`/v1/communities/${c.id}/feed`)).body.items.map((i: any) => i.id),
    ).toEqual([ownerPost.id]);
    expect(await auditCount('community.post.removed', p.id)).toBe(1);
    const rowMeta = await t.ctx.db.query(
      `SELECT actor_id, metadata FROM audit_logs WHERE action = 'community.post.removed' AND target_id = $1`,
      [p.id],
    );
    expect(rowMeta.rows[0].actor_id).toBe(mod.id);
    expect(rowMeta.rows[0].metadata).toMatchObject({ communityId: c.id, reason: 'off topic' });
    expect(await notifCount(author.id, 'community_content_removed')).toBe(1);
    expect((await o.client.del(`/v1/communities/${c.id}/posts/${ownerPost.id}`)).status).toBe(204); // owner may remove own via moderation too

    // a post from another community cannot be removed through this one
    const c2 = await mk(o);
    const foreign = await post(o, c2.id, 'elsewhere');
    expect((await rm(o, foreign.id)).status).toBe(404);

    // comments
    const cp = await post(o, c.id, 'comment on me');
    const cm = await author.client.post(`/v1/posts/${cp.id}/comments`, { body: 'a comment' });
    expect(cm.status).toBe(201);
    const ownerComment = await o.client.post(`/v1/posts/${cp.id}/comments`, {
      body: 'owner comment',
    });
    const rc = (u: TestUser, id: string) => u.client.del(`/v1/communities/${c.id}/comments/${id}`);
    expect((await rc(other, cm.body.id)).status).toBe(403);
    expect((await rc(mod, ownerComment.body.id)).status).toBe(403);
    expect((await rc(mod, cm.body.id)).status).toBe(204);
    expect((await rc(mod, cm.body.id)).status).toBe(404);
    expect((await o.client.get(`/v1/posts/${cp.id}`)).body.counts.comments).toBe(1);
    expect(await auditCount('community.comment.removed', cm.body.id)).toBe(1);
    expect(await notifCount(author.id, 'community_content_removed')).toBe(2);
  });

  it('queues risky posts for review and lets moderators approve or reject them', async () => {
    const o = await signup(t);
    const c = await mk(o);
    const mod = await addMember(o, c, 'moderator');
    const author = await addMember(o, c);
    const viewer = await addMember(o, c);
    const outsider = await signup(t);
    const q = `/v1/communities/${c.id}/moderation/queue`;

    const risky = await post(author, c.id, 'Join now for guaranteed risk-free profit!!');
    const restricted = await post(author, c.id, "Don't tell your mom about our little secret");
    const fine = await post(author, c.id, 'A perfectly normal post');
    expect((await author.client.get(`/v1/posts/${risky.id}`)).body.moderationStatus).toBe(
      'pending_review',
    );
    expect((await author.client.get(`/v1/posts/${restricted.id}`)).body.moderationStatus).toBe(
      'restricted',
    );
    // not visible to other members while pending
    expect((await viewer.client.get(`/v1/posts/${risky.id}`)).status).toBe(404);
    expect(
      (await viewer.client.get(`/v1/communities/${c.id}/feed`)).body.items.map((i: any) => i.id),
    ).toEqual([fine.id]);

    // queue permissions
    expect((await anon().get(q)).status).toBe(401);
    for (const u of [viewer, author, outsider]) expect((await u.client.get(q)).status).toBe(403);
    const all = await mod.client.get(q);
    expect(all.body.items.map((i: any) => i.id).sort()).toEqual([risky.id, restricted.id].sort());
    expect(
      (await mod.client.get(q, { state: 'restricted' })).body.items.map((i: any) => i.id),
    ).toEqual([restricted.id]);
    expect(
      (await mod.client.get(q, { state: 'pending_review' })).body.items.map((i: any) => i.id),
    ).toEqual([risky.id]);
    expect((await mod.client.get(q, { state: 'removed' })).status).toBe(400);
    const pg = await mod.client.get(q, { limit: '1' });
    expect(pg.body.nextCursor).toBeTruthy();
    expect(
      (await mod.client.get(q, { limit: '1', cursor: pg.body.nextCursor })).body.items,
    ).toHaveLength(1);

    const act = (u: TestUser, action: 'approve' | 'reject', id: string) =>
      u.client.post(`/v1/communities/${c.id}/moderation/posts/${id}/${action}`, {});
    expect((await act(viewer, 'approve', risky.id)).status).toBe(403);
    expect((await act(outsider, 'reject', risky.id)).status).toBe(403);
    expect((await act(mod, 'approve', fine.id)).status).toBe(404); // not queued
    expect((await act(mod, 'approve', risky.id)).body.moderationStatus).toBe('approved');
    expect((await act(mod, 'approve', risky.id)).status).toBe(404);
    expect((await viewer.client.get(`/v1/posts/${risky.id}`)).status).toBe(200);
    expect(await notifCount(author.id, 'community_post_approved')).toBe(1);
    expect((await act(mod, 'reject', restricted.id)).body.moderationStatus).toBe('removed');
    expect((await author.client.get(`/v1/posts/${restricted.id}`)).status).toBe(404);
    expect(await notifCount(author.id, 'community_content_removed')).toBe(1);
    expect((await mod.client.get(q)).body.items).toEqual([]);
    expect(await auditCount('community.post.approved', risky.id)).toBe(1);
    expect(await auditCount('community.post.rejected', restricted.id)).toBe(1);
  });
});

describe('paid communities', () => {
  it('configures price, answers 402 payment_required on every self-service path, and grants via the service only', async () => {
    const o = await signup(t);
    const c = await mk(o, { isPaid: true, priceCents: 1500, currency: 'usd' });
    const view = await anon().get(`/v1/communities/${c.id}`);
    expect(view.body).toMatchObject({ isPaid: true, priceCents: 1500, currency: 'USD' });

    const u = await signup(t);
    const j = await u.client.post(`/v1/communities/${c.id}/join`);
    expect(j.status).toBe(402);
    expect(j.body.error).toMatchObject({
      code: 'payment_required',
      details: { priceCents: 1500, currency: 'USD' },
    });
    expect(await dbCount(c.id)).toBe(1);
    expect((await u.client.get(`/v1/communities/${c.id}`)).body.viewer).toBeNull();

    // invited users must also pay; managers cannot approve around the paywall
    const inv = await signup(t);
    await o.client.post(`/v1/communities/${c.id}/invitations`, { userId: inv.id });
    expect((await inv.client.post(`/v1/communities/${c.id}/invitation/accept`)).status).toBe(402);
    expect((await inv.client.post(`/v1/communities/${c.id}/join`)).status).toBe(402);

    // only the owner configures money settings
    const adm = await signup(t);
    await grantCommunityMembership(t.ctx, c.id, adm.id);
    await o.client.put(`/v1/communities/${c.id}/members/${adm.id}/role`, { roleKey: 'admin' });
    expect((await adm.client.patch(`/v1/communities/${c.id}`, { priceCents: 5000 })).status).toBe(
      403,
    );
    expect((await o.client.patch(`/v1/communities/${c.id}`, { priceCents: 10 })).status).toBe(400);
    expect(
      (await o.client.patch(`/v1/communities/${c.id}`, { priceCents: 2500 })).body,
    ).toMatchObject({ priceCents: 2500, currency: 'USD' });

    // grant: idempotent, updates member_count once, refuses banned users and unknown users
    expect(await grantCommunityMembership(t.ctx, c.id, u.id)).toEqual({
      status: 'active',
      created: true,
    });
    expect(await grantCommunityMembership(t.ctx, c.id, u.id)).toEqual({
      status: 'active',
      created: false,
    });
    expect((await u.client.get(`/v1/communities/${c.id}`)).body.viewer.status).toBe('active');
    expect((await u.client.post(`/v1/communities/${c.id}/join`)).body.status).toBe('active'); // already a member: no second charge
    expect(await dbCount(c.id)).toBe(await realCount(c.id));
    const bad = await signup(t);
    await o.client.post(`/v1/communities/${c.id}/members/${bad.id}/ban`, {});
    await expect(grantCommunityMembership(t.ctx, c.id, bad.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      grantCommunityMembership(t.ctx, c.id, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      grantCommunityMembership(t.ctx, '00000000-0000-4000-8000-000000000000', u.id),
    ).rejects.toMatchObject({ code: 'not_found' });

    // turning payment off clears the price and reopens self-service joins
    expect((await o.client.patch(`/v1/communities/${c.id}`, { isPaid: false })).body).toMatchObject(
      { isPaid: false, priceCents: null, currency: null },
    );
    expect((await (await signup(t)).client.post(`/v1/communities/${c.id}/join`)).status).toBe(200);
  });

  it('grant refuses teens for secret communities and works for private ones', async () => {
    const o = await signup(t);
    const secret = await mk(o, { visibility: 'secret' });
    const priv = await mk(o, { visibility: 'private' });
    const teen = await signup(t, { birthDate: teenBirth() });
    await expect(grantCommunityMembership(t.ctx, secret.id, teen.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await grantCommunityMembership(t.ctx, priv.id, teen.id)).created).toBe(true);
  });
});

describe('account deletion hook', () => {
  const runHooks = (userId: string) =>
    withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, userId);
    });

  it('hands ownerless communities to the highest-ranked member and soft-deletes sole-member ones', async () => {
    const o = await signup(t);
    const shared = await mk(o);
    const mod = await addMember(o, shared, 'moderator');
    const admin = await addMember(o, shared, 'admin');
    const plain = await addMember(o, shared);
    const solo = await mk(o);
    const priv = await mk(o, { visibility: 'private' });
    const applicant = await signup(t);
    await applicant.client.post(`/v1/communities/${priv.id}/join`); // pending on a community o solely owns
    // o is also a plain member of someone else's community: that membership simply goes away
    const other = await signup(t);
    const foreign = await mk(other);
    await o.client.post(`/v1/communities/${foreign.id}/join`);
    expect(await dbCount(foreign.id)).toBe(2);

    await runHooks(o.id);

    const asAdmin = await admin.client.get(`/v1/communities/${shared.id}`);
    expect(asAdmin.body.viewer.roleKey).toBe('owner');
    expect(asAdmin.body.memberCount).toBe(3);
    expect((await mod.client.get(`/v1/communities/${shared.id}`)).body.viewer.roleKey).toBe(
      'moderator',
    );
    expect((await plain.client.get(`/v1/communities/${shared.id}`)).body.viewer.roleKey).toBe(
      'member',
    );
    expect(await dbCount(shared.id)).toBe(await realCount(shared.id));
    expect((await anon().get(`/v1/communities/${solo.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/communities/${priv.id}`)).status).toBe(404); // sole active member => soft-deleted
    expect(await dbCount(foreign.id)).toBe(1);
    const left = await t.ctx.db.query('SELECT 1 FROM community_members WHERE user_id = $1', [o.id]);
    expect(left.rowCount).toBe(0);
    // the community owned by someone else still has its owner
    expect((await other.client.get(`/v1/communities/${foreign.id}`)).body.viewer.roleKey).toBe(
      'owner',
    );
    // exactly one owner remains
    const owners = await t.ctx.db.query(
      `SELECT count(*)::int AS n FROM community_members WHERE community_id = $1 AND role_key = 'owner'`,
      [shared.id],
    );
    expect(owners.rows[0].n).toBe(1);
  });
});
