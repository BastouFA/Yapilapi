import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN_RULES, FAIR_START, chainBarText, fairStartLines, micNoticeHref, micNoticeText } from '@yapilapi/shared';
import { t as tr, tp as trp } from '@yapilapi/shared/i18n';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { fairStartPicks, RANKING, scoreOf, withFairStart, type Arranged, type Features } from '../src/lib/ranking.ts';
import { refreshFairStarts, sweepFairStarts } from '../src/lib/fair-start.ts';

/**
 * Pass the Mic (chains of reels, lib/chains.ts, modules/pass-the-mic.ts) and Fair start
 * (lib/fair-start.ts, the fair-start slots in lib/ranking.ts): docs/product/pass-the-mic.md.
 * Other files share the database: every fair start made here is stopped at the end, so later
 * files' feeds never get these reels in a fair-start slot.
 */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`UPDATE fair_start_reels SET status = 'stopped', finished_at = now() WHERE status = 'active'`);
  await t.close();
});

const db = () => t.ctx.db;
const adult = (extra: Record<string, unknown> = {}) => signUp(t.app, extra);
/** A creator who can have a fair start: an adult whose email is confirmed. */
const creator = async () => {
  const u = await adult();
  await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
  return u;
};
const video = async (u: TestUser, durationMs = 10_000) =>
  (
    await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/r.mp4','video/mp4','ready',$2) RETURNING id, url`,
      [u.id, durationMs],
    )
  ).rows[0] as { id: string; url: string };
