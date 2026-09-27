import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;

async function pay(user: TestUser, orderId: string) {
  const r = await as(t.app, user).post('/v1/payments/dev/complete', { orderId });
  expect(r.status).toBe(200);
}

describe('Studio on the phone', () => {
  let creator: TestUser;
  let fan: TestUser;
  let other: TestUser;
  let post: { id: string };
  let reel: { id: string };

  beforeAll(async () => {
    [creator, fan, other] = await Promise.all([adult(), adult(), adult()]);
    post = (await as(t.app, creator).post('/v1/posts', { body: 'Jollof recipe', visibility: 'public' })).body.post;
    reel = (
      await as(t.app, creator).post('/v1/posts', {
        format: 'reel',
        body: 'Dance',
        media: [{ url: `https://cdn.example.test/r${Date.now()}.mp4`, kind: 'video' }],
      })
    ).body.post;
    for (const viewer of [fan, other]) {
      await as(t.app, viewer).post(`/v1/posts/${post.id}/view`);
      await as(t.app, viewer).post(`/v1/posts/${reel.id}/view`);
    }
    // The author's own views never count.
    await as(t.app, creator).post(`/v1/posts/${reel.id}/view`);
    await as(t.app, fan).put(`/v1/posts/${post.id}/reaction`, { kind: 'like' });
    await as(t.app, fan).put(`/v1/posts/${post.id}/save`);
  });

  it('adds views, reach and top reels to the 28-day analytics', async () => {
    const r = await as(t.app, creator).get('/v1/creator/analytics');
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ views: 4, reach: 2 });
    expect(Number(r.body.totals.posts)).toBe(2);
    expect(r.body.topPosts.map((p: { id: string }) => p.id)).toEqual([post.id]);
    expect(r.body.topReels.map((p: { id: string }) => p.id)).toEqual([reel.id]);
    expect(r.body.topReels[0]).toMatchObject({ format: 'reel', view_count: 2 });
    expect(r.body.followerGrowth).toHaveLength(28);
  });

  it("shows a post's insights to its author only", async () => {
    const r = await as(t.app, creator).get(`/v1/posts/${post.id}/insights`);
    expect(r.status).toBe(200);
    expect(r.body.insights).toMatchObject({ postId: post.id, format: 'post', views: 2, likes: 1, saves: 1, comments: 0, reposts: 0 });
    expect(r.body.insights.viewsByDay).toHaveLength(28);
    expect(r.body.insights.viewsByDay.reduce((a: number, d: { views: number }) => a + d.views, 0)).toBe(2);
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}/insights`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/posts/${post.id}/insights`)).status).toBe(401);
  });

  it('lists your payout requests with their status', async () => {
    await t.ctx.db.query(`INSERT INTO payouts (user_id, amount_cents, currency, status) VALUES ($1, 700, 'USD', 'verified')`, [creator.id]);
    const r = await as(t.app, creator).get('/v1/me/payouts');
    expect(r.body.items).toEqual([expect.objectContaining({ amountCents: 700, currency: 'USD', status: 'verified' })]);
    expect((await as(t.app, fan).get('/v1/me/payouts')).body.items).toEqual([]);
  });

  it('lists paid tips you sent and got, and leaves out unpaid ones', async () => {
    const paid = await as(t.app, fan).post(`/v1/users/${creator.id}/tips`, {
      amountCents: 300,
      currency: 'USD',
      message: 'Thank you',
      postId: post.id,
      idempotencyKey: key(),
    });
    expect(paid.status).toBe(201);
    await pay(fan, paid.body.payment.orderId);
    // Started but never paid.
    await as(t.app, other).post(`/v1/users/${creator.id}/tips`, { amountCents: 500, currency: 'USD', idempotencyKey: key() });

    const got = (await as(t.app, creator).get('/v1/me/tips?direction=received')).body;
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ amountCents: 300, currency: 'USD', message: 'Thank you', postId: post.id, gift: false });
    expect(got.items[0].person.id).toBe(fan.id);
    const sent = (await as(t.app, fan).get('/v1/me/tips?direction=sent')).body;
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0].person.id).toBe(creator.id);
    expect((await as(t.app, other).get('/v1/me/tips?direction=sent')).body.items).toEqual([]);
    expect((await as(t.app, fan).get('/v1/me/tips?direction=sideways')).status).toBe(400);
  });
});
