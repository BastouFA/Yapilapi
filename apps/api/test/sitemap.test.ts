import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PublicSitemap } from '@yapilapi/shared';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
const ADULT = '1990-04-02';
const word = `sitemapword${Math.random().toString(36).slice(2, 8)}`;
const rand = () => Math.random().toString(36).slice(2, 8);
const soon = () => new Date(Date.now() + 3 * 86400_000).toISOString();

beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM regional_rules WHERE term = $1`, [word]);
  await t.close();
});

async function postAs(u: TestUser, body: Record<string, unknown>) {
  const r = await as(t.app, u).post('/v1/posts', body);
  expect(r.status).toBe(201);
  return r.body.post as { id: string };
}

async function sitemap(): Promise<PublicSitemap> {
  const res = await t.app.inject({ method: 'GET', url: '/v1/public/sitemap' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('public, max-age=3600');
  return res.json();
}

describe('public sitemap', () => {
  it('lists public content from public adult accounts only', async () => {
    const adult = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
    await t.ctx.db.query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [teen.id]);
    const hidden = await signUp(t.app, { birthDate: ADULT });
    await as(t.app, hidden).patch('/v1/me/profile', { isPrivate: true });

    const open = await postAs(adult, { body: 'Open to everyone' });
    const followers = await postAs(adult, { body: 'Followers only', visibility: 'followers' });
    const teenPost = await postAs(teen, { body: 'From a teen' });
    const privatePost = await postAs(hidden, { body: 'Public audience, private account' });
    const review = await postAs(adult, { body: 'Waiting for a moderator' });
    await t.ctx.db.query(`UPDATE posts SET moderation_status = 'review' WHERE id = $1`, [review.id]);
    // A regional rule withholds a post in one country: it stays out of the sitemap everywhere.
    await t.ctx.db.query(`INSERT INTO regional_rules (country, kind, term, legal_basis) VALUES ('ZZ', 'blocked_term', $1, 'Sitemap test')`, [word]);
    const withheld = await postAs(adult, { body: `This mentions ${word}` });
    expect((await t.ctx.db.query(`SELECT 1 FROM post_withholdings WHERE post_id = $1`, [withheld.id])).rowCount).toBe(1);

    const map = await sitemap();
    const posts = new Set(map.posts.map((p) => p.id));
    expect(posts.has(open.id)).toBe(true);
    for (const p of [followers, teenPost, privatePost, review, withheld]) expect(posts.has(p.id)).toBe(false);

    const people = new Set(map.profiles.map((p) => p.username));
    expect(people.has(adult.username)).toBe(true);
    expect(people.has(teen.username)).toBe(false);
    expect(people.has(hidden.username)).toBe(false);

    // Only what the sitemap needs: no ids of people, no text.
    const raw = JSON.stringify(map);
    expect(raw).not.toContain(adult.id);
    expect(raw).not.toContain('Open to everyone');
  });

  it('lists tags used by at least three public posts, public communities and public events', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const busy = `sm${rand()}`;
    const quiet = `sm${rand()}`;
    for (let i = 0; i < 3; i++) await postAs(author, { body: `Day ${i} #${busy}` });
    await postAs(author, { body: `Once #${quiet}` });
    await postAs(author, { body: `Twice #${quiet}` });

    const openSlug = `sm-${rand()}`;
    const closedSlug = `sm-${rand()}`;
    await as(t.app, author).post('/v1/communities', { name: 'Open club', slug: openSlug });
    await as(t.app, author).post('/v1/communities', { name: 'Closed club', slug: closedSlug, visibility: 'private' });

    const party = (await as(t.app, author).post('/v1/events', { title: 'Party', startsAt: soon() })).body.event;
    const dinner = (await as(t.app, author).post('/v1/events', { title: 'Dinner', startsAt: soon(), visibility: 'friends' })).body.event;

    const map = await sitemap();
    const tags = map.tags.map((x) => x.tag);
    expect(tags).toContain(busy);
    expect(tags).not.toContain(quiet);
    const slugs = map.communities.map((c) => c.slug.toLowerCase());
    expect(slugs).toContain(openSlug);
    expect(slugs).not.toContain(closedSlug);
    const events = map.events.map((e) => e.id);
    expect(events).toContain(party.id);
    expect(events).not.toContain(dinner.id);
  });
});
