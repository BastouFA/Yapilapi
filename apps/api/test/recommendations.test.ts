import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { arrange, rankFeed, RANKING, type Features } from '../src/lib/ranking.ts';
import { AFFINITY } from '../src/lib/affinity.ts';

/**
 * The recommender (lib/ranking.ts, lib/affinity.ts, POST /v1/feed/events): what the apps report,
 * what it learns, where candidates come from, and the order it makes. Other test files share
 * the database, so feeds are read far enough (or ranked whole) to find what each test made.
 */
let t: BuiltApp;
const tag = Date.now().toString(36);
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

const db = () => t.ctx.db;
const adult = () => signUp(t.app);
const publish = async (u: TestUser, body: string, extra: Record<string, unknown> = {}) => {
  const r = await as(t.app, u).post('/v1/posts', { body, visibility: 'public', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.post.id as string;
};
const reel = async (u: TestUser, body: string, durationMs = 10_000) => {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/r.mp4','video/mp4','ready',$2) RETURNING id, url`,
    [u.id, durationMs],
  );
  return publish(u, body, { format: 'reel', media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }] });
};
const events = (u: TestUser, list: { postId: string; surface?: string; kind: string; valueMs?: number }[]) =>
  as(t.app, u).post('/v1/feed/events', { events: list.map((e) => ({ surface: 'for_you', ...e })) });
const topicScore = async (u: TestUser, topic: string) =>
  Number((await db().query(`SELECT score FROM user_topic_affinity WHERE user_id = $1 AND topic = $2`, [u.id, topic])).rows[0]?.score ?? 0);
const creatorScore = async (u: TestUser, author: TestUser) =>
  Number((await db().query(`SELECT score FROM user_creator_affinity WHERE user_id = $1 AND author_id = $2`, [u.id, author.id])).rows[0]?.score ?? 0);
const stats = async (postId: string) => (await db().query(`SELECT * FROM post_stats WHERE post_id = $1`, [postId])).rows[0];
/** Every post of the viewer's whole ranked For you (or Reels), in order. */
const ranked = (u: TestUser, surface: 'for_you' | 'reels' = 'for_you', personalized = true) =>
  rankFeed(db(), { userId: u.id, asOf: new Date().toISOString(), surface, personalized, personal: '', sensitiveOk: true });
const feedIds = async (u: TestUser, url = '/v1/feed?mode=for_you&limit=50') => {
  const r = await as(t.app, u).get(url);
  expect(r.status).toBe(200);
  return (r.body.items as { id: string }[]).map((p) => p.id);
};

