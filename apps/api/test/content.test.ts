import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const follow = (a: TestUser, b: TestUser) => a.client.put(`/v1/users/${b.username}/follow`);
async function befriend(a: TestUser, b: TestUser) {
  await a.client.post('/v1/friends/requests', { username: b.username });
  await b.client.post(`/v1/friends/requests/${a.id}/accept`);
}
const post = async (u: TestUser, body: Record<string, unknown>) => {
  const r = await u.client.post('/v1/posts', body);
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const canSee = async (viewer: Client, id: string) =>
  (await viewer.get(`/v1/posts/${id}`)).status === 200;

async function createCommunity(owner: TestUser, visibility: 'public' | 'private') {
  const slug = uniq('c') + 'x';
  const { rows } = await t.ctx.db.query<{ id: string }>(
    `INSERT INTO communities (slug, name, visibility, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [slug, `Community ${slug}`, visibility, owner.id],
  );
  const id = rows[0]!.id;
  for (const [key, rank, perms] of [
    ['owner', 100, ['post', 'comment', 'moderate']],
    ['member', 10, ['post', 'comment']],
  ] as const) {
    await t.ctx.db.query(
      `INSERT INTO community_roles (community_id, key, name, permissions, is_system, rank) VALUES ($1,$2,$2,$3,true,$4)`,
      [id, key, perms as unknown as string[], rank],
    );
  }
  await t.ctx.db.query(
    `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'owner','active',now())`,
    [id, owner.id],
  );
  return id;
}
const addMember = (communityId: string, u: TestUser, status = 'active') =>
  t.ctx.db.query(
    `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'member',$3,now())`,
    [communityId, u.id, status],
  );

describe('post lifecycle', () => {
  it('creates, reads, edits and soft-deletes a post', async () => {
    const a = await signup(t);
    const p = await post(a, {
      body: 'Hello YAPILAPI #first',
      visibility: 'public',
      topics: ['technology'],
    });
    expect(p).toMatchObject({
      kind: 'text',
      visibility: 'public',
      topics: ['Technology'],
      counts: { likes: 0, comments: 0 },
    });
    expect((await new Client(t).get(`/v1/posts/${p.id}`)).status).toBe(200);
    expect((await a.client.patch(`/v1/posts/${p.id}`, { body: 'Edited' })).status).toBe(200);
    expect((await a.client.get(`/v1/posts/${p.id}`)).body.editedAt).toBeTruthy();
    const b = await signup(t);
    expect((await b.client.patch(`/v1/posts/${p.id}`, { body: 'hijack' })).status).toBe(404);
    expect((await b.client.del(`/v1/posts/${p.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/posts/${p.id}`)).status).toBe(204);
    expect((await a.client.get(`/v1/posts/${p.id}`)).status).toBe(404);
  });

  it('validates inputs', async () => {
    const a = await signup(t);
    expect((await a.client.post('/v1/posts', { body: '' })).status).toBe(400);
    expect((await a.client.post('/v1/posts', { body: 'x', visibility: 'circle' })).status).toBe(
      400,
    );
    expect((await a.client.post('/v1/posts', { body: 'x', visibility: 'selected' })).status).toBe(
      400,
    );
    expect((await a.client.post('/v1/posts', { body: 'x', topics: ['nope-topic'] })).status).toBe(
      400,
    );
    expect(
      (await a.client.post('/v1/posts', { body: 'x', linkUrl: 'javascript:alert(1)' })).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/posts', {
          body: 'x',
          mediaIds: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/posts', {
          body: 'x',
          poll: { question: 'q', options: ['only one'] },
        })
      ).status,
    ).toBe(400);
    expect((await new Client(t).post('/v1/posts', { body: 'x' })).status).toBe(401);
  });

  it('teens cannot post publicly', async () => {
    const teen = await signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-02-02` });
    expect((await teen.client.post('/v1/posts', { body: 'hi', visibility: 'public' })).status).toBe(
      422,
    );
    expect((await teen.client.post('/v1/posts', { body: 'hi' })).status).toBe(201); // defaults to followers
  });

  it('attaches owned media only, once', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const mk = async (u: TestUser) =>
      (
        await t.ctx.db.query<{ id: string }>(
          `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status) VALUES ($1,'image',$2,'image/jpeg',1000,'ready') RETURNING id`,
          [u.id, `k/${uniq('m')}.jpg`],
        )
      ).rows[0]!.id;
    const mine = await mk(a);
    const theirs = await mk(b);
    expect((await a.client.post('/v1/posts', { body: 'stolen', mediaIds: [theirs] })).status).toBe(
      400,
    );
    const ok = await a.client.post('/v1/posts', {
      body: 'pic',
      mediaIds: [mine],
      visibility: 'public',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe('photo');
    expect(ok.body.media[0].url).toContain('/media/');
    expect((await a.client.post('/v1/posts', { body: 'again', mediaIds: [mine] })).status).toBe(
      400,
    );
  });
});

