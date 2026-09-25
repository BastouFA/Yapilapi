import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { signDevWebhook } from '../src/lib/payments.ts';
import { parseSearchIntent } from '../src/lib/ai/intent.ts';
import { analyzeText } from '../src/lib/moderation.ts';

describe('events, places and commerce', () => {
  let t: BuiltApp;
  let host: TestUser;
  let guest: TestUser;
  let other: TestUser;
  beforeAll(async () => {
    t = await testApp();
    host = await signUp(t.app);
    guest = await signUp(t.app);
    other = await signUp(t.app);
  });
  afterAll(() => t.close());

  it('runs the event lifecycle with capacity and a waitlist', async () => {
    const startsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    const ev = await as(t.app, host).post('/v1/events', { title: 'Rooftop jazz', startsAt, capacity: 2 });
    expect(ev.status).toBe(201);
    const id = ev.body.event.id;
    expect(ev.body.event.counts.going).toBe(1); // the host
    expect((await as(t.app, guest).post(`/v1/events/${id}/rsvp`, { status: 'going' })).body.status).toBe('going');
    expect((await as(t.app, other).post(`/v1/events/${id}/rsvp`, { status: 'going' })).body.status).toBe('waitlist');
    const tonight = await as(t.app, guest).get(`/v1/search?q=${encodeURIComponent('something to do tonight')}`);
    expect(tonight.body.intent.when.label).toBe('tonight');
    expect(tonight.body.results.events.some((e: { id: string }) => e.id === id)).toBe(true);
    const bad = await as(t.app, host).post('/v1/events', { title: 'Backwards', startsAt, endsAt: new Date(Date.now()).toISOString() });
    expect(bad.status).toBe(400);
  });

  it('creates a business, a place and a product, then sells it idempotently', async () => {
    const biz = await as(t.app, host).post('/v1/businesses', { name: 'Test Bakery', slug: `bakery-${Date.now().toString(36)}` });
    expect(biz.status).toBe(201);
    const place = await as(t.app, host).post('/v1/places', {
      name: 'Test Bakery',
      category: 'restaurant',
      city: 'Lisbon',
      lat: 38.72,
      lng: -9.14,
      businessId: biz.body.business.id,
    });
    expect(place.status).toBe(201);
    const near = await as(t.app, guest).get('/v1/places?lat=38.72&lng=-9.14&radiusKm=2');
    expect(near.body.items.some((p: { id: string }) => p.id === place.body.place.id)).toBe(true);

    const product = await as(t.app, host).post('/v1/products', {
      title: 'Sourdough loaf',
      priceCents: 650,
      currency: 'eur',
      inventory: 3,
      businessId: biz.body.business.id,
    });
    expect(product.body.product.currency).toBe('EUR');
    const pid = product.body.product.id;

    expect((await as(t.app, host).post('/v1/orders', { items: [{ productId: pid, quantity: 1 }], idempotencyKey: 'self-buy-1' })).status).toBe(400);

    const order = await as(t.app, guest).post('/v1/orders', { items: [{ productId: pid, quantity: 2 }], idempotencyKey: 'order-key-001' });
    expect(order.status).toBe(201);
    expect(order.body.order.totalCents).toBe(1300);
    expect(order.body.order.platformFeeCents).toBe(65);
    const replay = await as(t.app, guest).post('/v1/orders', { items: [{ productId: pid, quantity: 2 }], idempotencyKey: 'order-key-001' });
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.order.id).toBe(order.body.order.id);

    // Complete payment through a signed webhook; replays are ignored.
    const providerRef = (await t.ctx.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [order.body.order.id])).rows[0].provider_ref;
    const payload = JSON.stringify({ id: `evt_${Date.now()}`, type: 'payment.succeeded', providerRef, amountCents: 1300 });
    const unsigned = await t.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook/dev',
      payload,
      headers: { 'content-type': 'application/json', 'x-signature': 'nope' },
    });
    expect(unsigned.statusCode).toBe(400);
    const sig = signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook/dev',
      payload,
      headers: { 'content-type': 'application/json', 'x-signature': sig },
    });
    expect(ok.json()).toEqual({ ok: true });
    const dup = await t.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook/dev',
      payload,
      headers: { 'content-type': 'application/json', 'x-signature': sig },
    });
    expect(dup.json().duplicate).toBe(true);

    expect((await as(t.app, guest).get(`/v1/orders/${order.body.order.id}`)).body.order.status).toBe('paid');
    const stock = await t.ctx.db.query(`SELECT inventory FROM products WHERE id = $1`, [pid]);
    expect(stock.rows[0].inventory).toBe(1);

    const earnings = await as(t.app, host).get('/v1/me/earnings');
    expect(earnings.body.balances[0]).toMatchObject({ currency: 'EUR', grossCents: 1300, feeCents: 65, availableCents: 1235 });

    // Only the seller (or an admin) can refund.
    expect((await as(t.app, other).post(`/v1/orders/${order.body.order.id}/refund`, {})).status).toBe(404);
    expect((await as(t.app, host).post(`/v1/orders/${order.body.order.id}/refund`, { reason: 'Burnt' })).body.status).toBe('succeeded');
    // Out of stock is enforced.
    const tooMany = await as(t.app, other).post('/v1/orders', { items: [{ productId: pid, quantity: 5 }], idempotencyKey: 'order-key-002' });
    expect(tooMany.status).toBe(409);
  });
});