describe('feed events', () => {
  it('are checked, count impressions once per half hour, cap times and ignore posts you cannot see', async () => {
    const author = await adult();
    const viewer = await adult();
    const post = await publish(author, 'Seen once');
    expect((await as(t.app, null).post('/v1/feed/events', { events: [{ postId: post, surface: 'for_you', kind: 'impression' }] })).status).toBe(401);
    for (const bad of [
      { events: [] },
      { events: [{ postId: 'nope', surface: 'for_you', kind: 'impression' }] },
      { events: [{ postId: post, surface: 'moon', kind: 'impression' }] },
      { events: [{ postId: post, surface: 'for_you', kind: 'stare' }] },
      { events: [{ postId: post, surface: 'for_you', kind: 'dwell', valueMs: -1 }] },
      { events: Array.from({ length: 51 }, () => ({ postId: post, surface: 'for_you', kind: 'impression' })) },
    ])
      expect((await as(t.app, viewer).post('/v1/feed/events', bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);

    const first = await events(viewer, [
      { postId: post, kind: 'impression' },
      { postId: post, kind: 'impression' },
      { postId: post, kind: 'dwell', valueMs: 3_000_000 },
    ]);
    expect(first.body).toEqual({ accepted: 2 });
    expect((await events(viewer, [{ postId: post, kind: 'impression' }])).body).toEqual({ accepted: 0 });
    // Another surface is another impression, by the same viewer.
    expect((await events(viewer, [{ postId: post, surface: 'profile', kind: 'impression' }])).body).toEqual({ accepted: 1 });
    expect(await stats(post)).toMatchObject({ impressions: 2, viewers: 1 });
    expect(Number((await stats(post)).dwell_ms)).toBe(60_000);

    // A private account's post (you don't follow) and your own posts teach nothing.
    const shy = await adult();
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [shy.id]);
    const hidden = await publish(shy, 'Followers only in practice');
    const own = await publish(viewer, 'Mine');
    expect(
      (
        await events(viewer, [
          { postId: hidden, kind: 'impression' },
          { postId: own, kind: 'impression' },
        ])
      ).body,
    ).toEqual({ accepted: 0 });
    expect(await stats(hidden)).toBeUndefined();
  });
});

describe('learned affinity', () => {
  it('grows from likes, saves and finished reels, and fades with time', async () => {
    const author = await adult();
    const viewer = await adult();
    const topic = `aff${tag}`;
    const p = await publish(author, `About #${topic}`);
    await as(t.app, viewer).put(`/v1/posts/${p}/reaction`, { kind: 'like' });
    expect(await topicScore(viewer, topic)).toBeCloseTo(AFFINITY.deltas.like.topic, 2);
    await as(t.app, viewer).put(`/v1/posts/${p}/save`);
    expect(await topicScore(viewer, topic)).toBeCloseTo(AFFINITY.deltas.like.topic + AFFINITY.deltas.save.topic, 2);
    const r = await reel(author, `Watch #${topic}`);
    await events(viewer, [{ postId: r, surface: 'reels', kind: 'complete' }]);
    const before = AFFINITY.deltas.like.topic + AFFINITY.deltas.save.topic + AFFINITY.deltas.complete.topic;
    expect(await topicScore(viewer, topic)).toBeCloseTo(before, 2);
    expect(await creatorScore(viewer, author)).toBeCloseTo(before, 2);
    expect(await stats(r)).toMatchObject({ completes: 1 });

    // Three weeks later it has faded by e before the next like adds to it.
    await db().query(`UPDATE user_topic_affinity SET updated_at = now() - interval '21 days' WHERE user_id = $1`, [viewer.id]);
    const other = await publish(author, `More #${topic}`);
    await as(t.app, viewer).put(`/v1/posts/${other}/reaction`, { kind: 'like' });
    expect(await topicScore(viewer, topic)).toBeCloseTo(before * Math.exp(-1) + 1, 1);
  });

  it('learns less of a topic and creator from "Not interested" and skips', async () => {
    const author = await adult();
    const viewer = await adult();
    const topic = `meh${tag}`;
    const a = await publish(author, `Not for me #${topic}`);
    const b = await reel(author, `Skipped #${topic}`);
    await as(t.app, viewer).post('/v1/feed/feedback', { signal: 'not_interested', postId: a });
    await events(viewer, [{ postId: b, surface: 'reels', kind: 'skip' }]);
    const expected = AFFINITY.deltas.not_interested.topic + AFFINITY.deltas.skip.topic;
    expect(await topicScore(viewer, topic)).toBeCloseTo(expected, 2);
    expect(await creatorScore(viewer, author)).toBeCloseTo(AFFINITY.deltas.not_interested.creator + AFFINITY.deltas.skip.creator, 2);
    // The creator's other posts rank lower for this viewer than for someone who hasn't said anything.
    const c = await publish(author, `Another #${topic}`);
    const neutral = await adult();
    const pos = async (u: TestUser) => (await ranked(u)).findIndex((x) => x.id === c);
    expect(await pos(viewer)).toBeGreaterThan(await pos(neutral));
  });

  it('learns nothing with personalization off, forgets what it learned, and still counts for the post', async () => {
    const author = await adult();
    const viewer = await adult();
    const topic = `off${tag}`;
    const p = await publish(author, `Quiet #${topic}`);
    await as(t.app, viewer).put(`/v1/posts/${p}/reaction`, { kind: 'like' });
    expect(await topicScore(viewer, topic)).toBeGreaterThan(0);
    await as(t.app, viewer).put('/v1/me/consents', { purpose: 'personalization', granted: false });
    expect(await topicScore(viewer, topic)).toBe(0);
    expect(await creatorScore(viewer, author)).toBe(0);

    await as(t.app, viewer).put(`/v1/posts/${p}/save`);
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    await events(viewer, [
      { postId: p, kind: 'impression' },
      { postId: p, kind: 'share' },
    ]);
    const learned = await db().query(
      `SELECT (SELECT count(*) FROM user_topic_affinity WHERE user_id = $1) + (SELECT count(*) FROM user_creator_affinity WHERE user_id = $1) AS n`,
      [viewer.id],
    );
    expect(Number(learned.rows[0].n)).toBe(0);
    expect(await stats(p)).toMatchObject({ impressions: 1, shares: 1, saves: 1 });
    // And the feed says nothing personal.
    const items = (await as(t.app, viewer).get('/v1/feed?mode=for_you&limit=50')).body.items as { reasonCode: string }[];
    for (const it of items) expect(['own', 'popular', 'community_popular']).toContain(it.reasonCode);
  });
});

describe('candidates', () => {
  it('finds what people who like what you like engaged with', async () => {
    const viewer = await adult();
    const peer = await adult();
    const a = await adult();
    const b = await adult();
    const shared = await publish(a, 'We both liked this');
    const theirs = await publish(b, 'Only the peer liked this so far');
    // Older than the newest-posts window would reach on a busy site.
    await db().query(`UPDATE posts SET created_at = now() - interval '5 days' WHERE id = $1`, [theirs]);
    await as(t.app, viewer).put(`/v1/posts/${shared}/reaction`, { kind: 'like' });
    await as(t.app, peer).put(`/v1/posts/${shared}/reaction`, { kind: 'like' });
    await as(t.app, peer).put(`/v1/posts/${theirs}/save`);
    const item = (await ranked(viewer)).find((x) => x.id === theirs);
    expect(item?.reason).toEqual({ code: 'similar_people' });
    expect((await as(t.app, viewer).get(`/v1/posts/${theirs}/why`)).body.details).toContainEqual({ code: 'similar_people' });
  });

  it('names the topics and creators you engage with', async () => {
    const viewer = await adult();
    const author = await adult();
    const topic = `liked${tag}`;
    for (let i = 0; i < 3; i++) await as(t.app, viewer).put(`/v1/posts/${await publish(author, `Old #${topic} ${i}`)}/save`);
    const fresh = await publish(author, `New #${topic}`);
    expect((await ranked(viewer)).find((x) => x.id === fresh)?.reason).toEqual({ code: 'liked_creator', params: { name: expect.stringMatching(/^Tester /) } });
    const why = (await as(t.app, viewer).get(`/v1/posts/${fresh}/why`)).body;
    expect(why.details.map((d: { code: string }) => d.code)).toEqual(expect.arrayContaining(['learned_creator', 'learned_topics']));
    expect(why.reasons.join(' ')).toMatch(new RegExp(`spend time on posts about ${topic}`));
  });
});

describe('what you already saw', () => {
  it("doesn't show For you posts again for a few days once you saw them there", async () => {
    const viewer = await adult();
    const author = await adult();
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    const p = await publish(author, 'Seen it');
    await db().query(`UPDATE posts SET created_at = now() - interval '2 days' WHERE id = $1`, [p]);
    expect(await feedIds(viewer)).toContain(p);
    await events(viewer, [{ postId: p, kind: 'impression' }]);
    expect(await feedIds(viewer)).not.toContain(p);
    // Seen in Following is not seen in For you.
    const q = await publish(author, 'Seen elsewhere');
    await db().query(`UPDATE posts SET created_at = now() - interval '2 days' WHERE id = $1`, [q]);
    await events(viewer, [{ postId: q, surface: 'following', kind: 'impression' }]);
    expect(await feedIds(viewer)).toContain(q);
  });

  it("doesn't show a reel you finished for a week", async () => {
    const viewer = await adult();
    const author = await adult();
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    const r = await reel(author, 'Watched to the end');
    expect(await feedIds(viewer, '/v1/reels?limit=20')).toContain(r);
    await events(viewer, [{ postId: r, surface: 'reels', kind: 'complete' }]);
    expect(await feedIds(viewer, '/v1/reels?limit=20')).not.toContain(r);
  });
});

/** A candidate for arrange(), with everything neutral but what a test sets. */
let n = 0;
function cand(over: Partial<Features>): Features {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    authorId: `a${n}`,
    createdAt: new Date(Date.now() - n * 1000),
    topics: [],
    kind: 'text',
    format: 'post',
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
    likes: 5,
    comments: 0,
    impressions: 100,
    completes: 0,
    skips: 0,
    shares: 0,
    saves: 0,
    trend: 0,
    ageHours: 1,
    newCreator: false,
    ...over,
  };
}
const opts = { personalized: true, surface: 'for_you' as const, explore: true, mixFormats: true };

describe('order', () => {
  it('gives one slot in six to a new creator, named as one', async () => {
    const followed = Array.from({ length: 12 }, () => cand({ followed: true, displayName: 'Friend' }));
    const fresh = cand({ newCreator: true, likes: 0, impressions: 0, ageHours: 30 });
    const out = arrange([...followed, fresh], opts);
    expect(out[RANKING.exploration.every - 1]).toEqual({ id: fresh.id, reason: { code: 'new_creator' } });

    // In the real feed too: people you follow come first, and a new creator's post (the best one not seen enough yet) gets the sixth slot.
    const viewer = await adult();
    const people = [await adult(), await adult(), await adult()];
    for (const p of people) {
      await as(t.app, viewer).post(`/v1/users/${p.id}/follow`);
      await publish(p, 'From someone you follow');
      await publish(p, 'And another');
    }
    await publish(await adult(), `My first post ${tag}`);
    const items = (await as(t.app, viewer).get('/v1/feed?mode=for_you&limit=10')).body.items as { author: { id: string }; reasonCode: string }[];
    const slot = RANKING.exploration.every - 1;
    // (Formats mix too, so a video can come between the text posts of people you follow.)
    expect(items.slice(0, slot).filter((it) => people.some((p) => p.id === it.author.id)).length).toBeGreaterThanOrEqual(3);
    expect(items[slot]!.reasonCode).toBe('new_creator');
    expect(people.map((p) => p.id)).not.toContain(items[slot]!.author.id);
  });

  it('keeps any one topic to three in ten, and spreads a busy creator out', () => {
    const hot = Array.from({ length: 8 }, () => cand({ topics: ['hot'], likes: 50 }));
    const warm = Array.from({ length: 8 }, () => cand({ topics: ['warm'], likes: 20 }));
    const rest = Array.from({ length: 10 }, () => cand({ likes: 1 }));
    const out = arrange([...hot, ...warm, ...rest], { ...opts, explore: false });
    const topicOf = new Map([...hot, ...warm, ...rest].map((c) => [c.id, c.topics[0]]));
    const first10 = out.slice(0, 10).map((x) => topicOf.get(x.id));
    expect(first10.filter((x) => x === 'hot').length).toBeLessThanOrEqual(RANKING.diversity.topicMax);
    expect(first10.filter((x) => x === 'warm').length).toBeLessThanOrEqual(RANKING.diversity.topicMax);
    // Nothing is dropped.
    expect(new Set(out.map((x) => x.id)).size).toBe(26);

    const busy = Array.from({ length: 6 }, () => cand({ authorId: 'busy', likes: 8 }));
    const others = Array.from({ length: 6 }, () => cand({ likes: 6 }));
    const order = arrange([...busy, ...others], { ...opts, explore: false }).map((x) => (busy.some((b) => b.id === x.id) ? 'busy' : 'other'));
    expect(order.slice(0, 4).filter((x) => x === 'busy').length).toBe(RANKING.diversity.perAuthor);
    expect(order.filter((x) => x === 'busy').length).toBe(6);
  });

  it('mixes formats in For you', () => {
    const texts = Array.from({ length: 6 }, () => cand({ likes: 30 }));
    const photos = Array.from({ length: 3 }, () => cand({ kind: 'photo', likes: 10 }));
    const out = arrange([...texts, ...photos], { ...opts, explore: false });
    const isText = (id: string) => texts.some((x) => x.id === id);
    expect(out.slice(0, 3).filter((x) => isText(x.id)).length).toBe(RANKING.diversity.formatRun);
  });
});

describe('safety rules still hold', () => {
  it('leaves out blocked and private accounts and posts waiting for review for teens, however much you like them', async () => {
    const topic = `safe${tag}`;
    const viewer = await adult();
    const teen = await signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
    const blocked = await adult();
    const shy = await adult();
    const flagged = await adult();
    const b = await publish(blocked, `#${topic} from someone you'll block`);
    const s = await publish(shy, `#${topic} from a private account`);
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [shy.id]);
    const f = await publish(flagged, `#${topic} waiting for review`);
    await db().query(`UPDATE posts SET moderation_status = 'review' WHERE id = $1`, [f]);
    for (const u of [viewer, teen])
      await db()
        .query(`INSERT INTO user_topic_affinity (user_id, topic, score) VALUES ($1, $2, 30)`, [u.id, topic])
        .catch(() => {});
    await db().query(`INSERT INTO user_creator_affinity (user_id, author_id, score) VALUES ($1,$2,30),($1,$3,30),($1,$4,30),($5,$4,30)`, [
      viewer.id,
      blocked.id,
      shy.id,
      flagged.id,
      teen.id,
    ]);
    await as(t.app, viewer).post(`/v1/users/${blocked.id}/block`);
    const seen = (await ranked(viewer)).map((x) => x.id);
    expect(seen).not.toContain(b);
    expect(seen).not.toContain(s);
    expect(seen).toContain(f);
    expect((await ranked(teen)).map((x) => x.id)).not.toContain(f);
    // Following the private account (accepted) lets its post in.
    await followAccepted(t.app, viewer, shy);
    expect((await ranked(viewer)).map((x) => x.id)).toContain(s);
  });
});

