import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDevWebhook } from '../src/lib/payments.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let admin: TestUser;
beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('ADS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
  admin = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'ADS'`);
  await t.ctx.db.query(`DELETE FROM regional_rules WHERE term LIKE 'forbiddenword%' OR topic LIKE 'testtopic%'`);
  await t.close();
});

const ADULT = '1990-04-02';
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
const tag = () => Math.random().toString(36).slice(2, 8);

async function fundedCampaign(owner: TestUser, body: string, topic = `adrev${tag()}`) {
  const post = (await as(t.app, owner).post('/v1/posts', { body })).body.post;
  const camp = (await as(t.app, owner).post('/v1/ads/campaigns', { postId: post.id, name: `Camp ${tag()}`, topics: [topic] })).body.campaign;
  const fund = await as(t.app, owner).post(`/v1/ads/campaigns/${camp.id}/fund`, { amountCents: 1000, idempotencyKey: key() });
  const ref = (await t.ctx.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [fund.body.payment.orderId])).rows[0].provider_ref;
  const payload = JSON.stringify({ id: `evt_${fund.body.payment.orderId}`, type: 'payment.succeeded', providerRef: ref, amountCents: 1000 });
  await t.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook/dev',
    payload,
    headers: { 'content-type': 'application/json', 'x-signature': signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload) },
  });
  return { post, camp };
}

async function caseFor(campaignId: string) {
  const list = await as(t.app, admin).get('/v1/admin/moderation/cases');
  return list.body.items.find((c: any) => c.target_id === campaignId);
}

describe('ad review', () => {
  it('holds a new campaign for review, then runs it once approved', async () => {
    const shop = await signUp(t.app, { birthDate: ADULT });
    const viewer = await signUp(t.app, { birthDate: ADULT });
    await as(t.app, viewer).put('/v1/me/consents', { purpose: 'advertising', granted: true });
    // Targeted at a topic only this viewer follows, so ads from other suites never compete.
    const topic = `adrev${tag()}`;
    await as(t.app, viewer).put('/v1/me/interests', { topics: [topic] });
    const { camp, post } = await fundedCampaign(shop, 'Handmade mugs, new colours', topic);

    const start = await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'active' });
    expect(start.body.campaign.status).toBe('pending_review');
    expect((await as(t.app, viewer).get('/v1/ads/next')).body.ad).toBeNull();
    expect((await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'paused' })).status).toBe(409);

    const mc = await caseFor(camp.id);
    expect(mc).toMatchObject({ source: 'ad_review', excerpt: 'Handmade mugs, new colours' });
    // Ad cases take ad decisions only.
    expect((await as(t.app, admin).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'remove' })).status).toBe(400);
    expect((await as(t.app, admin).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'approve_ad' })).status).toBe(200);

    expect((await as(t.app, shop).get('/v1/ads/campaigns')).body.items.find((c: any) => c.id === camp.id).status).toBe('active');
    expect((await as(t.app, viewer).get('/v1/ads/next')).body.ad.post.id).toBe(post.id);
    const note = await t.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'ad_approved'`, [shop.id]);
    expect(note.rowCount).toBe(1);
    // No enforcement record: approving an ad isn't a penalty.
    expect((await t.ctx.db.query(`SELECT 1 FROM enforcements WHERE case_id = $1`, [mc.id])).rowCount).toBe(0);

    // Pause and resume without a new review, unless the post is edited.
    await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'paused' });
    expect((await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'active' })).body.campaign.status).toBe('active');
    await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'paused' });
    await t.ctx.db.query(`UPDATE posts SET body = 'Handmade mugs, now half price' WHERE id = $1`, [post.id]);
    expect((await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'active' })).body.campaign.status).toBe('pending_review');
  });

  it('tells the advertiser why a campaign was rejected', async () => {
    const shop = await signUp(t.app, { birthDate: ADULT });
    const { camp } = await fundedCampaign(shop, 'Our weekend market stall');
    await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'active' });
    const mc = await caseFor(camp.id);
    expect((await as(t.app, admin).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'reject_ad' })).status).toBe(400);
    await as(t.app, admin).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'reject_ad', note: 'Prices must be shown in the post.' });
    const c = (await as(t.app, shop).get('/v1/ads/campaigns')).body.items.find((x: any) => x.id === camp.id);
    expect(c).toMatchObject({ status: 'rejected', reviewNote: 'Prices must be shown in the post.' });
    const n = await t.ctx.db.query(`SELECT data FROM notifications WHERE user_id = $1 AND type = 'ad_rejected'`, [shop.id]);
    expect(n.rows[0].data.note).toBe('Prices must be shown in the post.');
  });

  it('lets the advertiser withdraw a campaign under review', async () => {
    const shop = await signUp(t.app, { birthDate: ADULT });
    const { camp } = await fundedCampaign(shop, 'Pottery class spots open');
    await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'active' });
    expect((await as(t.app, shop).patch(`/v1/ads/campaigns/${camp.id}`, { status: 'ended' })).body.campaign.status).toBe('ended');
    expect(await caseFor(camp.id)).toBeUndefined();
  });
});