const postReel = async (u: TestUser, extra: Record<string, unknown> = {}) => {
  const m = await video(u);
  return as(t.app, u).post('/v1/posts', { body: 'A reel', visibility: 'public', format: 'reel', media: [{ id: m.id, url: m.url, kind: 'video' }], ...extra });
};
const reel = async (u: TestUser, extra: Record<string, unknown> = {}) => {
  const r = await postReel(u, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.post as { id: string; chain?: any; sound?: { id: string } | null };
};
/** Start a chain with a new reel: its reel and the chain's id. */
const startChain = async (u: TestUser, extra: Record<string, unknown> = {}) => {
  const p = await reel(u, { chainPrompt: 'Show your city’s best street food', ...extra });
  expect(p.chain).toMatchObject({ position: 1, total: 1, isStarter: true });
  return { postId: p.id, chainId: p.chain.id as string };
};
const join = (u: TestUser, chainId: string, extra: Record<string, unknown> = {}) => postReel(u, { chainId, ...extra });
const notes = async (u: TestUser, type: string) => (await as(t.app, u).get('/v1/notifications')).body.items.filter((n: any) => n.type === type);
const befriend = async (a: TestUser, b: TestUser) => {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  await as(t.app, b).post(`/v1/users/${a.id}/friend-request`);
};
const seen = (u: TestUser, postId: string, kind = 'impression', surface = 'reels') =>
  as(t.app, u).post('/v1/feed/events', { events: [{ postId, surface, kind }] });
const fair = async (postId: string) => (await db().query(`SELECT * FROM fair_start_reels WHERE post_id = $1`, [postId])).rows[0];

describe('Pass the Mic: chains', () => {
  it('starts with a reel, takes the mic in order, and says where each reel is', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    await db().query(`UPDATE profiles SET country = 'NG' WHERE user_id = $1`, [ada.id]);
    await db().query(`UPDATE profiles SET country = 'KE' WHERE user_id = $1`, [bola.id]);
    const start = await startChain(ada);
    const chain = (await as(t.app, bola).get(`/v1/chains/${start.chainId}`)).body.chain;
    expect(chain).toMatchObject({ prompt: 'Show your city’s best street food', whoCanJoin: 'everyone', closed: false, firstPostId: start.postId });
    expect(chain.viewer).toEqual({ canJoin: true, isStarter: false, why: null });
    // The starter's own sound is offered to the next people.
    const own = (await as(t.app, ada).get(`/v1/posts/${start.postId}`)).body.post.sound;
    expect(chain.sound).toEqual({ id: own.id, title: own.title });

    const second = await join(bola, start.chainId, { soundId: chain.sound.id });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.post.sound.id).toBe(own.id);
    const third = await join(cleo, start.chainId);
    expect(third.body.post.chain).toMatchObject({ id: start.chainId, position: 3, total: 3, people: 3, countries: 2, canJoin: true });
    expect(third.body.post.chain.starter.id).toBe(ada.id);
    expect(
      chainBarText(
        third.body.post.chain,
        (k, v) => tr(k, 'en', v),
        (k, n, v) => trp(k, n, 'en', v),
      ),
    ).toBe('Link 3 of 3 · 2 countries');

    const links = (await as(t.app, cleo).get(`/v1/chains/${start.chainId}/links`)).body;
    expect(links.items.map((p: any) => p.id)).toEqual([start.postId, second.body.post.id, third.body.post.id]);
    const step = (from: string, dir: string) => as(t.app, cleo).get(`/v1/chains/${start.chainId}/step?from=${from}&dir=${dir}`);
    expect((await step(second.body.post.id, 'next')).body.post.id).toBe(third.body.post.id);
    expect((await step(second.body.post.id, 'previous')).body.post.id).toBe(start.postId);
    expect((await step(third.body.post.id, 'next')).body.post).toBeNull();
    // A link is a normal reel: on its author's profile.
    expect((await as(t.app, ada).get(`/v1/users/${bola.username}/posts`)).body.items.map((p: any) => p.id)).toContain(second.body.post.id);

    // The starter hears once per chain (grouped), and the reel before's author hears someone came after them.
    const told = await notes(ada, 'chain_link');
    expect(told).toHaveLength(1);
    expect(told[0].data).toMatchObject({ chainId: start.chainId, count: 2 });
    expect(
      micNoticeText(
        told[0],
        (k, v) => tr(k, 'en', v),
        (k, n, v) => trp(k, n, 'en', v),
      ),
    ).toBe(`${told[0].actor.displayName} and 1 other took the mic on your chain`);
    expect(micNoticeHref(told[0])).toEqual({ chain: start.chainId });
    const after = await notes(bola, 'chain_next');
    expect(after).toHaveLength(1);
    expect(after[0].actor.id).toBe(cleo.id);
    // The starter isn't told twice for the reel right after theirs.
    expect(await notes(ada, 'chain_next')).toHaveLength(0);
  });

  it('starts from a reel already posted, once, and only with your own public reels', async () => {
    const ada = await adult();
    const bola = await adult();
    const r = await reel(ada);
    expect((await as(t.app, bola).post('/v1/chains', { postId: r.id, prompt: 'Mine now' })).status).toBe(404);
    const made = await as(t.app, ada).post('/v1/chains', { postId: r.id, prompt: 'Continue this dance' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.chain).toMatchObject({ prompt: 'Continue this dance', counts: { links: 1, people: 1 }, viewer: { isStarter: true } });
    expect((await as(t.app, ada).post('/v1/chains', { postId: r.id, prompt: 'Again' })).status).toBe(409);
    // Friends only is fine; a circle or chosen people isn't.
    expect((await postReel(ada, { chainPrompt: 'For friends', visibility: 'friends' })).status).toBe(201);
    const post = await as(t.app, ada).post('/v1/posts', { body: 'Just words', visibility: 'public' });
    expect((await as(t.app, ada).post('/v1/chains', { postId: post.body.post.id, prompt: 'Text' })).status).toBe(400);
    // Not as a draft, not with an echo, not for subscribers or in a community.
    for (const bad of [{ draft: true }, { visibility: 'subscribers' }, { visibility: 'selected', audience: [bola.id] }, { chainId: made.body.chain.id }])
      expect((await postReel(ada, { chainPrompt: 'Nope', ...bad })).status, JSON.stringify(bad)).toBe(400);
    expect((await postReel(bola, { chainId: made.body.chain.id, draft: true })).status).toBe(400);
  });

  it('follows who can take the mic: closed, people the starter follows, blocks, private accounts, minors and limits', async () => {
    const ada = await adult();
    const fan = await adult();
    const stranger = await adult();
    const { chainId, postId } = await startChain(ada, { chainJoin: 'following' });
    await as(t.app, ada).post(`/v1/users/${fan.id}/follow`);
    const refused = await join(stranger, chainId);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('chain_not_allowed');
    // Refused: the reel isn't posted at all.
    expect((await as(t.app, stranger).get(`/v1/users/${stranger.username}/posts`)).body.items).toHaveLength(0);
    expect((await join(fan, chainId)).status).toBe(201);

    // Closed: nobody, the starter included, until it opens again. Only the starter changes it.
    expect((await as(t.app, fan).patch(`/v1/chains/${chainId}`, { whoCanJoin: 'nobody' })).status).toBe(403);
    expect((await as(t.app, ada).patch(`/v1/chains/${chainId}`, { whoCanJoin: 'nobody' })).body.chain).toMatchObject({ closed: true });
    const closed = await join(fan, chainId);
    expect([closed.status, closed.body.error.code]).toEqual([403, 'chain_closed']);
    expect((await as(t.app, fan).get(`/v1/posts/${postId}`)).body.post.chain).toMatchObject({ closed: true, canJoin: false });
    await as(t.app, ada).patch(`/v1/chains/${chainId}`, { whoCanJoin: 'everyone' });

    // Blocked either way: the chain isn't there for them.
    const blocked = await adult();
    await as(t.app, ada).post(`/v1/users/${blocked.id}/block`);
    expect((await as(t.app, blocked).get(`/v1/chains/${chainId}`)).status).toBe(404);
    expect((await join(blocked, chainId)).status).toBe(404);

    // A private account's reel is in the counts, never shown to people who don't follow it.
    const shy = await adult();
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [shy.id]);
    const shyLink = await join(shy, chainId, { visibility: 'followers' });
    expect(shyLink.status, JSON.stringify(shyLink.body)).toBe(201);
    const visible = (await as(t.app, stranger).get(`/v1/chains/${chainId}/links`)).body.items.map((p: any) => p.id);
    expect(visible).not.toContain(shyLink.body.post.id);
    expect((await as(t.app, stranger).get(`/v1/chains/${chainId}`)).body.chain.counts).toMatchObject({ links: 3, people: 3 });

    // Teens and adults only in each other's chains once they're friends.
    const teen = await signUp(t.app, { birthDate: '2011-05-06' });
    await db().query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [teen.id]);
    const minor = await join(teen, chainId);
    expect([minor.status, minor.body.error?.code]).toEqual([403, 'chain_not_allowed']);
    const teenChain = await startChain(teen, { chainJoin: 'everyone' });
    expect((await join(stranger, teenChain.chainId)).status).toBe(403);
    await befriend(teen, stranger);
    expect((await join(stranger, teenChain.chainId)).status).toBe(201);

    // One person adds a few reels to one chain at most.
    for (let i = 1; i < CHAIN_RULES.linksPerPersonPerChain; i++) expect((await join(fan, chainId)).status).toBe(201);
    const limited = await join(fan, chainId);
    expect([limited.status, limited.body.error.code]).toEqual([429, 'chain_limit']);
  });

  it('lets the starter remove a reel and a reel’s author leave, without deleting the reel', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    const { chainId } = await startChain(ada);
    const b = (await join(bola, chainId)).body.post.id;
    const c = (await join(cleo, chainId)).body.post.id;
    expect((await as(t.app, bola).del(`/v1/chains/${chainId}/links/${c}`)).status).toBe(404);
    expect((await as(t.app, cleo).del(`/v1/chains/${chainId}/links/${c}`)).body).toEqual({ removed: true });
    expect((await as(t.app, ada).del(`/v1/chains/${chainId}/links/${b}`)).body).toEqual({ removed: true });
    expect((await as(t.app, cleo).get(`/v1/posts/${c}`)).body.post.chain).toBeUndefined();
    expect((await as(t.app, ada).get(`/v1/posts/${b}`)).status).toBe(200);
    expect((await as(t.app, ada).get(`/v1/chains/${chainId}`)).body.chain.counts.links).toBe(1);
    // The next reel takes the next place: the order never changes.
    const d = await join(cleo, chainId);
    expect(d.body.post.chain).toMatchObject({ position: 2, total: 2 });
  });

  it('drops reels taken down by moderation, and brings them back when restored', async () => {
    const ada = await adult();
    const bola = await adult();
    const viewer = await adult();
    const { chainId } = await startChain(ada);
    const b = (await join(bola, chainId)).body.post.id;
    await db().query(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [b]);
    expect((await as(t.app, viewer).get(`/v1/chains/${chainId}/links`)).body.items.map((p: any) => p.id)).not.toContain(b);
    expect((await as(t.app, viewer).get(`/v1/chains/${chainId}`)).body.chain.counts).toMatchObject({ links: 1, people: 1 });
    await db().query(`UPDATE posts SET moderation_status = 'normal' WHERE id = $1`, [b]);
    expect((await as(t.app, viewer).get(`/v1/chains/${chainId}/links`)).body.items.map((p: any) => p.id)).toContain(b);
  });

  it('passes the mic to people you follow who may take it, once each', async () => {
    const ada = await adult();
    const friend = await adult();
    const stranger = await adult();
    const blocker = await adult();
    const { chainId } = await startChain(ada);
    await as(t.app, ada).post(`/v1/users/${friend.id}/follow`);
    await as(t.app, ada).post(`/v1/users/${blocker.id}/follow`);
    await as(t.app, blocker).post(`/v1/users/${ada.id}/block`);
    const r = await as(t.app, ada).post(`/v1/chains/${chainId}/pass`, { userIds: [friend.id, stranger.id, blocker.id] });
    expect(r.body).toEqual({ passed: 1 });
    expect((await as(t.app, ada).post(`/v1/chains/${chainId}/pass`, { userIds: [friend.id] })).body).toEqual({ passed: 0 });
    const got = await notes(friend, 'chain_pass');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ entityType: 'chain', entityId: chainId, data: { chainId, prompt: 'Show your city’s best street food' } });
    expect(micNoticeHref(got[0])).toEqual({ chain: chainId });
    expect(await notes(stranger, 'chain_pass')).toHaveLength(0);
    // At most a few per chain.
    const many = await Promise.all(Array.from({ length: CHAIN_RULES.passesAtOnce }, () => adult()));
    for (const m of many) await as(t.app, ada).post(`/v1/users/${m.id}/follow`);
    expect((await as(t.app, ada).post(`/v1/chains/${chainId}/pass`, { userIds: many.map((m) => m.id) })).body).toEqual({ passed: CHAIN_RULES.passesAtOnce });
    const more = await Promise.all(Array.from({ length: CHAIN_RULES.passesAtOnce }, () => adult()));
    expect((await as(t.app, ada).post(`/v1/chains/${chainId}/pass`, { userIds: more.map((m) => m.id) })).status).toBe(429);
  });

  it('passes the mic to people @mentioned in a chain reel’s caption, with the picker’s rules and limits, once', async () => {
    const ada = await adult();
    const friend = await adult();
    const picked = await adult();
    const stranger = await adult();
    const blocker = await adult();
    const many = await Promise.all(Array.from({ length: 9 }, () => adult()));
    for (const u of [friend, picked, blocker, ...many]) await as(t.app, ada).post(`/v1/users/${u.id}/follow`);
    await as(t.app, blocker).post(`/v1/users/${ada.id}/block`);
    const at = (us: TestUser[]) => us.map((u) => `@${u.username}`).join(' ');
    const passes = async () => Number((await db().query(`SELECT count(*) FROM reel_chain_passes WHERE from_id = $1`, [ada.id])).rows[0].count);

    // A reel that isn't in a chain: only a mention.
    await reel(ada, { body: `With ${at([friend])}` });
    expect(await notes(friend, 'chain_pass')).toHaveLength(0);
    expect(await notes(friend, 'post_mention')).toHaveLength(1);

    // Only people you follow or are friends with who may take the mic; the others get the usual mention (or nothing).
    const { chainId, postId } = await startChain(ada, { body: `Your turn ${at([friend, stranger, blocker])}` });
    const got = await notes(friend, 'chain_pass');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ entityType: 'chain', entityId: chainId, data: { chainId, prompt: 'Show your city’s best street food' } });
    // Told once: about the chain, instead of the mention.
    expect(await notes(friend, 'post_mention')).toHaveLength(1);
    expect(await notes(stranger, 'chain_pass')).toHaveLength(0);
    expect(await notes(stranger, 'post_mention')).toHaveLength(1);
    expect(await notes(blocker, 'chain_pass')).toHaveLength(0);
    expect(await passes()).toBe(1);

    // Editing the caption later doesn't pass it.
    expect((await as(t.app, ada).patch(`/v1/posts/${postId}`, { body: `Your turn ${at([friend, picked])}` })).status).toBe(200);
    expect(await notes(picked, 'chain_pass')).toHaveLength(0);
    expect(await passes()).toBe(1);

    // Picked, then mentioned: no second notice. At most CHAIN_RULES.passesAtOnce at a time, in the caption's order.
    expect((await as(t.app, ada).post(`/v1/chains/${chainId}/pass`, { userIds: [picked.id] })).body).toEqual({ passed: 1 });
    expect((await join(ada, chainId, { body: `Next ${at([picked, friend, ...many.slice(0, 6)])}` })).status).toBe(201);
    expect(await notes(picked, 'chain_pass')).toHaveLength(1);
    expect(await notes(friend, 'chain_pass')).toHaveLength(1);
    expect(await passes()).toBe(2 + CHAIN_RULES.passesAtOnce);
    for (const u of many.slice(0, CHAIN_RULES.passesAtOnce)) expect(await notes(u, 'chain_pass')).toHaveLength(1);
    expect(await notes(many[5]!, 'chain_pass')).toHaveLength(0);
    expect(await notes(many[5]!, 'post_mention')).toHaveLength(1);

    // And CHAIN_RULES.passesPerChain in all.
    expect((await join(ada, chainId, { body: `Last ${at(many.slice(5))}` })).status).toBe(201);
    expect(await passes()).toBe(CHAIN_RULES.passesPerChain);
    expect(await notes(many[8]!, 'chain_pass')).toHaveLength(0);
    expect((await as(t.app, ada).post(`/v1/chains/${chainId}/pass`, { userIds: [many[8]!.id] })).status).toBe(429);
  });

  it('shows active chains in Wander, and turns off with its flag', async () => {
    const ada = await adult();
    const viewer = await adult();
    const { chainId } = await startChain(ada);
    expect((await as(t.app, viewer).get('/v1/chains/active?limit=30')).body.items.map((c: any) => c.id)).toContain(chainId);
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('PASS_THE_MIC', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      expect((await as(t.app, viewer).get(`/v1/chains/${chainId}`)).body.error.code).toBe('feature_disabled');
      expect((await as(t.app, viewer).get('/v1/chains/active')).body.items).toEqual([]);
      expect((await join(viewer, chainId)).status).toBe(404);
      expect((await as(t.app, viewer).get(`/v1/chains/${chainId}`)).status).toBe(404);
    } finally {
      await db().query(`UPDATE feature_flags SET enabled = true WHERE key = 'PASS_THE_MIC'`);
    }
  });

  it('carries a chain’s audience on to its later reels', async () => {
    const base: Features = {
      id: 'x',
      authorId: 'a',
      createdAt: new Date(),
      topics: [],
      kind: 'video',
      format: 'reel',
      own: false,
      friend: false,
      followed: false,
      member: false,
      collabFriend: false,
      collabFollowed: false,
      interestN: 0,
      moreN: 0,
      lessN: 0,
      topicAff: 0,
      creatorAff: 0,
      similarPeople: 0,
      likes: 0,
      comments: 0,
      impressions: 0,
      completes: 0,
      skips: 0,
      shares: 0,
      saves: 0,
      trend: 0,
      ageHours: 1,
      newCreator: false,
    };
    expect(scoreOf({ ...base, chainAudience: true }, true) - scoreOf(base, true)).toBeCloseTo(RANKING.weights.chain, 5);
    expect(scoreOf({ ...base, chainAudience: true }, false)).toBeCloseTo(scoreOf(base, false), 5);

    const ada = await adult();
    const bola = await adult();
    const viewer = await adult();
    const { chainId, postId } = await startChain(ada);
    await as(t.app, viewer).post('/v1/feed/events', { events: [{ postId, surface: 'reels', kind: 'watch', valueMs: 8000 }] });
    const later = (await join(bola, chainId)).body.post.id;
    const r = await as(t.app, viewer).get('/v1/reels?limit=20');
    expect(r.status).toBe(200);
    const { rankFeed } = await import('../src/lib/ranking.ts');
    const list = await rankFeed(db(), {
      userId: viewer.id,
      asOf: new Date().toISOString(),
      surface: 'reels',
      personalized: true,
      personal: '',
      sensitiveOk: true,
    });
    expect(list.map((x) => x.id)).toContain(later);
  });
});

