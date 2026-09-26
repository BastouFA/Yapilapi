import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDevWebhook } from '../src/lib/payments.ts';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key IN ('ADS', 'LIVE')`);
  await t.close();
});

const ADULT = '1990-04-02';
const TEEN = '2011-03-01';
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;

async function pay(orderId: string, amountCents: number) {
  const ref = (await t.ctx.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [orderId])).rows[0].provider_ref;
  const payload = JSON.stringify({ id: `evt_${orderId}`, type: 'payment.succeeded', providerRef: ref, amountCents });
  const sig = signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/payments/webhook/dev',
    payload,
    headers: { 'content-type': 'application/json', 'x-signature': sig },
  });
  expect(res.statusCode).toBe(200);
}

describe('community FAQ and similar questions', () => {
  it('lets moderators keep an FAQ and finds earlier answers while someone types', async () => {
    const owner = await signUp(t.app);
    const member = await signUp(t.app);
    const outsider = await signUp(t.app);
    const slug = `faq${Date.now().toString(36)}`;
    const c = await as(t.app, owner).post('/v1/communities', { slug, name: 'Film Photo Club', description: 'Shooting film.', visibility: 'public' });
    expect(c.status).toBe(201);
    await as(t.app, member).post(`/v1/communities/${slug}/join`);

    const faq = await as(t.app, owner).post(`/v1/communities/${slug}/faq`, {
      question: 'Where can I develop film in Lisbon?',
      answer: 'Most of us use the lab on Rua da Rosa.',
    });
    expect(faq.status).toBe(201);
    expect((await as(t.app, member).post(`/v1/communities/${slug}/faq`, { question: 'Can members add entries?', answer: 'No' })).status).toBe(403);

    const post = await as(t.app, member).post('/v1/posts', { body: 'Which film stock is best for night street photos?', communityId: c.body.community.id });
    expect(post.status).toBe(201);

    const similar = await as(t.app, outsider).get(`/v1/communities/${slug}/similar?q=${encodeURIComponent('where to develop film in lisbon')}`);
    expect(similar.status).toBe(200);
    expect(similar.body.faq[0].question).toBe('Where can I develop film in Lisbon?');
    const similarPost = await as(t.app, outsider).get(`/v1/communities/${slug}/similar?q=${encodeURIComponent('best film stock for night street photos')}`);
    expect(similarPost.body.posts[0].post.id).toBe(post.body.post.id);

    const list = await as(t.app, outsider).get(`/v1/communities/${slug}/faq`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.canEdit).toBe(false);
    expect((await as(t.app, owner).del(`/v1/communities/${slug}/faq/${faq.body.faq.id}`)).status).toBe(204);
  });

  it('keeps a private community FAQ to members', async () => {
    const owner = await signUp(t.app);
    const outsider = await signUp(t.app);
    const slug = `pfaq${Date.now().toString(36)}`;
    await as(t.app, owner).post('/v1/communities', { slug, name: 'Private club', visibility: 'private' });
    expect((await as(t.app, outsider).get(`/v1/communities/${slug}/faq`)).status).toBe(403);
    expect((await as(t.app, outsider).get(`/v1/communities/${slug}/similar?q=anything%20at%20all`)).status).toBe(403);
  });
});

describe('sponsored posts', () => {
  it('serves a paid campaign only to consenting adults and charges per impression', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('ADS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const shop = await signUp(t.app, { birthDate: ADULT });
    const optedIn = await signUp(t.app, { birthDate: ADULT });
    const noConsent = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: TEEN });

    const post = (await as(t.app, shop).post('/v1/posts', { body: 'New ceramics drop this Saturday' })).body.post;
    const privatePost = (await as(t.app, shop).post('/v1/posts', { body: 'Just me', visibility: 'private' })).body.post;
    expect((await as(t.app, shop).post('/v1/ads/campaigns', { postId: privatePost.id, name: 'Nope' })).status).toBe(400);
    expect((await as(t.app, optedIn).post('/v1/ads/campaigns', { postId: post.id, name: 'Not mine' })).status).toBe(403);

    // A topic only this test's viewers follow, so ads from other suites sharing the test database never compete.
    const topic = `adtest${Math.random().toString(36).slice(2, 8)}`;
    for (const u of [optedIn, noConsent, teen]) await as(t.app, u).put('/v1/me/interests', { topics: [topic] });
    const camp = await as(t.app, shop).post('/v1/ads/campaigns', { postId: post.id, name: 'Saturday drop', cpmCents: 1000, topics: [topic] });
    expect(camp.status).toBe(201);
    const id = camp.body.campaign.id;
    // No budget yet: can't start.
    expect((await as(t.app, shop).patch(`/v1/ads/campaigns/${id}`, { status: 'active' })).status).toBe(409);
    const fund = await as(t.app, shop).post(`/v1/ads/campaigns/${id}/fund`, { amountCents: 500, idempotencyKey: key() });
    expect(fund.status).toBe(201);
    // Budget only lands when the payment is confirmed.
    expect((await as(t.app, shop).get('/v1/ads/campaigns')).body.items[0].budgetCents).toBe(0);
    await pay(fund.body.payment.orderId, 500);
    expect((await as(t.app, shop).get('/v1/ads/campaigns')).body.items[0].budgetCents).toBe(500);
    expect((await as(t.app, shop).patch(`/v1/ads/campaigns/${id}`, { status: 'active' })).body.campaign.status).toBe('pending_review');
    // A moderator approves it before it runs (see review-regions-business.test.ts for the review flow).
    const reviewer = await signUp(t.app, { birthDate: ADULT });
    await t.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [reviewer.id]);
    const cases = (await as(t.app, reviewer).get('/v1/admin/moderation/cases')).body.items;
    const mc = cases.find((c: any) => c.target_id === id);
    expect((await as(t.app, reviewer).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'approve_ad' })).status).toBe(200);

    await as(t.app, optedIn).put('/v1/me/consents', { purpose: 'advertising', granted: true });
    await as(t.app, teen).put('/v1/me/consents', { purpose: 'advertising', granted: true });

    expect((await as(t.app, noConsent).get('/v1/ads/next')).body.ad).toBeNull();
    expect((await as(t.app, teen).get('/v1/ads/next')).body.ad).toBeNull();
    expect((await as(t.app, shop).get('/v1/ads/next')).body.ad).toBeNull(); // never your own

    const served = await as(t.app, optedIn).get('/v1/ads/next');
    expect(served.body.ad.label).toBe('Sponsored');
    expect(served.body.ad.post.id).toBe(post.id);
    expect(served.body.ad.why[0]).toMatch(/advertising/);
    expect(served.body.ad.why[1]).toMatch(new RegExp(topic));
    expect((await as(t.app, optedIn).post(`/v1/ads/${id}/click`)).status).toBe(200);
    expect((await as(t.app, noConsent).post(`/v1/ads/${id}/click`)).status).toBe(404); // never shown to them

    // $10 CPM = 1 cent per impression.
    const stats = await as(t.app, shop).get(`/v1/ads/campaigns/${id}/stats`);
    expect(stats.body.campaign.impressions).toBe(1);
    expect(stats.body.campaign.clicks).toBe(1);
    expect(stats.body.campaign.spentCents).toBe(1);
    expect(stats.body.days[0].reach).toBe(1);

    // Frequency cap of three a day, and hiding stops it.
    await as(t.app, optedIn).get('/v1/ads/next');
    await as(t.app, optedIn).get('/v1/ads/next');
    expect((await as(t.app, optedIn).get('/v1/ads/next')).body.ad).toBeNull();
    await as(t.app, optedIn).post(`/v1/ads/${id}/hide`);
    const other = await signUp(t.app, { birthDate: ADULT });
    await as(t.app, other).put('/v1/me/consents', { purpose: 'advertising', granted: true });
    await as(t.app, other).put('/v1/me/interests', { topics: [topic] });
    expect((await as(t.app, other).get('/v1/ads/next')).body.ad.campaignId).toBe(id);
  });
});

describe('family links', () => {
  it('lets a teen accept supervision, applies message controls and tracks minutes', async () => {
    const parent = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: TEEN });
    const stranger = await signUp(t.app, { birthDate: TEEN });
    const adult = await signUp(t.app, { birthDate: ADULT });

    expect((await as(t.app, parent).post('/v1/family/invite', { username: adult.username })).status).toBe(400);
    expect((await as(t.app, teen).post('/v1/family/invite', { username: stranger.username })).status).toBe(403);
    const inv = await as(t.app, parent).post('/v1/family/invite', { username: teen.username });
    expect(inv.status).toBe(201);
    const linkId = inv.body.link.id;
    // The guardian can't set anything until the teen accepts.
    const controls = { messagesFrom: 'nobody', dailyLimitMinutes: 60, quietStart: '22:00', quietEnd: '07:00', timezone: 'Europe/Lisbon' };
    expect((await as(t.app, parent).put(`/v1/family/${linkId}/controls`, controls)).status).toBe(403);
    expect((await as(t.app, parent).post(`/v1/family/${linkId}/accept`)).status).toBe(403);
    expect((await as(t.app, teen).post(`/v1/family/${linkId}/accept`)).status).toBe(200);

    // Default after accepting: friends only. Two teens who aren't friends can't message.
    const dm = await as(t.app, stranger).post('/v1/conversations', { kind: 'direct', memberIds: [teen.id] });
    expect(dm.status).toBe(403);

    expect((await as(t.app, parent).put(`/v1/family/${linkId}/controls`, { ...controls, quietEnd: null })).status).toBe(400);
    expect((await as(t.app, parent).put(`/v1/family/${linkId}/controls`, controls)).status).toBe(200);
    // Guardians can always reach the teen.
    expect((await as(t.app, parent).post('/v1/conversations', { kind: 'direct', memberIds: [teen.id] })).status).toBe(201);

    const beat = await as(t.app, teen).post('/v1/me/usage/heartbeat');
    expect(beat.body).toMatchObject({ minutesToday: 1, dailyLimitMinutes: 60, overLimit: false, supervised: true });
    // A second beat within 50 seconds doesn't double count.
    expect((await as(t.app, teen).post('/v1/me/usage/heartbeat')).body.minutesToday).toBe(1);

    const guardianView = await as(t.app, parent).get('/v1/family');
    expect(guardianView.body.items[0]).toMatchObject({ role: 'guardian', status: 'active', controls: { messagesFrom: 'nobody', dailyLimitMinutes: 60 } });
    expect(guardianView.body.items[0].usage[0].minutes).toBe(1);
    const teenView = await as(t.app, teen).get('/v1/family');
    expect(teenView.body.items[0].role).toBe('teen');
    expect(teenView.body.items[0].usage).toBeUndefined();

    // The teen can end it; the guardian is told and controls stop applying.
    expect((await as(t.app, teen).post(`/v1/family/${linkId}/end`)).body.status).toBe('ended');
    const notes = await t.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'family_ended'`, [parent.id]);
    expect(notes.rowCount).toBe(1);
    expect((await as(t.app, teen).post('/v1/me/usage/heartbeat')).body.supervised).toBe(false);
  });
});

