import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * Why a post is in your feed comes as a code and the names it mentions, which the apps put
 * into words in the reader's language; the English sentence stays for older apps.
 */
describe('feed reasons as codes', () => {
  let t: BuiltApp;
  const tag = Date.now().toString(36);
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(() => t.close());

  const person = (displayName: string) => signUp(t.app, { displayName });
  const befriend = async (a: TestUser, b: TestUser) => {
    await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
    await as(t.app, b).post(`/v1/users/${a.id}/friend-request`);
  };
  const publish = async (u: TestUser, body: string, extra: Record<string, unknown> = {}) =>
    (await as(t.app, u).post('/v1/posts', { body, visibility: 'public', ...extra })).body.post as { id: string };
  /** A few likes, so a post from a stranger ranks near the top of a busy test database. */
  const boost = (id: string) => t.ctx.db.query(`UPDATE posts SET like_count = 3 WHERE id = $1`, [id]);
  const inFeed = async (viewer: TestUser, id: string, mode = 'for_you') => {
    const res = await as(t.app, viewer).get(`/v1/feed?mode=${mode}&limit=50`);
    expect(res.status).toBe(200);
    return res.body.items.find((p: { id: string }) => p.id === id);
  };
  const community = async (owner: TestUser, name: string) => {
    const slug = `why-${tag}-${Math.random().toString(36).slice(2, 7)}`;
    const c = (await as(t.app, owner).post('/v1/communities', { name, slug, visibility: 'public' })).body.community;
    return { ...c, slug } as { id: string; slug: string };
  };

  it('says it is your own post', async () => {
    const viewer = await person('Ada');
    const post = await publish(viewer, 'My own words');
    expect(await inFeed(viewer, post.id)).toMatchObject({ reasonCode: 'own', reasonParams: {}, reason: 'Your post' });
  });

  it('names the friend or the person you follow', async () => {
    const viewer = await person('Viewer');
    const friend = await person('Femi');
    const followed = await person('Bola');
    await befriend(viewer, friend);
    await as(t.app, viewer).post(`/v1/users/${followed.id}/follow`);
    const fromFriend = await publish(friend, 'From a friend');
    const fromFollowed = await publish(followed, 'From someone you follow');
    expect(await inFeed(viewer, fromFriend.id)).toMatchObject({
      reasonCode: 'friend',
      reasonParams: { name: 'Femi' },
      reason: "You're friends with Femi",
    });
    expect(await inFeed(viewer, fromFollowed.id)).toMatchObject({
      reasonCode: 'follow',
      reasonParams: { name: 'Bola' },
      reason: 'You follow Bola',
    });
  });

  it('names the community, whether you are in it or it is popular there', async () => {
    const owner = await person('Owner');
    const member = await person('Member');
    const outsider = await person('Outsider');
    const c = await community(owner, 'Kano Cyclists');
    await as(t.app, member).post(`/v1/communities/${c.slug}/join`);
    const post = await publish(owner, 'Ride on Saturday', { communityId: c.id });
    await boost(post.id);
    expect(await inFeed(member, post.id)).toMatchObject({
      reasonCode: 'community_member',
      reasonParams: { community: 'Kano Cyclists' },
      reason: "From Kano Cyclists, a community you're in",
    });
    expect(await inFeed(outsider, post.id)).toMatchObject({
      reasonCode: 'community_popular',
      reasonParams: { community: 'Kano Cyclists' },
      reason: 'Popular in Kano Cyclists',
    });
  });

  it('names the topic you are interested in, or says it is popular', async () => {
    const author = await person('Author');
    const viewer = await person('Curious');
    const topic = `reasontopic${tag}`;
    const onTopic = await publish(author, `All about #${topic}`);
    await as(t.app, viewer).put('/v1/me/interests', { topics: [topic] });
    await boost(onTopic.id);
    expect(await inFeed(viewer, onTopic.id)).toMatchObject({
      reasonCode: 'interest',
      reasonParams: { topic },
      reason: `You're interested in ${topic}`,
    });

    const stranger = await person('Stranger');
    const plain = await publish(stranger, 'Nothing in common');
    await boost(plain.id);
    expect(await inFeed(await person('Someone'), plain.id)).toMatchObject({
      reasonCode: 'popular',
      reasonParams: {},
      reason: 'Popular with people on YAPILAPI right now',
    });
  });

  it('names who reposted it in Following', async () => {
    const viewer = await person('Reader');
    const reposter = await person('Chidi');
    const author = await person('Writer');
    await as(t.app, viewer).post(`/v1/users/${reposter.id}/follow`);
    const post = await publish(author, 'Worth sharing');
    expect((await as(t.app, reposter).put(`/v1/posts/${post.id}/repost`)).status).toBe(200);
    expect(await inFeed(viewer, post.id, 'following')).toMatchObject({
      reasonCode: 'reposted',
      reasonParams: { name: 'Chidi' },
      reason: 'Chidi reposted',
    });
  });

  it('only uses the codes that say nothing personal when personalization is off', async () => {
    const viewer = await person('Private');
    const followed = await person('Kemi');
    await as(t.app, viewer).post(`/v1/users/${followed.id}/follow`);
    const post = await publish(followed, 'Fresh');
    await boost(post.id);
    await as(t.app, viewer).put('/v1/me/consents', { purpose: 'personalization', granted: false });
    const items = (await as(t.app, viewer).get('/v1/feed?mode=for_you&limit=50')).body.items as { id: string; reasonCode: string }[];
    expect(items.find((p) => p.id === post.id)).toMatchObject({ reasonCode: 'popular', reasonParams: {} });
    for (const p of items) expect(['own', 'community_popular', 'popular']).toContain(p.reasonCode);
  });
});