describe('paging', () => {
  it('never repeats a post between pages, even as you like and see posts while scrolling', async () => {
    const viewer = await adult();
    const author = await adult();
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    for (let i = 0; i < 6; i++) await publish(author, `Page post ${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = await as(t.app, viewer).get(`/v1/feed?mode=for_you&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      const ids = (r.body.items as { id: string }[]).map((p) => p.id);
      seen.push(...ids);
      // What you do while scrolling changes scores, but not the order you're paging through.
      await events(
        viewer,
        ids.map((postId) => ({ postId, kind: 'impression' })),
      );
      if (ids[0]) await as(t.app, viewer).put(`/v1/posts/${ids[0]}/reaction`, { kind: 'like' });
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.length).toBeGreaterThan(5);
    expect(new Set(seen).size).toBe(seen.length);
    // A cursor whose kept order is gone ranks again from its moment, and is still taken.
    const made = Buffer.from(JSON.stringify({ asOf: new Date().toISOString(), o: 5, s: '00000000-0000-4000-8000-000000000000' })).toString('base64url');
    expect((await as(t.app, viewer).get(`/v1/feed?mode=for_you&cursor=${made}`)).status).toBe(200);
    const bad = Buffer.from(JSON.stringify({ asOf: new Date().toISOString(), o: 5, s: 'nope' })).toString('base64url');
    expect((await as(t.app, viewer).get(`/v1/feed?mode=for_you&cursor=${bad}`)).status).toBe(400);
  });

  it('pages reels without repeats too', async () => {
    const viewer = await adult();
    const author = await adult();
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    for (let i = 0; i < 4; i++) await reel(author, `Reel ${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const r = await as(t.app, viewer).get(`/v1/reels?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const ids = (r.body.items as { id: string }[]).map((p) => p.id);
      seen.push(...ids);
      await events(
        viewer,
        ids.map((postId) => ({ postId, surface: 'reels', kind: 'complete' })),
      );
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
  });
});