describe('live gifts', () => {
  it('posts a paid tip into the live chat as a gift', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const host = await signUp(t.app, { birthDate: ADULT });
    const fan = await signUp(t.app, { birthDate: ADULT });
    const live = (await as(t.app, host).post('/v1/live', { title: 'Studio session' })).body.live;
    await as(t.app, host).post(`/v1/live/${live.id}/start`);
    await as(t.app, fan).post(`/v1/live/${live.id}/join`);
    const tip = await as(t.app, fan).post(`/v1/users/${host.id}/tips`, {
      amountCents: 300,
      message: 'Play the new one',
      liveId: live.id,
      idempotencyKey: key(),
    });
    expect(tip.status).toBe(201);
    // Nothing in chat until the payment is confirmed.
    expect((await as(t.app, host).get(`/v1/live/${live.id}/chat`)).body.items.filter((m: any) => m.kind === 'gift')).toHaveLength(0);
    await pay(tip.body.payment.orderId, 300);
    const gifts = (await as(t.app, host).get(`/v1/live/${live.id}/chat`)).body.items.filter((m: any) => m.kind === 'gift');
    expect(gifts).toHaveLength(1);
    expect(gifts[0]).toMatchObject({ body: 'Play the new one', amountCents: 300, currency: 'USD' });
    expect(gifts[0].author.id).toBe(fan.id);
  });
});