describe('regional rules', () => {
  it('withholds matching posts only for viewers in that country, and tells the author', async () => {
    const author = await signUp(t.app);
    const here = await signUp(t.app);
    const elsewhere = await signUp(t.app);
    await as(t.app, here).patch('/v1/me/profile', { country: 'zz' });
    await as(t.app, elsewhere).patch('/v1/me/profile', { country: 'YY' });
    const word = `forbiddenword${tag()}`;
    const before = (await as(t.app, author).post('/v1/posts', { body: `A post that says ${word} in it` })).body.post;
    const topicPost = (await as(t.app, author).post('/v1/posts', { body: 'About a topic', topics: [`testtopic${word.slice(-4)}`] })).body.post;

    expect(
      (await as(t.app, here).post('/v1/admin/regional-rules', { kind: 'blocked_term', country: 'ZZ', term: word, legalBasis: 'Test order 1' })).status,
    ).toBe(403);
    const rule = await as(t.app, admin).post('/v1/admin/regional-rules', { kind: 'blocked_term', country: 'zz', term: word, legalBasis: 'Test order 1' });
    expect(rule.status).toBe(201);
    expect(rule.body.rule.withheldPosts).toBe(1); // applied to existing posts
    await as(t.app, admin).post('/v1/admin/regional-rules', {
      kind: 'restrict_topic',
      country: 'ZZ',
      topic: `testtopic${word.slice(-4)}`,
      legalBasis: 'Test order 2',
    });
    // Applied to posts written after the rule too.
    const after = (await as(t.app, author).post('/v1/posts', { body: `Later: ${word.toUpperCase()}` })).body.post;

    for (const id of [before.id, topicPost.id, after.id]) {
      expect((await as(t.app, here).get(`/v1/posts/${id}`)).status).toBe(404);
      expect((await as(t.app, elsewhere).get(`/v1/posts/${id}`)).status).toBe(200);
    }
    const own = await as(t.app, author).get(`/v1/posts/${before.id}`);
    expect(own.body.post.withheldIn).toEqual(['ZZ']);
    expect((await as(t.app, elsewhere).get(`/v1/posts/${before.id}`)).body.post.withheldIn).toBeUndefined();

    // Removing the rule lifts it.
    expect((await as(t.app, admin).del(`/v1/admin/regional-rules/${rule.body.rule.id}`)).status).toBe(204);
    expect((await as(t.app, here).get(`/v1/posts/${before.id}`)).status).toBe(200);
    const audit = await t.ctx.db.query(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`, [rule.body.rule.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['regional_rule.create', 'regional_rule.delete']);
  });

  it('keeps a chosen country over the CDN header and exposes it on the account', async () => {
    const u = await signUp(t.app);
    await as(t.app, u).patch('/v1/me/profile', { country: 'pt' });
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.country).toBe('PT');
    await as(t.app, u).patch('/v1/me/profile', { country: null });
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.country).toBeNull();
  });
});

describe('business insights', () => {
  it('counts visits, bookings and reviews for the owner only', async () => {
    const owner = await signUp(t.app, { birthDate: ADULT });
    const guest = await signUp(t.app, { birthDate: ADULT });
    const slug = `insight-${tag()}`;
    const biz = (await as(t.app, owner).post('/v1/businesses', { name: 'Insight Bistro', slug })).body.business;
    const place = (await as(t.app, owner).post('/v1/places', { name: 'Insight Bistro', category: 'restaurant', businessId: biz.id })).body.place;
    await t.ctx.db.query(`UPDATE places SET booking_capacity = 20 WHERE id = $1`, [place.id]);

    await as(t.app, owner).get(`/v1/businesses/${slug}`); // the owner's own visit isn't counted
    await as(t.app, guest).get(`/v1/businesses/${slug}`);
    await as(t.app, guest).get(`/v1/businesses/${slug}`); // once per person per day
    await as(t.app, guest).get(`/v1/places/${place.id}`);
    await as(t.app, guest).put(`/v1/places/${place.id}/reviews`, { rating: 5, body: 'Great soup' });
    const booking = await as(t.app, guest).post(`/v1/places/${place.id}/bookings`, {
      partySize: 3,
      startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect(booking.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50)); // view inserts are fire-and-forget

    expect((await as(t.app, guest).get(`/v1/businesses/${biz.id}/analytics`)).status).toBe(403);
    const a = await as(t.app, owner).get(`/v1/businesses/${biz.id}/analytics`);
    expect(a.status).toBe(200);
    expect(a.body.views).toEqual([expect.objectContaining({ business: 1, places: 1, visitors: 1 })]);
    expect(a.body.bookingsByStatus.requested).toEqual({ bookings: 1, guests: 3 });
    expect(a.body.upcomingBookings).toBe(1);
    expect(a.body.reviews).toEqual({ count: 1, average: 5 });
    expect(a.body.ratingTrend[0].average).toBe(5);
  });
});