describe('"Why am I seeing this?" as codes', () => {
  let t: BuiltApp;
  const tag = Date.now().toString(36);
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(() => t.close());

  const why = async (viewer: TestUser, id: string) => {
    const res = await as(t.app, viewer).get(`/v1/posts/${id}/why`);
    expect(res.status).toBe(200);
    return res.body as { reasons: string[]; details: unknown[]; controls: string[] };
  };

  it('names a friend, and the topics you follow with a plural', async () => {
    const viewer = await signUp(t.app, { displayName: 'Viewer' });
    const friend = await signUp(t.app, { displayName: 'Femi' });
    await as(t.app, viewer).post(`/v1/users/${friend.id}/friend-request`);
    await as(t.app, friend).post(`/v1/users/${viewer.id}/friend-request`);
    const [a, b] = [`whya${tag}`, `whyb${tag}`];
    const two = (await as(t.app, friend).post('/v1/posts', { body: `#${a} and #${b}`, visibility: 'public' })).body.post;
    const one = (await as(t.app, friend).post('/v1/posts', { body: `Just #${a}`, visibility: 'public' })).body.post;
    await as(t.app, viewer).put('/v1/me/interests', { topics: [a, b] });

    const both = await why(viewer, two.id);
    expect(both.details).toEqual([
      { code: 'friend', params: { name: 'Femi' } },
      { code: 'topics', params: { topics: expect.arrayContaining([a, b]) } },
    ]);
    expect(both.reasons[0]).toBe("You're friends with Femi.");
    // Joined with the catalog's own words ("a and b"), as the phone does without list formatting.
    expect(both.reasons[1]).toMatch(new RegExp(`^You follow the topics (${a} and ${b}|${b} and ${a})\\.$`));
    expect(both.controls).toContain('more_like_this');

    const single = await why(viewer, one.id);
    expect(single.details[1]).toEqual({ code: 'topics', params: { topics: [a] } });
    expect(single.reasons[1]).toBe(`You follow the topic ${a}.`);
  });

  it('names someone you follow and a community you joined, and says when people are engaging', async () => {
    const viewer = await signUp(t.app, { displayName: 'Reader' });
    const author = await signUp(t.app, { displayName: 'Bola' });
    await as(t.app, viewer).post(`/v1/users/${author.id}/follow`);
    const slug = `whyc-${tag}`;
    const c = (await as(t.app, author).post('/v1/communities', { name: 'Lagos Readers', slug, visibility: 'public' })).body.community;
    await as(t.app, viewer).post(`/v1/communities/${slug}/join`);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Book club tonight', communityId: c.id })).body.post;
    await t.ctx.db.query(`UPDATE posts SET like_count = 9 WHERE id = $1`, [post.id]);

    const res = await why(viewer, post.id);
    expect(res.details).toEqual([
      { code: 'follow', params: { name: 'Bola' } },
      { code: 'community', params: { community: 'Lagos Readers' } },
      { code: 'engagement' },
    ]);
    expect(res.reasons).toEqual(['You follow Bola.', 'This is from Lagos Readers, a community you joined.', 'People are engaging with it.']);
  });

  it('falls back when nothing links you, and says when personalization is off', async () => {
    const viewer = await signUp(t.app);
    const stranger = await signUp(t.app);
    const post = (await as(t.app, stranger).post('/v1/posts', { body: 'Hello there', visibility: 'public' })).body.post;
    // A new creator is named as such (new voices get a chance to be seen)...
    expect((await why(viewer, post.id)).details).toEqual([{ code: 'new_creator' }]);
    // ...one who has been around for a while, with a few posts, isn't.
    await t.ctx.db.query(`UPDATE users SET created_at = now() - interval '60 days' WHERE id = $1`, [stranger.id]);
    for (let i = 0; i < 4; i++) await as(t.app, stranger).post('/v1/posts', { body: `Earlier post ${i}`, visibility: 'public' });

    const fallback = await why(viewer, post.id);
    expect(fallback.details).toEqual([{ code: 'fallback' }]);
    expect(fallback.reasons).toEqual(["It's recent and public, and we're still learning what you like."]);

    await as(t.app, viewer).put('/v1/me/consents', { purpose: 'personalization', granted: false });
    const off = await why(viewer, post.id);
    expect(off.details).toEqual([{ code: 'personalization_off' }]);
    expect(off.reasons[0]).toMatch(/^Personalization is off in your settings/);
    expect(off.controls).toEqual(['not_interested', 'mute_topic', 'mute_creator']);
  });
});