describe('trust, safety and privacy', () => {
  let t: BuiltApp;
  let a: TestUser;
  let b: TestUser;
  let admin: TestUser;
  beforeAll(async () => {
    t = await testApp();
    a = await signUp(t.app);
    b = await signUp(t.app);
    admin = await signUp(t.app);
    await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
    await t.ctx.db.query(`DELETE FROM feature_flags`);
  });
  afterAll(() => t.close());

  it('blocking hides profiles and prevents messages', async () => {
    await as(t.app, a).post(`/v1/users/${b.id}/follow`);
    expect((await as(t.app, b).post(`/v1/users/${a.id}/block`)).body.blocked).toBe(true);
    expect((await as(t.app, a).get(`/v1/users/${b.username}`)).status).toBe(404);
    expect((await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] })).status).toBe(403);
    expect((await as(t.app, a).post(`/v1/users/${b.id}/follow`)).status).toBe(404);
    await as(t.app, b).del(`/v1/users/${a.id}/block`);
  });

  it('protects minors from unsolicited messages', async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-01-01` });
    const r = await as(t.app, a).post('/v1/conversations', { memberIds: [teen.id] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('minor_protection');
    const prof = await as(t.app, teen).get(`/v1/users/${teen.username}`);
    expect(prof.body.profile.isPrivate).toBe(true);
    const tooYoung = await as(t.app, null).post('/v1/auth/register', {
      email: 'kid@example.test',
      password: 'long-enough-pass',
      username: 'kiddo_test',
      displayName: 'Kid',
      birthDate: `${new Date().getFullYear() - 10}-01-01`,
    });
    expect(tooYoung.status).toBe(400);
  });

  it('routes automated flags and reports to moderators, with appeals', async () => {
    const spam = await as(t.app, a).post('/v1/posts', { body: 'Buy followers now! free crypto for everyone' });
    expect(spam.status).toBe(201);
    expect(spam.body.moderation.status).toBe('restricted');
    // Restricted content is visible to its author only.
    expect((await as(t.app, b).get(`/v1/posts/${spam.body.post.id}`)).status).toBe(404);

    const post = (await as(t.app, a).post('/v1/posts', { body: 'A normal post' })).body.post;
    const report = await as(t.app, b).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'harassment' });
    expect(report.status).toBe(201);
    expect((await as(t.app, b).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'harassment' })).status).toBe(409);

    expect((await as(t.app, b).get('/v1/admin/moderation/cases')).status).toBe(403);
    const cases = await as(t.app, admin).get('/v1/admin/moderation/cases');
    const mc = cases.body.items.find((c: { target_id: string }) => c.target_id === post.id);
    expect(mc).toBeTruthy();
    expect((await as(t.app, admin).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'remove', note: 'test' })).status).toBe(200);
    expect((await as(t.app, b).get(`/v1/posts/${post.id}`)).status).toBe(404);

    const appeal = await as(t.app, a).post('/v1/appeals', { caseId: mc.id, statement: 'This was a misunderstanding.' });
    expect(appeal.status).toBe(201);
    const logs = await as(t.app, admin).get('/v1/admin/audit-logs');
    expect(logs.body.items.some((l: { action: string }) => l.action === 'moderation.remove')).toBe(true);
  });

  it('exports data and deletes the account', async () => {
    const u = await signUp(t.app);
    await as(t.app, u).post('/v1/posts', { body: 'Soon to be gone' });
    const exp = await as(t.app, u).get('/v1/me/export');
    expect(exp.status).toBe(200);
    expect(exp.body.posts[0].body).toBe('Soon to be gone');
    expect(exp.body.account.email).toBe(u.email);

    expect((await as(t.app, u).del('/v1/me', { password: 'wrong' })).status).toBe(400);
    expect((await as(t.app, u).del('/v1/me', { password: u.password })).status).toBe(200);
    expect((await as(t.app, u).get('/v1/auth/me')).status).toBe(401);
    expect((await as(t.app, null).post('/v1/auth/login', { email: u.email, password: u.password })).status).toBe(401);
  });

  it('password reset revokes existing sessions', async () => {
    const u = await signUp(t.app);
    await as(t.app, null).post('/v1/auth/password/forgot', { email: u.email });
    const outbox = (await t.app.inject({ url: '/dev/outbox' })).json().items;
    const mail = outbox.findLast((m: { to: string; subject: string }) => m.to === u.email && m.subject.includes('Reset'));
    const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('token');
    expect((await as(t.app, null).post('/v1/auth/password/reset', { token, password: 'brand-new-password' })).status).toBe(200);
    expect((await as(t.app, u).get('/v1/auth/me')).status).toBe(401);
    expect((await as(t.app, null).post('/v1/auth/login', { email: u.email, password: 'brand-new-password' })).status).toBe(200);
  });

  it('keeps AI memory under user control', async () => {
    const blocked = await as(t.app, a).post('/v1/ai/memories', { content: 'I like jazz' });
    expect(blocked.status).toBe(403);
    await as(t.app, a).put('/v1/me/consents', { purpose: 'ai_processing', granted: true });
    const m = await as(t.app, a).post('/v1/ai/memories', { content: 'I like jazz' });
    expect(m.status).toBe(201);
    expect((await as(t.app, a).del(`/v1/ai/memories/${m.body.memory.id}`)).status).toBe(200);
    expect((await as(t.app, a).get('/v1/ai/memories')).body.items).toHaveLength(0);
  });

  it('serves health, readiness and flags', async () => {
    expect((await t.app.inject({ url: '/health/live' })).statusCode).toBe(200);
    const ready = (await t.app.inject({ url: '/health/ready' })).json();
    expect(ready.checks.database).toBe('ok');
    const flags = (await as(t.app, null).get('/v1/flags')).body.flags;
    expect(flags).toMatchObject({ COMMERCE: true, LIVE: false });
    expect((await as(t.app, a).put('/v1/admin/flags/LIVE', { enabled: true })).status).toBe(403);
    expect((await as(t.app, admin).put('/v1/admin/flags/LIVE', { enabled: true })).body.flags.LIVE).toBe(true);
  });

  it('requires authentication on protected endpoints', async () => {
    for (const url of ['/v1/feed', '/v1/conversations', '/v1/notifications', '/v1/me/export']) expect((await as(t.app, null).get(url)).status).toBe(401);
    expect((await as(t.app, { ...a, token: 'forged-token-value-000000000000' }).get('/v1/auth/me')).status).toBe(401);
  });
});

describe('unit: intent and moderation', () => {
  it('parses natural-language search intent', () => {
    const now = new Date('2026-09-25T18:00:00Z');
    expect(parseSearchIntent('Find something interesting to do tonight.', now)).toMatchObject({ types: ['events'], when: { label: 'tonight' } });
    expect(parseSearchIntent('Find technology communities.', now)).toMatchObject({ types: ['communities'], terms: 'technology' });
    expect(parseSearchIntent('Find restaurants suitable for six people.', now)).toMatchObject({ types: ['places'], placeCategory: 'restaurant', groupSize: 6 });
    expect(parseSearchIntent('Find creators who teach networking.', now)).toMatchObject({ types: ['people'], creatorsOnly: true, terms: 'networking' });
  });

  it('classifies risk', () => {
    expect(analyzeText('Lovely sunset today').risk).toBe('normal');
    expect(analyzeText('you are an idiot').risk).toBe('review');
    expect(analyzeText('free crypto, click this link to claim').risk).toBe('restrict');
  });
});