describe('visibility matrix', () => {
  it('enforces every audience rule for every kind of viewer', async () => {
    const author = await signup(t);
    const follower = await signup(t);
    const friend = await signup(t);
    const circleMember = await signup(t);
    const selected = await signup(t);
    const stranger = await signup(t);
    const blocked = await signup(t);
    const anon = new Client(t);

    await follow(follower, author);
    await befriend(author, friend);
    const circle = (await author.client.post('/v1/circles', { kind: 'close_friends', name: 'CF' }))
      .body;
    await author.client.put(`/v1/circles/${circle.id}/members/${circleMember.id}`);
    await author.client.put(`/v1/users/${blocked.username}/block`);

    const pubP = await post(author, { body: 'public', visibility: 'public' });
    const folP = await post(author, { body: 'followers', visibility: 'followers' });
    const friP = await post(author, { body: 'friends', visibility: 'friends' });
    const cirP = await post(author, { body: 'circle', visibility: 'circle', circleId: circle.id });
    const selP = await post(author, {
      body: 'selected',
      visibility: 'selected',
      audience: [selected.id],
    });
    const privP = await post(author, { body: 'private', visibility: 'private' });

    const matrix: Array<[string, Client, boolean[]]> = [
      //                     pub    fol    fri    cir    sel    priv
      ['author', author.client, [true, true, true, true, true, true]],
      ['follower', follower.client, [true, true, false, false, false, false]],
      ['friend', friend.client, [true, false, true, false, false, false]],
      ['circle member', circleMember.client, [true, false, false, true, false, false]],
      ['selected', selected.client, [true, false, false, false, true, false]],
      ['stranger', stranger.client, [true, false, false, false, false, false]],
      ['blocked', blocked.client, [false, false, false, false, false, false]],
      ['anonymous', anon, [true, false, false, false, false, false]],
    ];
    const posts = [pubP, folP, friP, cirP, selP, privP];
    for (const [who, client, expected] of matrix) {
      const actual = await Promise.all(posts.map((p) => canSee(client, p.id)));
      expect({ who, actual }).toEqual({ who, actual: expected });
    }
    // Profile listings obey the same rules.
    const listed = async (c: Client) =>
      (await c.get(`/v1/users/${author.username}/posts`)).body.items?.map((p: any) => p.body) ??
      null;
    expect(await listed(stranger.client)).toEqual(['public']);
    expect((await listed(friend.client)).sort()).toEqual(['friends', 'public']);
    expect(await listed(blocked.client)).toBeNull(); // 404
  });

  it('hides all posts of a private account (even "public" ones) from non-followers', async () => {
    const a = await signup(t);
    const stranger = await signup(t);
    const fol = await signup(t);
    await a.client.patch('/v1/profile', { isPrivate: true });
    const p = await post(a, { body: 'quiet', visibility: 'public' });
    expect(await canSee(stranger.client, p.id)).toBe(false);
    expect(await canSee(new Client(t), p.id)).toBe(false);
    await follow(fol, a);
    await a.client.post(`/v1/follow-requests/${fol.id}/approve`);
    expect(await canSee(fol.client, p.id)).toBe(true);
  });

  it('community posts: public communities are readable, private ones members-only, banned members excluded', async () => {
    const owner = await signup(t);
    const member = await signup(t);
    const outsider = await signup(t);
    const banned = await signup(t);
    const pub = await createCommunity(owner, 'public');
    const priv = await createCommunity(owner, 'private');
    await addMember(pub, member);
    await addMember(priv, member);
    await addMember(pub, banned, 'banned');
    const pp = await post(owner, { body: 'in public community', communityId: pub });
    const qp = await post(owner, { body: 'in private community', communityId: priv });
    expect(pp.visibility).toBe('community');
    expect(await canSee(outsider.client, pp.id)).toBe(true);
    expect(await canSee(new Client(t), pp.id)).toBe(true);
    expect(await canSee(banned.client, pp.id)).toBe(false);
    expect(await canSee(outsider.client, qp.id)).toBe(false);
    expect(await canSee(member.client, qp.id)).toBe(true);
    // posting requires membership with the post permission
    expect(
      (await outsider.client.post('/v1/posts', { body: 'let me in', communityId: priv })).status,
    ).toBe(403);
    expect(
      (await member.client.post('/v1/posts', { body: 'member post', communityId: priv })).status,
    ).toBe(201);
    // outsiders may read but not comment on public community posts
    expect((await outsider.client.post(`/v1/posts/${pp.id}/comments`, { body: 'hi' })).status).toBe(
      403,
    );
    expect((await member.client.post(`/v1/posts/${pp.id}/comments`, { body: 'hi' })).status).toBe(
      201,
    );
  });

  it('a block hides content in both directions', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const pa = await post(a, { body: 'from a', visibility: 'public' });
    const pb = await post(b, { body: 'from b', visibility: 'public' });
    await a.client.put(`/v1/users/${b.username}/block`);
    expect(await canSee(b.client, pa.id)).toBe(false);
    expect(await canSee(a.client, pb.id)).toBe(false);
  });
});

