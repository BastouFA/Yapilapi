import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

/**
 * App store rules for digital goods bought in the phone apps (docs/operations/in-app-purchases.md):
 * the setting reaches the phone through /v1/flags, and the API refuses a card checkout for a
 * digital good from a phone that isn't allowed to sell it. The web, physical products, services
 * and tickets to events in a real place are never affected.
 */
let t: BuiltApp;
let linked: BuiltApp;
let storeOnly: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  linked = await testApp({
    IOS_DIGITAL_PURCHASES: 'external_link',
    IOS_EXTERNAL_LINK_COUNTRIES: 'us, gb',
    ANDROID_DIGITAL_PURCHASES: 'user_choice',
    ANDROID_USER_CHOICE_COUNTRIES: 'US',
  });
  storeOnly = await testApp({ IOS_DIGITAL_PURCHASES: 'iap' });
  for (const flag of ['ADS', 'LIVE'])
    await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ($1, true) ON CONFLICT (key) DO UPDATE SET enabled = true`, [flag]);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key IN ('ADS', 'LIVE')`);
  await Promise.all([t.close(), linked.close(), storeOnly.close()]);
});

const ADULT = '1990-04-02';
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;

/** A request as a given client: the phone app says `ios` or `android`; the web says nothing. */
async function call(app: BuiltApp, user: TestUser, method: 'GET' | 'POST', url: string, platform?: string, payload: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${user.token}` };
  if (platform) headers['x-client-platform'] = platform;
  const res = await app.app.inject({ method, url, headers, payload: method === 'POST' ? payload : undefined });
  return { status: res.statusCode, body: res.body ? (res.json() as any) : null };
}

async function product(seller: TestUser, body: Record<string, unknown>) {
  const r = await call(t, seller, 'POST', '/v1/products', undefined, { priceCents: 1500, currency: 'USD', ...body });
  expect(r.status).toBe(201);
  return r.body.product as { id: string };
}

describe('store purchase policy', () => {
  it('tells the phone the setting with the flags', async () => {
    const u = await signUp(t.app, { birthDate: ADULT });
    const flags = (await call(t, u, 'GET', '/v1/flags')).body;
    expect(flags.flags).toHaveProperty('COMMERCE');
    expect(flags.purchases).toEqual({ ios: { mode: 'hidden', linkCountries: ['US'] }, android: { mode: 'play_billing_required', linkCountries: ['US'] } });
    expect((await call(linked, u, 'GET', '/v1/flags')).body.purchases).toEqual({
      ios: { mode: 'external_link', linkCountries: ['US', 'GB'] },
      android: { mode: 'user_choice', linkCountries: ['US'] },
    });
  });

  it('refuses digital checkouts from the phone by default, and lets the web buy them', async () => {
    const buyer = await signUp(t.app, { birthDate: ADULT });
    const creator = await signUp(t.app, { birthDate: ADULT });
    const refused = (r: { status: number; body: any }) => {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('store_purchase_required');
    };

    // Plus
    for (const platform of ['ios', 'android', 'mobile']) refused(await call(t, buyer, 'POST', '/v1/plus/checkout', platform, { idempotencyKey: key() }));
    expect((await call(t, buyer, 'POST', '/v1/plus/checkout', undefined, { idempotencyKey: key() })).status).toBe(201);
    // Nothing was started for the refused ones: only the web order exists.
    const plusOrders = await t.ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE buyer_id = $1 AND purpose = 'plus'`, [buyer.id]);
    expect(plusOrders.rows[0].n).toBe(1);

    // Tips and subscriptions to a creator
    refused(await call(t, buyer, 'POST', `/v1/users/${creator.id}/tips`, 'ios', { amountCents: 500, currency: 'USD', idempotencyKey: key() }));
    expect((await call(t, buyer, 'POST', `/v1/users/${creator.id}/tips`, undefined, { amountCents: 500, currency: 'USD', idempotencyKey: key() })).status).toBe(
      201,
    );
    const plan = (await call(t, creator, 'POST', '/v1/creator/plans', undefined, { name: 'Supporters', priceCents: 500 })).body.plan;
    refused(await call(t, buyer, 'POST', `/v1/creator/plans/${plan.id}/subscribe`, 'android', { idempotencyKey: key() }));
    expect((await call(t, buyer, 'POST', `/v1/creator/plans/${plan.id}/subscribe`, undefined, { idempotencyKey: key() })).status).toBe(201);

    // Boosts and ad budget
    const post = (await call(t, creator, 'POST', '/v1/posts', undefined, { body: `Boost me ${key()}` })).body.post;
    const boost = { budgetCents: 1000, currency: 'USD', days: 3, audience: { type: 'country', countries: ['ke'] } };
    refused(await call(t, creator, 'POST', `/v1/posts/${post.id}/boost`, 'ios', { ...boost, idempotencyKey: key() }));
    const boosted = await call(t, creator, 'POST', `/v1/posts/${post.id}/boost`, undefined, { ...boost, idempotencyKey: key() });
    expect(boosted.status).toBe(201);
    refused(await call(t, creator, 'POST', `/v1/ads/campaigns/${boosted.body.boost.campaignId}/fund`, 'android', { amountCents: 1000, idempotencyKey: key() }));
  });

  it('refuses downloads and tickets to a live from the phone, but keeps physical products, services and event tickets', async () => {
    const seller = await signUp(t.app, { birthDate: ADULT });
    const buyer = await signUp(t.app, { birthDate: ADULT });
    const download = await product(seller, { kind: 'digital', title: 'Recipe book' });
    await t.ctx.db.query(
      `INSERT INTO product_files (product_id, storage_key, filename, mime, size_bytes) VALUES ($1, 'private/test.pdf', 'book.pdf', 'application/pdf', 10)`,
      [download.id],
    );
    const mug = await product(seller, { title: 'Clay mug' });
    const concert = await product(seller, { kind: 'ticket', title: 'Concert in the park' });
    const service = await product(seller, { kind: 'service', title: 'Portrait session' });
    const order = (items: { id: string }[], platform?: string, extra: Record<string, unknown> = {}) =>
      call(t, buyer, 'POST', '/v1/orders', platform, { items: items.map((p) => ({ productId: p.id, quantity: 1 })), idempotencyKey: key(), ...extra });

    const phone = await order([download], 'ios');
    expect(phone.status).toBe(403);
    expect(phone.body.error.code).toBe('store_purchase_required');
    // A physical product in the same order doesn't make the download allowed.
    expect((await order([mug, download], 'android')).status).toBe(403);
    expect((await order([download])).status).toBe(201);

    // Physical goods, tickets to a real place, and services keep their checkout on phones.
    expect((await order([mug], 'ios')).status).toBe(201);
    expect((await order([concert], 'android')).status).toBe(201);
    const booked = await call(t, buyer, 'POST', `/v1/products/${service.id}/book`, 'ios', {
      startsAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
      idempotencyKey: key(),
    });
    expect(booked.status).toBe(201);

    // A ticket for a live is a digital good.
    const ticket = await product(seller, { kind: 'ticket', title: 'Live pass' });
    const live = (await call(t, seller, 'POST', '/v1/live', undefined, { title: 'Paid live', ticketProductId: ticket.id })).body.live;
    expect((await order([ticket], 'ios', { liveSessionId: live.id })).status).toBe(403);
    expect((await order([ticket], undefined, { liveSessionId: live.id })).status).toBe(201);
  });

  it('allows the phone checkout in the link modes, and never while the store is expected to take the payment', async () => {
    const buyer = await signUp(t.app, { birthDate: ADULT });
    expect((await call(linked, buyer, 'POST', '/v1/plus/checkout', 'ios', { idempotencyKey: key() })).status).toBe(201);
    expect((await call(linked, buyer, 'POST', '/v1/plus/checkout', 'android', { idempotencyKey: key() })).status).toBe(201);
    const iap = await call(storeOnly, buyer, 'POST', '/v1/plus/checkout', 'ios', { idempotencyKey: key() });
    expect(iap.status).toBe(403);
    expect(iap.body.error.code).toBe('store_purchase_required');
    expect((await call(storeOnly, buyer, 'POST', '/v1/plus/checkout', undefined, { idempotencyKey: key() })).status).toBe(201);
  });

  it('lists a phone session as a phone, and rejects unknown settings', async () => {
    const u = await signUp(t.app, { birthDate: ADULT });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-client-platform': 'ios' },
      payload: { email: u.email, password: u.password },
    });
    expect(res.statusCode).toBe(200);
    const devices = await t.ctx.db.query(`SELECT platform FROM devices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.id]);
    expect(devices.rows[0].platform).toBe('mobile');
    const base = { DATABASE_URL: 'postgres://x/y', APP_ENV: 'test' };
    expect(() => loadConfig({ ...base, IOS_DIGITAL_PURCHASES: 'sometimes' })).toThrow(/IOS_DIGITAL_PURCHASES/);
    expect(() => loadConfig({ ...base, ANDROID_DIGITAL_PURCHASES: 'hidden' })).toThrow(/ANDROID_DIGITAL_PURCHASES/);
    expect(loadConfig(base).IOS_EXTERNAL_LINK_COUNTRIES).toEqual(['US']);
  });
});
