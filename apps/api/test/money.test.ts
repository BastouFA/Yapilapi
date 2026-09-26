import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDevWebhook } from '../src/lib/payments.ts';
import { endExpiredCampaigns } from '../src/lib/boosts.ts';
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
  await t.close();
});

const ADULT = '1990-04-02';
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
const tag = () => Math.random().toString(36).slice(2, 8);

/** Pay an order with the development provider, through its signed webhook. */
async function pay(user: TestUser, orderId: string) {
  const r = await as(t.app, user).post('/v1/payments/dev/complete', { orderId });
  expect(r.status).toBe(200);
  return r.body.status as string;
}

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = `----ypl${Date.now()}${tag()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// ── Subscriber-only posts and reels ─────────────────────────────────────
describe('subscriber-only posts', () => {
  const secret = `zq${tag()}secretword`;
  const hashtag = `sauce${tag()}`;
  const photoUrl = `https://cdn.example.test/${tag()}-secret-photo.jpg`;
  const reelUrl = `https://cdn.example.test/${tag()}-secret-reel.mp4`;
  const optionA = `opt${tag()}blue`;
  const optionB = `opt${tag()}green`;
  const placeholder = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4IAoAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==';
  let creator: TestUser;
  let fan: TestUser;
  let stranger: TestUser;
  let post: any;
  let reel: any;
  let planId: string;

  /** Nothing the viewer must not have: text, media URLs, hashtag, poll. */
  const leaks = (body: unknown) => {
    const s = JSON.stringify(body);
    return [secret, hashtag, photoUrl, reelUrl, optionA, optionB].filter((x) => s.includes(x));
  };

  beforeAll(async () => {
    creator = await signUp(t.app, { birthDate: ADULT });
    fan = await signUp(t.app, { birthDate: ADULT });
    stranger = await signUp(t.app, { birthDate: ADULT });
    // Without a plan there is nobody to subscribe, so the option isn't there.
    const early = await as(t.app, creator).post('/v1/posts', { body: 'Too early', visibility: 'subscribers' });
    expect(early.status).toBe(400);
    planId = (await as(t.app, creator).post('/v1/creator/plans', { name: 'Supporters', priceCents: 500 })).body.plan.id;

    const created = await as(t.app, creator).post('/v1/posts', {
      body: `Recipe ${secret} #${hashtag}`,
      visibility: 'subscribers',
      media: [{ url: photoUrl, kind: 'image' }],
    });
    expect(created.status).toBe(201);
    post = created.body.post;
    // The author sees their own post in full.
    expect(post).toMatchObject({ visibility: 'subscribers', body: `Recipe ${secret} #${hashtag}` });
    expect(post.locked).toBeUndefined();
    await t.ctx.db.query(`UPDATE media SET blurhash = $2 WHERE url = $1`, [photoUrl, placeholder]);
    reel = (
      await as(t.app, creator).post('/v1/posts', {
        body: `Behind the scenes ${secret}`,
        visibility: 'subscribers',
        format: 'reel',
        media: [{ url: reelUrl, kind: 'video' }],
      })
    ).body.post;
    const poll = await as(t.app, creator).post('/v1/posts', { body: 'Pick one', visibility: 'subscribers', poll: { options: [optionA, optionB] } });
    expect(poll.status).toBe(201);
    for (const u of [fan, stranger]) await as(t.app, u).post(`/v1/users/${creator.id}/follow`);
    // Community posts are for members, never for subscribers.
    const community = (await as(t.app, creator).post('/v1/communities', { slug: `club-${tag()}`, name: 'Club', description: '' })).body.community;
    if (community) expect((await as(t.app, creator).post('/v1/posts', { body: 'x', visibility: 'subscribers', communityId: community.id })).status).toBe(400);
  });

  it('shows a locked card on the post page, without text or media', async () => {
    const r = await as(t.app, stranger).get(`/v1/posts/${post.id}`);
    expect(r.status).toBe(200);
    expect(r.body.post).toMatchObject({
      id: post.id,
      body: '',
      media: [],
      topics: [],
      poll: null,
      linkUrl: null,
      visibility: 'subscribers',
      author: { id: creator.id },
      locked: { placeholder, mediaCount: 1 },
    });
    expect(leaks(r.body)).toEqual([]);
    // Not signed in: the same locked card.
    const anon = await as(t.app, null).get(`/v1/posts/${post.id}`);
    expect(anon.body.post.locked).toBeTruthy();
    expect(leaks(anon.body)).toEqual([]);
  });

  it('keeps comments and votes for people who can open it', async () => {
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}/comments`)).body.error.code).toBe('subscribers_only');
    expect((await as(t.app, stranger).post(`/v1/posts/${post.id}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await as(t.app, creator).post(`/v1/posts/${post.id}/comments`, { body: `Thanks ${secret}` })).status).toBe(201);
    expect(leaks((await as(t.app, null).get(`/v1/posts/${post.id}/comments`)).body)).toEqual([]);
    const pollPost = (await as(t.app, stranger).get(`/v1/users/${creator.username}/posts`)).body.items.find((p: any) => p.kind === 'poll');
    expect(pollPost.poll).toBeNull();
    expect((await as(t.app, stranger).post(`/v1/posts/${pollPost.id}/vote`, { optionId: pollPost.id })).status).toBe(403);
    // Liking and saving are fine: they reveal nothing.
    expect((await as(t.app, stranger).put(`/v1/posts/${post.id}/save`)).status).toBe(200);
    const saved = (await as(t.app, stranger).get('/v1/me/saved')).body;
    expect(saved.items.find((p: any) => p.id === post.id).locked).toBeTruthy();
    expect(leaks(saved)).toEqual([]);
  });

  it("doesn't leak through feeds, profiles, reels, search, tags or public previews", async () => {
    const surfaces = {
      following: await as(t.app, stranger).get('/v1/feed?mode=following&limit=50'),
      forYou: await as(t.app, stranger).get('/v1/feed?mode=for_you&limit=50'),
      profile: await as(t.app, stranger).get(`/v1/users/${creator.username}/posts`),
      profileAnon: await as(t.app, null).get(`/v1/users/${creator.username}/posts`),
      reels: await as(t.app, stranger).get('/v1/reels?limit=20'),
      search: await as(t.app, stranger).get(`/v1/search?q=${secret}&type=posts`),
      searchAll: await as(t.app, null).get(`/v1/search?q=${secret}`),
      tag: await as(t.app, stranger).get(`/v1/tags/${hashtag}`),
      tagPosts: await as(t.app, stranger).get(`/v1/tags/${hashtag}/posts`),
      tagTop: await as(t.app, null).get(`/v1/tags/${hashtag}/posts?sort=top`),
      trending: await as(t.app, null).get('/v1/trending?limit=30'),
      publicPost: await as(t.app, null).get(`/v1/public/posts/${post.id}`),
      publicReel: await as(t.app, null).get(`/v1/public/posts/${reel.id}`),
      publicProfile: await as(t.app, null).get(`/v1/public/users/${creator.username}`),
    };
    for (const [name, r] of Object.entries(surfaces)) {
      expect(r.status, name).toBeLessThan(400);
      // Search and tag pages echo what you asked for; only what they found counts.
      expect(leaks(name.startsWith('search') ? r.body.results : name === 'tag' ? { ...r.body, tag: null } : r.body), name).toEqual([]);
    }
    // Listed as locked cards where a public post would be.
    for (const name of ['following', 'forYou', 'profile', 'profileAnon'] as const) {
      const card = surfaces[name].body.items.find((p: any) => p.id === post.id);
      expect(card, name).toBeTruthy();
      expect(card.locked, name).toBeTruthy();
    }
    const reelCard = surfaces.reels.body.items.find((p: any) => p.id === reel.id);
    expect(reelCard).toMatchObject({ format: 'reel', body: '', media: [], locked: { mediaCount: 1 } });
    // Search and tags only look at posts you can open.
    expect(surfaces.search.body.results.posts).toEqual([]);
    expect(surfaces.tag.body.posts).toBe(0);
    expect(surfaces.tagPosts.body.items).toEqual([]);
    expect(surfaces.trending.body.items.map((i: any) => i.tag)).not.toContain(hashtag);
    // The public link preview says who posted it, and nothing else.
    expect(surfaces.publicPost.body.post).toMatchObject({ locked: true, excerpt: '', image: null, video: null, author: { username: creator.username } });
    expect(surfaces.publicReel.body.post).toMatchObject({ locked: true, video: null, image: null });
  });

  it('opens everywhere once the subscription is paid, and closes when it ends', async () => {
    const sub = await as(t.app, fan).post(`/v1/creator/plans/${planId}/subscribe`, { idempotencyKey: key() });
    expect(sub.status).toBe(201);
    // Waiting for payment: still locked.
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}`)).body.post.locked).toBeTruthy();
    expect(await pay(fan, sub.body.payment.orderId)).toBe('paid');

    const detail = (await as(t.app, fan).get(`/v1/posts/${post.id}`)).body.post;
    expect(detail.locked).toBeUndefined();
    expect(detail.body).toContain(secret);
    expect(detail.media[0].url).toBe(photoUrl);
    expect((await as(t.app, fan).get(`/v1/reels?limit=20`)).body.items.find((p: any) => p.id === reel.id).media[0].url).toBe(reelUrl);
    expect((await as(t.app, fan).get(`/v1/search?q=${secret}&type=posts`)).body.results.posts.map((p: any) => p.id)).toContain(post.id);
    expect((await as(t.app, fan).get(`/v1/tags/${hashtag}/posts`)).body.items.map((p: any) => p.id)).toEqual([post.id]);
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}/comments`)).body.items).toHaveLength(1);
    // Public previews are for people without an account, so they stay locked.
    expect((await as(t.app, fan).get(`/v1/public/posts/${post.id}`)).body.post.locked).toBe(true);

    // Cancelling keeps access until the paid month ends.
    const mine = (await as(t.app, fan).get('/v1/me/subscriptions')).body.items[0];
    await as(t.app, fan).post(`/v1/creator/subscriptions/${mine.id}/cancel`);
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}`)).body.post.locked).toBeUndefined();
    // When the period is over, it locks again.
    await t.ctx.db.query(`UPDATE creator_subscriptions SET current_period_end = now() - interval '1 minute' WHERE id = $1`, [mine.id]);
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}`)).body.post.locked).toBeTruthy();
  });

  it('ends access when the subscription is refunded', async () => {
    const other = await signUp(t.app, { birthDate: ADULT });
    const sub = await as(t.app, other).post(`/v1/creator/plans/${planId}/subscribe`, { idempotencyKey: key() });
    await pay(other, sub.body.payment.orderId);
    expect((await as(t.app, other).get(`/v1/posts/${post.id}`)).body.post.locked).toBeUndefined();
    expect((await as(t.app, admin).post(`/v1/orders/${sub.body.payment.orderId}/refund`, { reason: 'Test' })).body.status).toBe('succeeded');
    expect((await as(t.app, other).get(`/v1/posts/${post.id}`)).body.post.locked).toBeTruthy();
  });

  it("stays hidden from people who can't see the creator's public posts", async () => {
    const quiet = await signUp(t.app, { birthDate: ADULT });
    const plan = (await as(t.app, quiet).post('/v1/creator/plans', { name: 'Inner circle', priceCents: 300 })).body.plan;
    expect(plan).toBeTruthy();
    await as(t.app, quiet).patch('/v1/me/profile', { isPrivate: true });
    const p = (await as(t.app, quiet).post('/v1/posts', { body: 'Private creator', visibility: 'subscribers' })).body.post;
    expect((await as(t.app, stranger).get(`/v1/posts/${p.id}`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/public/posts/${p.id}`)).status).toBe(404);
  });
});

// ── Shop: digital products and services ────────────────────────────────
describe('digital products', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(`Guide ${Date.now()}`)]);

  it('sells a download: private file, short-lived link for buyers only, sales in Studio', async () => {
    const seller = await signUp(t.app, { birthDate: ADULT });
    const buyer = await signUp(t.app, { birthDate: ADULT });
    const other = await signUp(t.app, { birthDate: ADULT });
    const product = (await as(t.app, seller).post('/v1/products', { kind: 'digital', title: 'Lagos food guide', priceCents: 150_000, currency: 'NGN' })).body
      .product;
    // Nothing to sell until the file is there, and it isn't in the shop yet.
    expect((await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: key() })).status).toBe(409);
    expect((await as(t.app, buyer).get(`/v1/users/${seller.id}/shop`)).body.items).toEqual([]);

    // Only the seller uploads, and only real files of an allowed type.
    const bad = multipart({ name: 'guide.pdf', type: 'application/pdf', data: Buffer.from('not a pdf') });
    const up = (m: ReturnType<typeof multipart>, user: TestUser) =>
      t.app.inject({
        method: 'PUT',
        url: `/v1/products/${product.id}/file`,
        payload: m.payload,
        headers: { ...m.headers, authorization: `Bearer ${user.token}` },
      });
    expect((await up(bad, seller)).statusCode).toBe(415);
    expect((await up(multipart({ name: 'guide.pdf', type: 'application/pdf', data: pdf }), other)).statusCode).toBe(404);
    const ok = await up(multipart({ name: 'guide.pdf', type: 'application/pdf', data: pdf }), seller);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().file).toMatchObject({ name: 'guide.pdf', mime: 'application/pdf', sizeBytes: pdf.length });

    // Stored privately: not under the public media folder or route.
    const stored = (await t.ctx.db.query(`SELECT storage_key FROM product_files WHERE product_id = $1`, [product.id])).rows[0].storage_key as string;
    expect(stored.startsWith('private/')).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: `/media/${stored}` })).statusCode).toBe(404);

    const shop = (await as(t.app, buyer).get(`/v1/users/${seller.id}/shop`)).body.items;
    expect(shop[0]).toMatchObject({ id: product.id, kind: 'digital', currency: 'NGN', owned: false, file: { name: 'guide.pdf' } });
    expect(JSON.stringify(shop)).not.toContain(stored);

    expect((await as(t.app, buyer).post(`/v1/products/${product.id}/download`)).status).toBe(403);
    const order = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: key() });
    expect(order.status).toBe(201);
    // Paid, not yet confirmed: still no download.
    expect((await as(t.app, buyer).post(`/v1/products/${product.id}/download`)).status).toBe(403);
    await pay(buyer, order.body.order.id);
    expect((await as(t.app, buyer).get(`/v1/users/${seller.id}/shop`)).body.items[0].owned).toBe(true);
    // Once is enough.
    expect((await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: key() })).status).toBe(409);

    const link = await as(t.app, buyer).post(`/v1/products/${product.id}/download`);
    expect(link.status).toBe(200);
    expect(new Date(link.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    const path = new URL(link.body.url).pathname;
    const file = await t.app.inject({ method: 'GET', url: path });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['content-disposition']).toContain('attachment');
    expect(file.rawPayload.equals(pdf)).toBe(true);
    // Someone else can't get a link, and a made-up link doesn't work.
    expect((await as(t.app, other).post(`/v1/products/${product.id}/download`)).status).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/v1/downloads/${'x'.repeat(43)}` })).statusCode).toBe(410);

    expect((await as(t.app, buyer).get('/v1/me/purchases')).body.items[0]).toMatchObject({ productId: product.id, title: 'Lagos food guide' });
    const sales = (await as(t.app, seller).get('/v1/me/sales')).body;
    expect(sales.totals).toEqual([{ currency: 'NGN', orders: 1, grossCents: 150_000, feeCents: 7_500, netCents: 142_500 }]);
    expect(sales.items[0]).toMatchObject({ status: 'paid', product: { id: product.id }, buyer: { id: buyer.id }, amountCents: 150_000 });

    // Links expire.
    await t.ctx.db.query(`UPDATE download_links SET expires_at = now() - interval '1 second' WHERE product_id = $1`, [product.id]);
    expect((await t.app.inject({ method: 'GET', url: path })).statusCode).toBe(410);
    // A refund ends access, even with a fresh link minted before it.
    const fresh = new URL((await as(t.app, buyer).post(`/v1/products/${product.id}/download`)).body.url).pathname;
    expect((await as(t.app, seller).post(`/v1/orders/${order.body.order.id}/refund`, { reason: 'Asked for it' })).body.status).toBe('succeeded');
    expect((await t.app.inject({ method: 'GET', url: fresh })).statusCode).toBe(410);
    expect((await as(t.app, buyer).post(`/v1/products/${product.id}/download`)).status).toBe(403);
    expect((await as(t.app, seller).get('/v1/me/sales')).body.totals).toEqual([]);
  });
});