describe('engagement', () => {
  it('reactions are idempotent, change kind without double counting, and update counts', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const p = await post(a, { body: 'like me', visibility: 'public' });
    expect((await b.client.put(`/v1/posts/${p.id}/reaction`, { kind: 'like' })).body.likes).toBe(1);
    expect((await b.client.put(`/v1/posts/${p.id}/reaction`, { kind: 'like' })).body.likes).toBe(1);
    expect((await b.client.put(`/v1/posts/${p.id}/reaction`, { kind: 'love' })).body.likes).toBe(1);
    expect((await b.client.get(`/v1/posts/${p.id}`)).body.viewer.reaction).toBe('love');
    expect((await b.client.del(`/v1/posts/${p.id}/reaction`)).status).toBe(204);
    expect((await b.client.del(`/v1/posts/${p.id}/reaction`)).status).toBe(204);
    expect((await a.client.get(`/v1/posts/${p.id}`)).body.counts.likes).toBe(0);
    const n = await t.ctx.db.query(`SELECT kind FROM notifications WHERE user_id = $1`, [a.id]);
    expect(n.rows.length).toBe(1);
    const priv = await post(a, { body: 'nope', visibility: 'private' });
    expect((await b.client.put(`/v1/posts/${priv.id}/reaction`, { kind: 'like' })).status).toBe(
      404,
    );
  });

  it('saves posts and lists them; unsaving works', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const p = await post(a, { body: 'keep', visibility: 'public' });
    await b.client.put(`/v1/posts/${p.id}/save`, {});
    expect((await b.client.get('/v1/saved')).body.items.map((x: any) => x.id)).toEqual([p.id]);
    expect((await b.client.get(`/v1/posts/${p.id}`)).body.viewer.saved).toBe(true);
    await b.client.del(`/v1/posts/${p.id}/save`);
    expect((await b.client.get('/v1/saved')).body.items).toEqual([]);
  });

  it('polls: single vote, option validation, counts', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const p = await post(a, {
      body: '',
      visibility: 'public',
      poll: { question: 'Tea or coffee?', options: ['Tea', 'Coffee'] },
    });
    expect(p.kind).toBe('poll');
    const [tea, coffee] = p.poll.options;
    expect(
      (await b.client.post(`/v1/posts/${p.id}/poll/vote`, { optionIds: [tea.id, coffee.id] }))
        .status,
    ).toBe(400);
    const v = await b.client.post(`/v1/posts/${p.id}/poll/vote`, { optionIds: [tea.id] });
    expect(v.status).toBe(200);
    expect(v.body.totalVotes).toBe(1);
    expect(v.body.myVotes).toEqual([tea.id]);
    expect(
      (await b.client.post(`/v1/posts/${p.id}/poll/vote`, { optionIds: [coffee.id] })).status,
    ).toBe(409);
  });

  it('comments: threads, counts, ownership-based deletion, restrictions and edits', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const p = await post(a, { body: 'discuss', visibility: 'public' });
    const c1 = (await b.client.post(`/v1/posts/${p.id}/comments`, { body: 'first' })).body;
    const r1 = (
      await c.client.post(`/v1/posts/${p.id}/comments`, { body: 'reply', parentId: c1.id })
    ).body;
    const r2 = (
      await a.client.post(`/v1/posts/${p.id}/comments`, { body: 'nested', parentId: r1.id })
    ).body;
    expect(r2.parentId).toBe(c1.id); // flattened to thread root
    expect((await a.client.get(`/v1/posts/${p.id}`)).body.counts.comments).toBe(3);
    const top = (await c.client.get(`/v1/posts/${p.id}/comments`)).body;
    expect(top.items.length).toBe(1);
    expect(top.items[0].counts.replies).toBe(2);
    expect(
      (await c.client.get(`/v1/comments/${c1.id}/replies`)).body.items.map((x: any) => x.body),
    ).toEqual(['reply', 'nested']);
    expect((await c.client.del(`/v1/comments/${c1.id}`)).status).toBe(404); // not yours
    expect((await b.client.patch(`/v1/comments/${c1.id}`, { body: 'first (edited)' })).status).toBe(
      200,
    );
    expect((await a.client.del(`/v1/comments/${r1.id}`)).status).toBe(204); // post author may delete
    expect((await a.client.get(`/v1/posts/${p.id}`)).body.counts.comments).toBe(2);

    // restricted commenters are visible only to themselves and the post author until approved
    await a.client.put(`/v1/users/${c.username}/restrict`);
    const hidden = (await c.client.post(`/v1/posts/${p.id}/comments`, { body: 'sneaky' })).body;
    expect(hidden.pendingApproval).toBe(true);
    const seenBy = async (u: TestUser | Client) =>
      (
        (await (u instanceof Client ? u : u.client).get(`/v1/posts/${p.id}/comments`)).body
          .items as any[]
      ).some((x) => x.id === hidden.id);
    expect(await seenBy(b)).toBe(false);
    expect(await seenBy(c)).toBe(true);
    expect(await seenBy(a)).toBe(true);
    expect((await a.client.post(`/v1/comments/${hidden.id}/approve`)).status).toBe(200);
    expect(await seenBy(b)).toBe(true);
  });

  it('paginates with stable cursors', async () => {
    const a = await signup(t);
    for (let i = 0; i < 7; i++) await post(a, { body: `p${i}`, visibility: 'public' });
    const c = new Client(t);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await c.get(`/v1/users/${a.username}/posts`, {
        limit: '3',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...r.body.items.map((x: any) => x.body));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(['p6', 'p5', 'p4', 'p3', 'p2', 'p1', 'p0']);
    expect((await c.get(`/v1/users/${a.username}/posts`, { cursor: 'garbage' })).status).toBe(400);
  });
});