describe('sensitive content and minors', () => {
  it('hides posts waiting for review from under-18 viewers only', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const adult = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: TEEN });
    const post = (await as(t.app, author).post('/v1/posts', { body: 'A post a moderator needs to look at' })).body.post;
    await t.ctx.db.query(`UPDATE posts SET moderation_status = 'review' WHERE id = $1`, [post.id]);
    expect((await as(t.app, adult).get(`/v1/posts/${post.id}`)).status).toBe(200);
    expect((await as(t.app, teen).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, author).get(`/v1/posts/${post.id}`)).status).toBe(200);
    await t.ctx.db.query(`UPDATE posts SET moderation_status = 'normal' WHERE id = $1`, [post.id]);
    expect((await as(t.app, teen).get(`/v1/posts/${post.id}`)).status).toBe(200);
  });
});

describe('ticketed lives and live shopping', () => {
  it('only gives playback to ticket holders and lets the host pin products', async () => {
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
    const host = await signUp(t.app, { birthDate: ADULT });
    const fan = await signUp(t.app, { birthDate: ADULT });
    const other = await signUp(t.app, { birthDate: ADULT });
    const ticket = (await as(t.app, host).post('/v1/products', { kind: 'ticket', title: 'Concert pass', priceCents: 800 })).body.product;
    const mug = (await as(t.app, host).post('/v1/products', { title: 'Tour mug', priceCents: 1500 })).body.product;
    const notTicket = (await as(t.app, other).post('/v1/products', { kind: 'ticket', title: 'Not yours', priceCents: 100 })).body.product;

    expect((await as(t.app, host).post('/v1/live', { title: 'Nope', ticketProductId: notTicket.id })).status).toBe(403);
    expect((await as(t.app, host).post('/v1/live', { title: 'Nope', ticketProductId: mug.id })).status).toBe(400);
    const live = (await as(t.app, host).post('/v1/live', { title: 'Paid concert', ticketProductId: ticket.id })).body.live;
    expect(live.ticket).toMatchObject({ productId: ticket.id, priceCents: 800, hasTicket: true });
    await as(t.app, host).post(`/v1/live/${live.id}/start`);

    const before = (await as(t.app, fan).get(`/v1/live/${live.id}`)).body.live;
    expect(before.ticket.hasTicket).toBe(false);
    expect(before.playbackUrl).toBeNull();
    const refused = await as(t.app, fan).post(`/v1/live/${live.id}/join`);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('ticket_required');

    const order = await as(t.app, fan).post('/v1/orders', { items: [{ productId: ticket.id, quantity: 1 }], idempotencyKey: key() });
    await pay(order.body.order.id, 800);
    const joined = await as(t.app, fan).post(`/v1/live/${live.id}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.live.playbackUrl).toMatch(/token=/);

    // Live shopping
    expect((await as(t.app, fan).post(`/v1/live/${live.id}/products`, { productId: mug.id })).status).toBe(403);
    expect((await as(t.app, host).post(`/v1/live/${live.id}/products`, { productId: notTicket.id })).status).toBe(403);
    expect((await as(t.app, host).post(`/v1/live/${live.id}/products`, { productId: mug.id })).status).toBe(200);
    expect((await as(t.app, host).post(`/v1/live/${live.id}/products`, { productId: mug.id })).status).toBe(200); // re-pin is fine
    expect((await as(t.app, fan).get(`/v1/live/${live.id}/products`)).body.items.map((p: any) => p.title)).toEqual(['Tour mug']);
    await as(t.app, host).del(`/v1/live/${live.id}/products/${mug.id}`);
    expect((await as(t.app, fan).get(`/v1/live/${live.id}/products`)).body.items).toEqual([]);
    expect((await as(t.app, host).patch(`/v1/live/${live.id}`, { ticketProductId: null })).status).toBe(400); // already started
  });
});