describe('services', () => {
  it('books a paid service, waits for payment, then the seller confirms or declines (declining refunds)', async () => {
    const seller = await signUp(t.app, { birthDate: ADULT });
    const buyer = await signUp(t.app, { birthDate: ADULT });
    const service = (await as(t.app, seller).post('/v1/products', { kind: 'service', title: 'Portrait session', priceCents: 4000, currency: 'USD' })).body
      .product;
    expect((await as(t.app, buyer).get(`/v1/users/${seller.id}/shop`)).body.items[0]).toMatchObject({ id: service.id, kind: 'service' });
    // Services are booked for a time, not added to a basket.
    expect((await as(t.app, buyer).post('/v1/orders', { items: [{ productId: service.id, quantity: 1 }], idempotencyKey: key() })).status).toBe(400);
    expect(
      (await as(t.app, seller).post(`/v1/products/${service.id}/book`, { startsAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: key() }))
        .status,
    ).toBe(400);
    expect(
      (await as(t.app, buyer).post(`/v1/products/${service.id}/book`, { startsAt: new Date(Date.now() - 1000).toISOString(), idempotencyKey: key() })).status,
    ).toBe(400);

    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const book = await as(t.app, buyer).post(`/v1/products/${service.id}/book`, { startsAt: when, note: 'Outdoor if possible', idempotencyKey: key() });
    expect(book.status).toBe(201);
    expect(book.body.booking.status).toBe('pending_payment');
    expect(book.body.payment).toMatchObject({ provider: 'dev' });
    // The seller only hears about it once it's paid.
    expect((await as(t.app, seller).get('/v1/me/service-bookings')).body.items).toEqual([]);
    await pay(buyer, book.body.payment.orderId);
    const incoming = (await as(t.app, seller).get('/v1/me/service-bookings')).body.items;
    expect(incoming[0]).toMatchObject({
      id: book.body.booking.id,
      status: 'requested',
      note: 'Outdoor if possible',
      amountCents: 4000,
      customer: { id: buyer.id },
    });
    const n = await t.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'booking_request' AND entity_id = $2`, [
      seller.id,
      book.body.booking.id,
    ]);
    expect(n.rowCount).toBe(1);
    expect((await as(t.app, seller).get('/v1/me/sales')).body.items[0]).toMatchObject({ product: { id: service.id, kind: 'service' } });

    // Declining refunds the buyer.
    expect((await as(t.app, buyer).post(`/v1/bookings/${book.body.booking.id}/decide`, { confirm: false })).status).toBe(404);
    expect((await as(t.app, seller).post(`/v1/bookings/${book.body.booking.id}/decide`, { confirm: false })).status).toBe(200);
    expect((await as(t.app, buyer).get(`/v1/orders/${book.body.payment.orderId}`)).body.order.status).toBe('refunded');
    expect((await as(t.app, buyer).get('/v1/me/bookings')).body.items.find((b: any) => b.id === book.body.booking.id)).toMatchObject({
      status: 'declined',
      product_title: 'Portrait session',
    });

    // Confirmed bookings can't be cancelled from the app; unconfirmed ones are refunded.
    const second = await as(t.app, buyer).post(`/v1/products/${service.id}/book`, { startsAt: when, idempotencyKey: key() });
    await pay(buyer, second.body.payment.orderId);
    await as(t.app, seller).post(`/v1/bookings/${second.body.booking.id}/decide`, { confirm: true });
    expect((await as(t.app, buyer).post(`/v1/bookings/${second.body.booking.id}/cancel`)).status).toBe(409);
    const third = await as(t.app, buyer).post(`/v1/products/${service.id}/book`, { startsAt: when, idempotencyKey: key() });
    await pay(buyer, third.body.payment.orderId);
    expect((await as(t.app, buyer).post(`/v1/bookings/${third.body.booking.id}/cancel`)).body.status).toBe('cancelled');
    expect((await as(t.app, buyer).get(`/v1/orders/${third.body.payment.orderId}`)).body.order.status).toBe('refunded');
  });

  it('refunds a booking that is paid after it was cancelled', async () => {
    const seller = await signUp(t.app, { birthDate: ADULT });
    const buyer = await signUp(t.app, { birthDate: ADULT });
    const service = (await as(t.app, seller).post('/v1/products', { kind: 'service', title: 'Hair braiding', priceCents: 2500 })).body.product;
    const book = await as(t.app, buyer).post(`/v1/products/${service.id}/book`, {
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      idempotencyKey: key(),
    });
    expect((await as(t.app, buyer).post(`/v1/bookings/${book.body.booking.id}/cancel`)).body.status).toBe('cancelled');
    // The provider's confirmation arrives anyway.
    const ref = (await t.ctx.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [book.body.payment.orderId])).rows[0].provider_ref;
    const payload = JSON.stringify({ id: `evt_late_${book.body.payment.orderId}`, type: 'payment.succeeded', providerRef: ref, amountCents: 2500 });
    await t.app.inject({
      method: 'POST',
      url: '/v1/payments/webhook/dev',
      payload,
      headers: { 'content-type': 'application/json', 'x-signature': signDevWebhook(t.ctx.config.PAYMENTS_WEBHOOK_SECRET, payload) },
    });
    expect((await as(t.app, buyer).get(`/v1/orders/${book.body.payment.orderId}`)).body.order.status).toBe('refunded');
    expect((await as(t.app, seller).get('/v1/me/service-bookings')).body.items[0]?.status ?? 'cancelled').toBe('cancelled');
  });
});

// ── Boosts ─────────────────────────────────────────────────────────────
describe('boosting a post', () => {
  it('pays through checkout, goes to ad review, runs for its audience and reports results', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const here = await signUp(t.app, { birthDate: ADULT });
    const elsewhere = await signUp(t.app, { birthDate: ADULT });
    for (const [u, country] of [
      [here, 'KE'],
      [elsewhere, 'GH'],
    ] as const) {
      await as(t.app, u).put('/v1/me/consents', { purpose: 'advertising', granted: true });
      await as(t.app, u).patch('/v1/me/profile', { country });
    }
    const post = (await as(t.app, author).post('/v1/posts', { body: `Fresh bread every morning ${tag()}` })).body.post;
    const friendsOnly = (await as(t.app, author).post('/v1/posts', { body: 'Just for friends', visibility: 'friends' })).body.post;
    const input = { budgetCents: 1000, currency: 'USD', days: 3, audience: { type: 'country', countries: ['ke'] } };

    // Only your own public posts, with one of the offered budgets and durations.
    expect((await as(t.app, here).post(`/v1/posts/${post.id}/boost`, { ...input, idempotencyKey: key() })).status).toBe(403);
    expect((await as(t.app, author).post(`/v1/posts/${friendsOnly.id}/boost`, { ...input, idempotencyKey: key() })).status).toBe(400);
    expect((await as(t.app, author).post(`/v1/posts/${post.id}/boost`, { ...input, budgetCents: 1234, idempotencyKey: key() })).status).toBe(400);
    expect((await as(t.app, author).post(`/v1/posts/${post.id}/boost`, { ...input, days: 5, idempotencyKey: key() })).status).toBe(400);

    const boost = await as(t.app, author).post(`/v1/posts/${post.id}/boost`, { ...input, idempotencyKey: key() });
    expect(boost.status).toBe(201);
    expect(boost.body.boost).toMatchObject({ budgetCents: 1000, currency: 'USD', days: 3, estimatedImpressions: 2000 });
    const campaignId = boost.body.boost.campaignId;
    expect((await as(t.app, author).get(`/v1/posts/${post.id}`)).body.post.boost).toMatchObject({ campaignId, status: 'draft', budgetCents: 0 });

    // Paid: the budget lands and it waits for the same review as any ad.
    await pay(author, boost.body.payment.orderId);
    const listed = (await as(t.app, author).get('/v1/ads/campaigns')).body.items.find((c: any) => c.id === campaignId);
    expect(listed).toMatchObject({ status: 'pending_review', budgetCents: 1000, countries: ['KE'], boostDays: 3 });
    expect((await as(t.app, here).get('/v1/ads/next')).body.ad).toBeNull();
    // One boost at a time.
    expect((await as(t.app, author).post(`/v1/posts/${post.id}/boost`, { ...input, idempotencyKey: key() })).status).toBe(409);

    const cases = (await as(t.app, admin).get('/v1/admin/moderation/cases')).body.items;
    const mc = cases.find((c: any) => c.target_id === campaignId);
    expect(mc).toMatchObject({ source: 'ad_review' });
    expect((await as(t.app, admin).post(`/v1/admin/moderation/cases/${mc.id}/decide`, { decision: 'approve_ad' })).status).toBe(200);
    // Other suites' campaigns may still be running; keep this one alone so the audience check is exact.
    await t.ctx.db.query(`UPDATE ad_campaigns SET status = 'paused' WHERE status = 'active' AND id <> $1`, [campaignId]);
    const running = (await as(t.app, author).get(`/v1/posts/${post.id}/boosts`)).body.items[0];
    expect(running.status).toBe('active');
    const days = (new Date(running.endsAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);

    // Shown to people in the chosen country only.
    expect((await as(t.app, elsewhere).get('/v1/ads/next')).body.ad).toBeNull();
    const ad = (await as(t.app, here).get('/v1/ads/next')).body.ad;
    expect(ad.post.id).toBe(post.id);
    expect(ad.why).toContain("It's shown to people in your country.");
    await as(t.app, here).post(`/v1/ads/${campaignId}/click`);

    // Results on the post and in Studio.
    const results = (await as(t.app, author).get(`/v1/posts/${post.id}`)).body.post.boost;
    expect(results).toMatchObject({ status: 'active', impressions: 1, clicks: 1, spentCents: 1, budgetCents: 1000, currency: 'USD' });
    expect((await as(t.app, here).get(`/v1/posts/${post.id}`)).body.post.boost).toBeUndefined();
    expect((await as(t.app, here).get(`/v1/posts/${post.id}/boosts`)).status).toBe(404);
    const studio = (await as(t.app, author).get('/v1/me/boosts')).body.items;
    expect(studio[0]).toMatchObject({ campaignId, postId: post.id, impressions: 1, clicks: 1, audience: { type: 'country', countries: ['KE'] } });

    // When its days are up it stops, and what it didn't spend is refunded.
    await t.ctx.db.query(`UPDATE ad_campaigns SET ends_at = now() - interval '1 second' WHERE id = $1`, [campaignId]);
    expect((await as(t.app, here).get('/v1/ads/next')).body.ad).toBeNull();
    expect(await endExpiredCampaigns(t.ctx.db, t.ctx.paymentProviders)).toBeGreaterThanOrEqual(1);
    const done = (await as(t.app, author).get(`/v1/posts/${post.id}/boosts`)).body.items[0];
    expect(done).toMatchObject({ status: 'ended', spentCents: 1, refundedCents: 999, impressions: 1 });
  });

  it('targets interests, prices in local currency, and turns down posts that break the rules', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const post = (await as(t.app, author).post('/v1/posts', { body: `Jollof pop-up this weekend ${tag()}` })).body.post;
    const boost = await as(t.app, author).post(`/v1/posts/${post.id}/boost`, {
      budgetCents: 1_000_000,
      currency: 'NGN',
      days: 7,
      audience: { type: 'interests', topics: ['Food'] },
      idempotencyKey: key(),
    });
    expect(boost.status).toBe(201);
    expect(boost.body.boost.estimatedImpressions).toBe(2000);
    await pay(author, boost.body.payment.orderId);
    const c = (await as(t.app, author).get('/v1/me/boosts')).body.items[0];
    expect(c).toMatchObject({ status: 'pending_review', currency: 'NGN', budgetCents: 1_000_000, audience: { type: 'interests', topics: ['food'] }, days: 7 });

    // Made private before the money arrived: refused and refunded.
    const other = (await as(t.app, author).post('/v1/posts', { body: `Weekend market ${tag()}` })).body.post;
    const late = await as(t.app, author).post(`/v1/posts/${other.id}/boost`, {
      budgetCents: 500,
      currency: 'USD',
      days: 1,
      audience: { type: 'country', countries: ['NG'] },
      idempotencyKey: key(),
    });
    await t.ctx.db.query(`UPDATE posts SET visibility = 'followers' WHERE id = $1`, [other.id]);
    await pay(author, late.body.payment.orderId);
    const refused = (await as(t.app, author).get(`/v1/posts/${other.id}/boosts`)).body.items[0];
    expect(refused).toMatchObject({ status: 'rejected', budgetCents: 0, refundedCents: 500 });
    expect(refused.reviewNote).toContain('refunded');
  });
});