describe('Fair start', () => {
  it('gives a fair start to a confirmed adult creator’s first reels, one at a time, then one a week', async () => {
    const unconfirmed = await adult();
    expect(await fair((await reel(unconfirmed)).id)).toBeUndefined();
    const shy = await creator();
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [shy.id]);
    expect(await fair((await reel(shy, { visibility: 'followers' })).id)).toBeUndefined();
    const teen = await signUp(t.app, { birthDate: '2011-05-06' });
    await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [teen.id]);
    await db().query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [teen.id]);
    expect(await fair((await reel(teen)).id)).toBeUndefined();
    const limited = await creator();
    await db().query(`UPDATE users SET restricted_at = now() WHERE id = $1`, [limited.id]);
    expect((await as(t.app, limited).get('/v1/me/fair-start')).body).toEqual({ offered: false });

    const ada = await creator();
    expect((await as(t.app, ada).get('/v1/me/fair-start')).body).toEqual({ offered: true });
    const first = await reel(ada);
    expect(await fair(first.id)).toMatchObject({ status: 'active', target: FAIR_START.target, reached: 0, slowed: false });
    // One at a time: the next reel while the first runs gets none.
    expect(await fair((await reel(ada)).id)).toBeUndefined();
    expect((await as(t.app, ada).get('/v1/me/fair-start')).body).toEqual({ offered: false });
    // A post that isn't a reel never does.
    await db().query(`UPDATE fair_start_reels SET status = 'done' WHERE author_id = $1`, [ada.id]);
    await as(t.app, ada).post('/v1/posts', { body: 'Words', visibility: 'public' });
    for (let i = 1; i < FAIR_START.firstReels; i++) {
      const r = await reel(ada);
      expect((await fair(r.id))?.status).toBe('active');
      await db().query(`UPDATE fair_start_reels SET status = 'done' WHERE post_id = $1`, [r.id]);
    }
    // After the first ones: one a week, while under FAIR_START.underFollowers followers.
    expect(await fair((await reel(ada)).id)).toBeUndefined();
    await db().query(`UPDATE fair_start_reels SET started_at = now() - interval '8 days' WHERE author_id = $1`, [ada.id]);
    expect((await fair((await reel(ada)).id))?.status).toBe('active');
  });

  it('takes one slot in FAIR_START.slotEvery, never twice, and leaves the feed alone when there are none', () => {
    const list: Arranged[] = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, reason: { code: 'popular' } }));
    const out = withFairStart(list, [
      { id: 'fa', fit: 1 },
      { id: 'fb', fit: 3 },
      { id: 'p30', fit: 2 },
    ]);
    expect(out).toHaveLength(42);
    expect(new Set(out.map((x) => x.id)).size).toBe(42);
    const at = (id: string) => out.findIndex((x) => x.id === id);
    expect([at('fb'), at('p30'), at('fa')]).toEqual([
      FAIR_START.firstSlot,
      FAIR_START.firstSlot + FAIR_START.slotEvery,
      FAIR_START.firstSlot + 2 * FAIR_START.slotEvery,
    ]);
    expect(out[at('fb')]!.reason).toEqual({ code: 'new_creator' });
    expect(withFairStart(list, [])).toBe(list);
    // A small app: fewer posts than slots, nothing repeats.
    expect(withFairStart(list.slice(0, 1), [{ id: 'fa', fit: 0 }]).map((x) => x.id)).toEqual(['p0', 'fa']);
  });

  it('picks reels for people they suit, never their own or one they saw', async () => {
    const ada = await creator();
    const viewer = await adult();
    const r = await reel(ada, { body: 'Street food #suya' });
    const picks = (u: TestUser) =>
      fairStartPicks(db(), { userId: u.id, asOf: new Date().toISOString(), surface: 'reels', personalized: true, personal: '', sensitiveOk: true });
    expect((await picks(viewer)).map((p) => p.id)).toContain(r.id);
    expect((await picks(ada)).map((p) => p.id)).not.toContain(r.id);
    // In the feed, at the first fair-start slot (or the end of a short feed).
    const { rankFeed } = await import('../src/lib/ranking.ts');
    const ranked = (
      await rankFeed(db(), { userId: viewer.id, asOf: new Date().toISOString(), surface: 'reels', personalized: true, personal: '', sensitiveOk: true })
    ).map((x) => x.id);
    expect(ranked.indexOf(r.id)).toBeGreaterThanOrEqual(0);
    expect(ranked.indexOf(r.id)).toBeLessThanOrEqual(FAIR_START.firstSlot + FAIR_START.slotEvery * 20);
    // Seen anywhere: never in a fair-start slot again.
    await seen(viewer, r.id, 'impression', 'profile');
    expect((await picks(viewer)).map((p) => p.id)).not.toContain(r.id);
  });

  it('fits readers of its language best, and those who get it translated as well as a reel with no language', async () => {
    const ada = await creator();
    const viewer = await adult();
    const r = await reel(ada, { body: 'Ẹ káàbọ̀' });
    await db().query(`UPDATE posts SET lang = 'yo' WHERE id = $1`, [r.id]);
    const fit = async (reader: { understood: string[]; translated: boolean }) =>
      (
        await fairStartPicks(db(), {
          userId: viewer.id,
          asOf: new Date().toISOString(),
          surface: 'reels',
          personalized: true,
          personal: '',
          sensitiveOk: true,
          reader,
        })
      ).find((p) => p.id === r.id)!.fit;
    const reads = await fit({ understood: ['en', 'yo'], translated: false });
    const translated = await fit({ understood: ['en'], translated: true });
    const unread = await fit({ understood: ['en'], translated: false });
    expect(reads - translated).toBeCloseTo(1);
    expect(translated - unread).toBeCloseTo(1);
  });

  it('leaves out reels in a language the viewer doesn’t understand once they turned off "Translate automatically"', async () => {
    const ada = await creator();
    const viewer = await adult();
    const r = await reel(ada, { body: 'Ẹ káàbọ̀' });
    await db().query(`UPDATE posts SET lang = 'yo' WHERE id = $1`, [r.id]);
    const picked = async (understood: string[], translated: boolean) =>
      (
        await fairStartPicks(db(), {
          userId: viewer.id,
          asOf: new Date().toISOString(),
          surface: 'reels',
          personalized: true,
          personal: '',
          sensitiveOk: true,
          reader: { understood, translated },
        })
      ).some((p) => p.id === r.id);
    expect(await picked(['en'], true)).toBe(true);
    expect((await as(t.app, viewer).put('/v1/me/translation', { languages: [], auto: false })).status).toBe(200);
    expect(await picked(['en'], false)).toBe(false);
    // A language they added still reaches them.
    expect(await picked(['en', 'yo'], false)).toBe(true);
    await as(t.app, viewer).put('/v1/me/translation', { languages: [], auto: true });
    expect(await picked(['en'], true)).toBe(true);
  });

  it('gives a reel held for review its fair start when a moderator clears it soon after', async () => {
    const mod = await adult();
    await db().query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
    const ada = await creator();
    const held = await reel(ada, { body: 'DM me for prices on my street food' });
    expect((await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [held.id])).rows[0].moderation_status).toBe('review');
    expect(await fair(held.id)).toBeUndefined();
    const caseOf = async (postId: string) => (await db().query(`SELECT id FROM moderation_cases WHERE target_id = $1`, [postId])).rows[0].id as string;
    const decide = async (postId: string, decision: string) =>
      expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${await caseOf(postId)}/decide`, { decision })).status).toBe(200);
    // Cleared: it starts now, with its whole time ahead.
    await db().query(`UPDATE posts SET created_at = now() - interval '2 days' WHERE id = $1`, [held.id]);
    await decide(held.id, 'no_action');
    const f = await fair(held.id);
    expect(f).toMatchObject({ status: 'active', reached: 0 });
    expect(f.ends_at.getTime() - Date.now()).toBeGreaterThan((FAIR_START.days - 0.1) * 86_400_000);
    await db().query(`UPDATE fair_start_reels SET status = 'done' WHERE post_id = $1`, [held.id]);

    // Cleared too late, or only with a warning: none.
    const late = await reel(ada, { body: 'DM me for prices on my jollof' });
    await db().query(`UPDATE posts SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [late.id, FAIR_START.clearedWithinDays + 1]);
    await decide(late.id, 'no_action');
    expect(await fair(late.id)).toBeUndefined();
    const warned = await reel(ada, { body: 'DM me for prices on my puff puff' });
    await decide(warned.id, 'warn');
    expect(await fair(warned.id)).toBeUndefined();
    // A reel that was out and later reported doesn't get one by being cleared.
    const bola = await creator();
    const out = await reel(bola);
    await db().query(`DELETE FROM fair_start_reels WHERE post_id = $1`, [out.id]);
    expect((await as(t.app, ada).post('/v1/reports', { targetType: 'post', targetId: out.id, reason: 'spam' })).status).toBe(201);
    await decide(out.id, 'no_action');
    expect(await fair(out.id)).toBeUndefined();
  });

  it('counts each real person once: not the creator, not blocked or limited accounts', async () => {
    const ada = await creator();
    const r = await reel(ada);
    const a = await adult();
    const b = await adult();
    await seen(a, r.id);
    await seen(a, r.id, 'impression', 'for_you');
    await seen(ada, r.id);
    const blocked = await adult();
    await as(t.app, ada).post(`/v1/users/${blocked.id}/block`);
    expect((await seen(blocked, r.id)).body).toEqual({ accepted: 0 });
    const limited = await adult();
    await db().query(`UPDATE users SET restricted_at = now() WHERE id = $1`, [limited.id]);
    await seen(limited, r.id);
    await seen(b, r.id);
    expect((await fair(r.id)).reached).toBe(2);
    const who = (await db().query(`SELECT viewer_id FROM fair_start_views WHERE post_id = $1`, [r.id])).rows.map((x) => x.viewer_id);
    expect(who.sort()).toEqual([a.id, b.id].sort());
  });

  it('slows down when early viewers skip or someone reports it, and still reaches the minimum', async () => {
    const ada = await creator();
    const r = await reel(ada);
    const viewers = await Promise.all(Array.from({ length: FAIR_START.checkAfter }, () => adult()));
    for (const [i, v] of viewers.entries())
      await as(t.app, v).post('/v1/feed/events', {
        events: [
          { postId: r.id, surface: 'reels', kind: 'impression' },
          ...(i < FAIR_START.checkAfter * 0.8 ? [{ postId: r.id, surface: 'reels', kind: 'skip' }] : []),
        ],
      });
    await refreshFairStarts(db(), t.ctx.realtime, [r.id]);
    expect(await fair(r.id)).toMatchObject({ status: 'active', slowed: true, reached: FAIR_START.checkAfter });
    const own = await as(t.app, ada).get(`/v1/posts/${r.id}/fair-start`);
    expect(own.body.fairStart).toMatchObject({ status: 'active', slowed: true, target: FAIR_START.minimum, reached: FAIR_START.checkAfter });
    expect((await as(t.app, viewers[0]!).get(`/v1/posts/${r.id}/fair-start`)).status).toBe(404);
    // Slowed reels come after the others in the slot, while they're under the minimum.
    const other = await creator();
    const fresh = await reel(other);
    const picks = await fairStartPicks(db(), {
      userId: (await adult()).id,
      asOf: new Date().toISOString(),
      surface: 'reels',
      personalized: false,
      personal: '',
      sensitiveOk: true,
    });
    const fit = (id: string) => picks.find((p) => p.id === id)?.fit ?? -99;
    expect(fit(fresh.id)).toBeGreaterThan(fit(r.id));
    expect(fit(r.id)).toBeGreaterThan(-99);

    // Reported: slowed at the next check.
    await db().query(`UPDATE fair_start_reels SET status = 'done' WHERE post_id = $1`, [fresh.id]);
    const reported = await reel(await creator());
    const reporter = await adult();
    expect((await as(t.app, reporter).post('/v1/reports', { targetType: 'post', targetId: reported.id, reason: 'spam' })).status).toBe(201);
    await seen(reporter, reported.id);
    expect(await fair(reported.id)).toMatchObject({ slowed: true });
  });

  it('stops at its target with the report, after its time, or without one when taken down', async () => {
    const ada = await creator();
    const r = await reel(ada);
    await db().query(`UPDATE fair_start_reels SET target = 3 WHERE post_id = $1`, [r.id]);
    const [a, b, c] = await Promise.all([adult(), adult(), adult()]);
    await as(t.app, a).post('/v1/feed/events', {
      events: [
        { postId: r.id, surface: 'reels', kind: 'impression' },
        { postId: r.id, surface: 'reels', kind: 'complete' },
        { postId: r.id, surface: 'reels', kind: 'share' },
      ],
    });
    await as(t.app, a).post(`/v1/users/${ada.id}/follow`);
    await seen(b, r.id);
    // The report counts what the fair-start viewers did; c finishes it.
    await as(t.app, c).post('/v1/feed/events', {
      events: [
        { postId: r.id, surface: 'reels', kind: 'impression' },
        { postId: r.id, surface: 'reels', kind: 'complete' },
      ],
    });
    const done = await fair(r.id);
    expect(done).toMatchObject({ status: 'done', reached: 3 });
    expect(done.report).toEqual({ reached: 3, finished: 2, shared: 1, followed: 1 });
    const told = await notes(ada, 'fair_start_done');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ entityType: 'post', entityId: r.id, data: { reached: 3, finished: 2, shared: 1, followed: 1 } });
    expect(
      micNoticeText(
        told[0],
        (k, v) => tr(k, 'en', v),
        (k, n, v) => trp(k, n, 'en', v),
      ),
    ).toBe('Fair start finished: 3 people saw your reel');
    expect(fairStartLines(done.report, (k, n, v) => trp(k, n, 'en', v))).toEqual([
      '3 people saw your reel',
      '2 watched to the end',
      '1 shared',
      '1 followed you',
    ]);
    // The reel's insights carry it too; nobody else sees the reel's fair-start viewers.
    expect((await as(t.app, ada).get(`/v1/posts/${r.id}/insights`)).body.insights.fairStart).toMatchObject({ status: 'done', report: done.report });
    // Not counted again once done.
    await seen(await adult(), r.id);
    expect((await fair(r.id)).reached).toBe(3);

    // A week later, whatever it reached: done, with what it reached (the honest number).
    const late = await creator();
    const lr = await reel(late);
    await seen(a, lr.id);
    await db().query(`UPDATE fair_start_reels SET ends_at = now() - interval '1 minute' WHERE post_id = $1`, [lr.id]);
    await sweepFairStarts({ db: db(), realtime: t.ctx.realtime });
    expect(await fair(lr.id)).toMatchObject({ status: 'done', reached: 1 });
    expect((await notes(late, 'fair_start_done'))[0].data).toMatchObject({ reached: 1 });

    // Taken down: it stops, and nobody is told.
    const gone = await creator();
    const gr = await reel(gone);
    await db().query(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [gr.id]);
    await refreshFairStarts(db(), t.ctx.realtime, [gr.id]);
    expect((await fair(gr.id)).status).toBe('stopped');
    expect(await notes(gone, 'fair_start_done')).toHaveLength(0);
  });

  it('turns off with its flag', async () => {
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('FAIR_START', false) ON CONFLICT (key) DO UPDATE SET enabled = false`);
    try {
      const ada = await creator();
      expect((await as(t.app, ada).get('/v1/me/fair-start')).body).toEqual({ offered: false });
      expect(await fair((await reel(ada)).id)).toBeUndefined();
    } finally {
      await db().query(`UPDATE feature_flags SET enabled = true WHERE key = 'FAIR_START'`);
    }
  });

  it('shows the admin chains and the pool', async () => {
    const admin = await adult();
    await db().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    const r = await as(t.app, admin).get('/v1/admin/pass-the-mic');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.chains.total).toBeGreaterThan(0);
    expect(r.body.fairStart.done).toBeGreaterThan(0);
    expect((await as(t.app, await adult()).get('/v1/admin/pass-the-mic')).status).toBe(403);
  });
});

describe('fair start with a friend’s follow', () => {
  it('counts a follow only after the person saw the reel', async () => {
    const ada = await creator();
    const fan = await adult();
    await followAccepted(t.app, fan, ada);
    const r = await reel(ada);
    await db().query(`UPDATE fair_start_reels SET target = 1 WHERE post_id = $1`, [r.id]);
    await seen(fan, r.id);
    expect((await fair(r.id)).report).toMatchObject({ reached: 1, followed: 0 });
  });
});