describe('moderation on publish', () => {
  it('restricts risky posts, opens a case, and hides them from others', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const p = await post(a, { body: 'I will kill you tomorrow', visibility: 'public' });
    expect(p.moderationStatus).toBe('escalated');
    expect(await canSee(b.client, p.id)).toBe(false);
    expect(await canSee(a.client, p.id)).toBe(true); // author still sees it and its status
    const cases = await t.ctx.db.query(
      `SELECT state, risk_level, categories FROM moderation_cases WHERE target_id = $1`,
      [p.id],
    );
    expect(cases.rows[0]).toMatchObject({
      state: 'escalated',
      risk_level: 'critical',
      categories: ['threat'],
    });
  });
});

describe('feeds', () => {
  it('following/friends/communities/custom/local feeds contain exactly the right posts', async () => {
    const me = await signup(t);
    const fol = await signup(t);
    const fri = await signup(t);
    const other = await signup(t);
    const muted = await signup(t);
    await follow(me, fol);
    await befriend(me, fri);
    await follow(me, muted);
    await me.client.put(`/v1/users/${muted.username}/mute`);
    const own = await post(me, { body: 'mine', visibility: 'public' });
    const pf = await post(fol, {
      body: 'from followed',
      visibility: 'public',
      latitude: 6.5244,
      longitude: 3.3792,
      topics: ['technology'],
    });
    const pfr = await post(fri, { body: 'friends only', visibility: 'friends' });
    const po = await post(other, { body: 'from other', visibility: 'public' });
    const pm = await post(muted, { body: 'from muted', visibility: 'public' });
    const ids = async (params: Record<string, string>) =>
      ((await me.client.get('/v1/feed', params)).body.items as any[]).map((x) => x.id);

    const following = await ids({ mode: 'following' });
    expect(following).toContain(pf.id);
    expect(following).toContain(own.id);
    expect(following).not.toContain(po.id);
    expect(following).not.toContain(pm.id); // muted excluded
    expect(await ids({ mode: 'friends' })).toEqual([pfr.id]);

    const cid = await createCommunity(other, 'public');
    await addMember(cid, me);
    const cp = await post(other, { body: 'community news', communityId: cid });
    expect(await ids({ mode: 'communities' })).toEqual([cp.id]);

    const circle = (await me.client.post('/v1/circles', { kind: 'custom', name: 'Watch' })).body;
    await me.client.put(`/v1/circles/${circle.id}/members/${fol.id}`);
    expect(await ids({ mode: 'custom', circleId: circle.id })).toEqual([pf.id]);
    expect(await ids({ mode: 'custom', topics: 'technology' })).toContain(pf.id);
    expect((await me.client.get('/v1/feed', { mode: 'custom' })).status).toBe(400);

    const near = await ids({ mode: 'local', lat: '6.45', lng: '3.40', radiusKm: '25' });
    expect(near).toEqual([pf.id]);
    expect(await ids({ mode: 'local', lat: '51.5', lng: '-0.12', radiusKm: '25' })).toEqual([]);
    expect((await me.client.get('/v1/feed', { mode: 'local' })).status).toBe(400);
    expect((await new Client(t).get('/v1/feed', { mode: 'following' })).status).toBe(403);
  });

  it('for_you is personalised, explainable, paginated without duplicates, and respects feedback', async () => {
    const me = await signup(t);
    const authors = [await signup(t), await signup(t), await signup(t)];
    await me.client.put('/v1/profile/interests', { topics: ['cybersecurity'] });
    await follow(me, authors[0]!);
    const on = await post(authors[1]!, {
      body: 'zero trust basics',
      visibility: 'public',
      topics: ['cybersecurity'],
    });
    const off = await post(authors[2]!, {
      body: 'random',
      visibility: 'public',
      topics: ['fashion'],
    });
    const fp = await post(authors[0]!, { body: 'followed author post', visibility: 'public' });
    for (let i = 0; i < 6; i++)
      await post(authors[i % 3]!, { body: `filler ${i}`, visibility: 'public' });

    const first = (await me.client.get('/v1/feed', { mode: 'for_you', limit: '4' })).body;
    expect(first.items.length).toBe(4);
    const all: any[] = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = (await me.client.get('/v1/feed', { mode: 'for_you', limit: '4', cursor })).body;
      all.push(...next.items);
      cursor = next.nextCursor;
    }
    const ids = all.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages
    for (const id of [on.id, fp.id, off.id]) expect(ids).toContain(id);
    expect(ids.indexOf(on.id)).toBeLessThan(ids.indexOf(off.id)); // topic match outranks non-match
    expect(all.find((x) => x.id === fp.id).reasons.join(' ')).toContain('You follow');
    expect(all.find((x) => x.id === on.id).reasons.join(' ')).toContain('Matches your interests');
    expect(ids).not.toContain(undefined);

    const ex = (await me.client.get(`/v1/feed/explain/${on.id}`)).body;
    expect(ex.reasons.join(' ')).toContain('Matches your interests');

    await me.client.post('/v1/feed/feedback', { postId: off.id, signal: 'not_interested' });
    await me.client.post('/v1/feed/feedback', { postId: fp.id, signal: 'hide_creator' });
    const after = (
      (await me.client.get('/v1/feed', { mode: 'for_you', limit: '50' })).body.items as any[]
    ).map((x) => x.id);
    expect(after).not.toContain(off.id);
    expect(after).not.toContain(fp.id);
    // never contains the viewer's own posts, blocked users, or private content
    const priv = await post(authors[1]!, { body: 'secret', visibility: 'private' });
    expect(
      ((await me.client.get('/v1/feed', { mode: 'for_you', limit: '50' })).body.items as any[]).map(
        (x) => x.id,
      ),
    ).not.toContain(priv.id);
  });

  it('opting out of personalization falls back to recency and says so', async () => {
    const me = await signup(t);
    const a = await signup(t);
    await me.client.patch('/v1/settings/preferences', { personalization: false });
    await post(a, { body: 'recent', visibility: 'public' });
    const r = (await me.client.get('/v1/feed', { mode: 'for_you' })).body;
    expect(r.items[0].reasons).toEqual(['Recent']);
  });

  it('anonymous visitors can browse the public for_you feed but see no private content', async () => {
    const a = await signup(t);
    const pub = await post(a, { body: 'anon-visible', visibility: 'public' });
    await post(a, { body: 'friends only', visibility: 'friends' });
    const r = await new Client(t).get('/v1/feed', { mode: 'for_you', limit: '50' });
    expect(r.status).toBe(200);
    const bodies = (r.body.items as any[])
      .filter((x) => x.author.username === a.username)
      .map((x) => x.body);
    expect(bodies).toEqual([pub.body]);
  });
});
