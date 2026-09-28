import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approximatePoint, MARKET_LISTINGS_PER_DAY, prohibitedMatch } from '@yapilapi/shared';
import { sweepMarket } from '../src/lib/market.ts';
import { runRetention } from '../src/lib/retention.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-04-02' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}
async function moderator() {
  const u = await adult();
  await db().query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [u.id]);
  return u;
}
/** Someone living in Nigeria, so their prices are in naira. */
async function seller(country = 'NG') {
  const u = await adult();
  await db().query(`UPDATE profiles SET country = $2 WHERE user_id = $1`, [u.id, country]);
  return u;
}
async function photo(owner: TestUser, moderation = 'ok') {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, moderation, variants) VALUES ($1,'image','http://localhost:4000/media/item.jpg','image/jpeg','ready',$2,
       '{"thumb":"http://localhost:4000/media/item_thumb.webp","medium":"http://localhost:4000/media/item_medium.webp"}') RETURNING id`,
    [owner.id, moderation],
  );
  return rows[0].id as string;
}
/** A realtime listener for one person. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

// A spot in Yaba, Lagos, and one about 3 km north of it. Their digits must never reach anyone else.
const HERE = { lat: 6.51234, lng: 3.37891 };
const NORTH_3KM = { lat: 6.53934, lng: 3.37891 };
const FAR = { lat: 9.0765, lng: 7.39861 }; // Abuja

let n = 0;
async function list(u: TestUser, extra: Record<string, unknown> = {}) {
  n++;
  const r = await as(t.app, u).post('/v1/market/listings', {
    title: `Wooden study desk number ${n}`,
    description: `Solid desk with two drawers, a few marks on the top. Item ${n}.`,
    category: 'furniture',
    condition: 'good',
    priceCents: 2_500_000,
    photos: [{ mediaId: await photo(u), altText: 'A brown desk against a white wall' }],
    area: 'Yaba, Lagos',
    place: HERE,
    delivery: ['pickup'],
    ...extra,
  });
  return r;
}
async function listed(u: TestUser, extra: Record<string, unknown> = {}) {
  const r = await list(u, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.listing as any;
}
const search = (u: TestUser, body: Record<string, unknown> = {}) => as(t.app, u).post('/v1/market/search', body);
const ids = (r: { body: any }) => (r.body.items as { id: string }[]).map((l) => l.id);
const notes = async (u: TestUser, type: string) =>
  (await db().query(`SELECT actor_id, entity_type, entity_id, data FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [u.id, type]))
    .rows;

describe('Selling on Market', () => {
  it('is for adults, prices in the currency of your country, and anyone can browse', async () => {
    const [ada, kid] = [await seller('NG'), await teen()];
    expect((await as(t.app, ada).get('/v1/market/me')).body.market).toEqual({
      currency: 'NGN',
      canSell: true,
      sellBlock: null,
      listingsLeftToday: MARKET_LISTINGS_PER_DAY,
    });
    expect((await as(t.app, kid).get('/v1/market/me')).body.market).toMatchObject({ canSell: false, sellBlock: 'adults_only' });
    const refused = await list(kid);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('adults_only');

    const l = await listed(ada);
    expect(l).toMatchObject({
      currency: 'NGN',
      priceCents: 2_500_000,
      status: 'available',
      mine: true,
      canContact: false,
      contactBlock: 'self',
      hasPlace: true,
    });
    expect(l.photos).toEqual([
      expect.objectContaining({
        url: 'http://localhost:4000/media/item_medium.webp',
        thumbUrl: 'http://localhost:4000/media/item_thumb.webp',
        altText: 'A brown desk against a white wall',
      }),
    ]);
    expect(new Date(l.expiresAt).getTime() - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    // A teen can look around, and sees who sells it.
    const seen = await as(t.app, kid).get(`/v1/market/listings/${l.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.listing).toMatchObject({
      id: l.id,
      mine: false,
      sellerCard: { user: { id: ada.id }, rating: { average: null, count: 0 }, responseRate: null, sold: 0 },
    });
    // Free things have no price; the price can't be zero.
    expect((await listed(ada, { priceCents: null })).priceCents).toBeNull();
    expect((await list(ada, { priceCents: 0 })).status).toBe(400);
  });

  it('takes only your own photos, up to 10, and not ones taken down', async () => {
    const [ada, bola] = [await seller(), await seller()];
    expect((await list(ada, { photos: [{ mediaId: await photo(bola) }] })).status).toBe(404);
    const eleven = await Promise.all(Array.from({ length: 11 }, () => photo(ada)));
    expect((await list(ada, { photos: eleven.map((mediaId) => ({ mediaId })) })).status).toBe(400);
    const blocked = await list(ada, { photos: [{ mediaId: await photo(ada, 'blocked') }] });
    expect(blocked.body.error.code).toBe('media_blocked');
    // A photo that may be sensitive: the listing waits for a moderator, and nobody else sees the photo.
    const held = await list(ada, { photos: [{ mediaId: await photo(ada, 'sensitive') }] });
    expect(held.status).toBe(201);
    expect(held.body.listing).toMatchObject({ moderation: 'review', reviewReason: 'photos' });
    expect(held.body.noticeCode).toBe('listing_held');
    expect(held.body.notice).toMatch(/^Your listing will show once/);
    expect((await as(t.app, bola).get(`/v1/market/listings/${held.body.listing.id}`)).status).toBe(404);
  });

  it('stops prohibited items before they are listed, and holds them for review when the seller says they are not', async () => {
    expect(prohibitedMatch('Hot glue gun, barely used')).toBeNull();
    expect(prohibitedMatch('Drum kit', 'Five pieces')).toBeNull();
    expect(prohibitedMatch('Air rifle with scope')).toBe('weapons');
    expect(prohibitedMatch('Chiots à vendre')).toBe('animals');
    expect(prohibitedMatch('Box of cigarettes')).toBe('tobacco');
    const [ada, bola, mod] = [await seller(), await seller(), await moderator()];
    const refused = await list(ada, { title: 'Air rifle with scope', description: '' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'prohibited_item', details: { kind: 'weapons' } });
    expect((await list(ada, { title: 'Bottles of red wine', description: '' })).body.error.details.kind).toBe('alcohol');

    const held = await list(ada, { title: 'Rifle bag, empty, for storage', description: 'Just the bag.', notProhibited: true });
    expect(held.status).toBe(201);
    expect(held.body.listing).toMatchObject({ moderation: 'review', reviewReason: 'prohibited' });
    const id = held.body.listing.id;
    expect(ids(await search(bola, { q: 'Rifle bag' }))).not.toContain(id);
    const cases = await as(t.app, mod).get('/v1/admin/moderation/cases');
    const c = cases.body.items.find((x: any) => x.target_type === 'listing' && x.target_id === id);
    expect(c).toMatchObject({ subject_user_id: ada.id, source: 'automated' });
    expect(c.excerpt).toContain('Rifle bag');
    expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${c.id}/decide`, { decision: 'no_action' })).status).toBe(200);
    expect(ids(await search(bola, { q: 'Rifle bag' }))).toContain(id);
    // Editing the words runs the checks again.
    const edited = await as(t.app, ada).patch(`/v1/market/listings/${id}`, { title: 'Pack of cigarettes' });
    expect(edited.body.error.code).toBe('prohibited_item');
  });

  it('holds the same words posted many times and prices far below similar things', async () => {
    const [ada, bola, cat] = [await seller(), await seller(), await seller()];
    const words = { title: 'Brand new sealed phone at a great price', description: 'Contact me for more details about this phone.', category: 'phones' };
    expect((await listed(ada, words)).moderation).toBeUndefined();
    expect((await listed(bola, words)).moderation).toBeUndefined();
    expect(await listed(cat, words)).toMatchObject({ moderation: 'review', reviewReason: 'duplicate' });

    // Five sellers list bikes around ₦100,000; one at ₦5,000 waits for a check, one at ₦60,000 doesn't.
    for (let i = 0; i < 5; i++)
      await listed(await seller(), { title: `City bike ${i} with basket`, description: `Bike ${i}`, category: 'bikes', priceCents: 10_000_000 + i * 100 });
    expect(await listed(ada, { title: 'Road bike cheap', description: 'Quick sale', category: 'bikes', priceCents: 500_000 })).toMatchObject({
      moderation: 'review',
      reviewReason: 'low_price',
    });
    expect((await listed(ada, { title: 'Kids bike', description: 'Small', category: 'bikes', priceCents: 6_000_000 })).moderation).toBeUndefined();
  });

  it(`lets each person list up to ${MARKET_LISTINGS_PER_DAY} things a day`, async () => {
    const ada = await seller();
    for (let i = 0; i < MARKET_LISTINGS_PER_DAY; i++) await listed(ada, { title: `Lamp model ${i} in blue`, description: `Lamp ${i}` });
    const over = await list(ada, { title: 'One lamp too many', description: 'Lamp' });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('market_daily_limit');
    expect((await as(t.app, ada).get('/v1/market/me')).body.market.listingsLeftToday).toBe(0);
  });
});

describe('Where listings are', () => {
  it('keeps only an approximate place and never sends it: people get a distance in whole kilometres', async () => {
    const [ada, bola] = [await seller(), await seller()];
    const l = await listed(ada, { title: 'Bookshelf with five shelves', description: 'Pine' });
    const kept = (await db().query(`SELECT approx_lat, approx_lng FROM market_listings WHERE id = $1`, [l.id])).rows[0];
    expect({ lat: kept.approx_lat, lng: kept.approx_lng }).toEqual(approximatePoint(HERE));

    const near = await search(bola, { near: NORTH_3KM, radiusKm: 5, q: 'Bookshelf with five' });
    expect(ids(near)).toEqual([l.id]);
    expect(near.body.items[0].where).toEqual({ area: 'Yaba, Lagos', distanceKm: 3 });
    // Nothing anyone else gets carries the place, however it's asked for.
    const text = JSON.stringify([near.body, (await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).body]);
    for (const digits of [String(HERE.lat), String(HERE.lng), String(kept.approx_lat), String(kept.approx_lng), '6.512', '3.378', '3.379'])
      expect(text).not.toContain(digits);
    expect((await as(t.app, bola).post(`/v1/market/listings/${l.id}/view`, { near: NORTH_3KM })).body.listing.where).toEqual({
      area: 'Yaba, Lagos',
      distanceKm: 3,
    });

    // Outside the radius, and far away: not found nearby.
    expect(ids(await search(bola, { near: NORTH_3KM, radiusKm: 2, q: 'Bookshelf with five' }))).toEqual([]);
    expect(ids(await search(bola, { near: FAR, radiusKm: 100, q: 'Bookshelf with five' }))).toEqual([]);
    // Without a place, everything in your country, newest first.
    expect(ids(await search(bola, { q: 'Bookshelf with five' }))).toEqual([l.id]);
    // Places are only taken in the body; a radius not on the list is refused.
    expect((await search(bola, { near: NORTH_3KM, radiusKm: 7 })).status).toBe(400);
  });

  it('sorts nearest first and filters by category, condition, price and free things', async () => {
    const [ada, bola] = [await seller(), await seller()];
    const tag = `z${Date.now().toString(36)}`;
    const close = await listed(ada, { title: `Armchair ${tag}`, place: NORTH_3KM, condition: 'like_new', priceCents: 1_000_000 });
    const closer = await listed(ada, { title: `Sofa ${tag}`, place: HERE, condition: 'fair', priceCents: 5_000_000 });
    const free = await listed(ada, { title: `Old cushions ${tag}`, place: HERE, category: 'home', priceCents: null });
    // The two in the same spot, newest first, then the one 3 km away.
    expect(ids(await search(bola, { near: HERE, radiusKm: 10, q: tag }))).toEqual([free.id, closer.id, close.id]);
    expect(ids(await search(bola, { q: tag, category: 'home' }))).toEqual([free.id]);
    expect(ids(await search(bola, { q: tag, conditions: ['like_new'] }))).toEqual([close.id]);
    expect(ids(await search(bola, { q: tag, freeOnly: true }))).toEqual([free.id]);
    expect(ids(await search(bola, { q: tag, minPriceCents: 2_000_000 }))).toEqual([closer.id]);
    expect(new Set(ids(await search(bola, { q: tag, maxPriceCents: 2_000_000 })))).toEqual(new Set([close.id, free.id]));
    // Someone in another currency doesn't get naira prices compared with theirs.
    const gb = await seller('GB');
    expect(ids(await search(gb, { q: tag, maxPriceCents: 2_000_000 }))).toEqual([free.id]);
    // Paging goes on from where it stopped.
    const first = await search(bola, { q: tag, limit: 2 });
    expect(first.body.items).toHaveLength(2);
    const second = await search(bola, { q: tag, limit: 2, cursor: first.body.nextCursor });
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('Blocks, minors and messaging a seller', () => {
  it('hides listings both ways between people who blocked each other', async () => {
    const [ada, bola] = [await seller(), await seller()];
    const l = await listed(ada, { title: 'Standing fan, three speeds' });
    expect((await as(t.app, bola).post(`/v1/users/${ada.id}/block`)).status).toBe(200);
    expect(ids(await search(bola, { q: 'Standing fan, three' }))).toEqual([]);
    expect((await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).status).toBe(404);
    expect((await as(t.app, bola).post(`/v1/market/listings/${l.id}/message`)).status).toBe(404);
    expect((await as(t.app, bola).get(`/v1/market/sellers/${ada.id}`)).status).toBe(404);
    // The seller doesn't see their things either way round.
    const theirs = await listed(bola, { title: 'Blender, two jugs' });
    expect((await as(t.app, ada).get(`/v1/market/listings/${theirs.id}`)).status).toBe(404);
  });

  it('opens one chat per listing with its card at the top, and lets the seller answer', async () => {
    const [ada, bola] = [await seller(), await seller()];
    await db().query(
      `INSERT INTO user_preferences (user_id, messages_from) VALUES ($1, 'friends') ON CONFLICT (user_id) DO UPDATE SET messages_from = 'friends'`,
      [ada.id],
    );
    const l = await listed(ada, { title: 'Microwave, 20 litres' });
    const live = connect(ada);
    const opened = await as(t.app, bola).post(`/v1/market/listings/${l.id}/message`);
    expect(opened.status).toBe(201);
    const { conversationId, message } = opened.body;
    expect(message).toMatchObject({
      body: 'Microwave, 20 litres',
      market: { you: 'buyer', listing: { id: l.id, available: true, title: 'Microwave, 20 litres' } },
    });
    expect(live.of('message.created')[0]?.data.market).toMatchObject({ you: 'seller', canMarkSold: true, canMarkReserved: true, buyer: { id: bola.id } });
    // Asking again gives the same chat and card.
    const again = await as(t.app, bola).post(`/v1/market/listings/${l.id}/message`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ conversationId, message: { id: message.id } });
    // Writing about a listing gets through the seller's "friends only" messages, both ways.
    expect((await as(t.app, bola).post(`/v1/conversations/${conversationId}/messages`, { body: 'Is it still available?' })).status).toBe(201);
    expect((await as(t.app, ada).post(`/v1/conversations/${conversationId}/messages`, { body: 'Yes, it is.' })).status).toBe(201);
    // The card can't be edited, and a reply quotes it as a listing.
    expect((await as(t.app, bola).patch(`/v1/messages/${message.id}`, { body: 'Something else' })).body.error.code).toBe('not_editable');
    const reply = await as(t.app, ada).post(`/v1/conversations/${conversationId}/messages`, { body: 'This one', replyToId: message.id });
    expect(reply.body.message.replyTo).toMatchObject({ kind: 'listing' });
    const detail = (await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).body.listing;
    expect(detail.conversationId).toBe(conversationId);
    expect((await as(t.app, ada).get(`/v1/market/listings/${l.id}`)).body.listing.buyers.map((b: any) => b.id)).toEqual([bola.id]);
    // Their own listing: nothing to write about.
    expect((await as(t.app, ada).post(`/v1/market/listings/${l.id}/message`)).status).toBe(400);
    live.remove();
  });

  it('keeps adults and under-18s apart unless they are friends', async () => {
    const [ada, kid] = [await seller(), await teen()];
    const l = await listed(ada, { title: 'School backpack, navy' });
    const seen = (await as(t.app, kid).get(`/v1/market/listings/${l.id}`)).body.listing;
    expect(seen).toMatchObject({ canContact: false, contactBlock: 'minor_protection' });
    const refused = await as(t.app, kid).post(`/v1/market/listings/${l.id}/message`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('minor_protection');
    expect((await as(t.app, kid).post(`/v1/market/listings/${l.id}/offers`, { amountCents: 100_000 })).body.error.code).toBe('minor_protection');
    await befriend(ada, kid);
    expect((await as(t.app, kid).get(`/v1/market/listings/${l.id}`)).body.listing.canContact).toBe(true);
    expect((await as(t.app, kid).post(`/v1/market/listings/${l.id}/message`)).status).toBe(201);
  });
});

describe('Offers', () => {
  it('goes offer, counter-offer, accept, with a card for each and a note to the other person', async () => {
    const [ada, bola, cat] = [await seller(), await seller(), await seller()];
    const l = await listed(ada, { title: 'Gas cooker, four burners', priceCents: 8_000_000 });
    const sellerLive = connect(ada);
    const offered = await as(t.app, bola).post(`/v1/market/listings/${l.id}/offers`, { amountCents: 6_000_000 });
    expect(offered.status).toBe(201);
    const { conversationId, offer } = offered.body;
    expect(offer).toMatchObject({ madeBy: 'buyer', amountCents: 6_000_000, currency: 'NGN', status: 'pending', canWithdraw: true, canRespond: false });
    expect(offered.body.message).toMatchObject({ body: 'Offer · NGN 60,000.00', offer: { id: offer.id } });
    // The chat started with the listing's card, then the offer.
    const history = (await as(t.app, ada).get(`/v1/conversations/${conversationId}/messages`)).body.items;
    expect(history.map((m: any) => (m.market ? 'card' : m.offer ? 'offer' : 'text'))).toEqual(['card', 'offer']);
    expect(history[1].offer).toMatchObject({ canRespond: true, canWithdraw: false });
    expect(await notes(ada, 'market_offer')).toEqual([
      {
        actor_id: bola.id,
        entity_type: 'conversation',
        entity_id: conversationId,
        data: { listingId: l.id, title: 'Gas cooker, four burners', amountCents: 6_000_000, currency: 'NGN' },
      },
    ]);
    // One offer waiting at a time; someone else can't answer it; the buyer can't accept their own.
    const twice = await as(t.app, bola).post(`/v1/market/listings/${l.id}/offers`, { amountCents: 6_500_000 });
    expect(twice.body.error).toMatchObject({ code: 'offer_pending', details: { offerId: offer.id } });
    expect((await as(t.app, cat).post(`/v1/market/offers/${offer.id}/accept`)).status).toBe(404);
    expect((await as(t.app, bola).post(`/v1/market/offers/${offer.id}/accept`)).body.error.code).toBe('not_yours_to_answer');
    // The seller comes back with another amount.
    const buyerLive = connect(bola);
    const counter = await as(t.app, ada).post(`/v1/market/offers/${offer.id}/counter`, { amountCents: 7_000_000 });
    expect(counter.status).toBe(201);
    expect(counter.body.offer).toMatchObject({ madeBy: 'seller', counterOfId: offer.id, status: 'pending', canWithdraw: true });
    expect(counter.body.message.body).toBe('Counter-offer · NGN 70,000.00');
    expect(buyerLive.of('market.updated').find((e) => e.data.offer?.id === offer.id)?.data.offer.status).toBe('countered');
    expect(buyerLive.of('message.created').at(-1)?.data.offer).toMatchObject({ id: counter.body.offer.id, canRespond: true });
    expect((await notes(bola, 'market_offer_countered'))[0]).toMatchObject({ actor_id: ada.id, data: { amountCents: 7_000_000 } });
    // The first one is closed now.
    expect((await as(t.app, ada).post(`/v1/market/offers/${offer.id}/accept`)).body.error.code).toBe('offer_closed');
    // The buyer accepts: the listing is reserved for them, and both cards update.
    const accepted = await as(t.app, bola).post(`/v1/market/offers/${counter.body.offer.id}/accept`);
    expect(accepted.body.offer.status).toBe('accepted');
    expect((await notes(ada, 'market_offer_accepted'))[0]).toMatchObject({ actor_id: bola.id });
    const now = (await as(t.app, ada).get(`/v1/market/listings/${l.id}`)).body.listing;
    expect(now.status).toBe('reserved');
    expect(sellerLive.of('market.updated').some((e) => e.data.market?.reservedForBuyer)).toBe(true);
    // After an answer, a new offer is possible; the buyer can withdraw it, and the seller can decline the next.
    const next = await as(t.app, bola).post(`/v1/market/listings/${l.id}/offers`, { amountCents: 6_800_000 });
    expect((await as(t.app, bola).post(`/v1/market/offers/${next.body.offer.id}/withdraw`)).body.offer.status).toBe('withdrawn');
    const last = await as(t.app, bola).post(`/v1/market/listings/${l.id}/offers`, { amountCents: 6_900_000 });
    expect((await as(t.app, ada).post(`/v1/market/offers/${last.body.offer.id}/decline`)).body.offer.status).toBe('declined');
    expect(await notes(bola, 'market_offer_declined')).toHaveLength(1);
    // Nobody can offer on something sold.
    await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'sold' });
    expect((await as(t.app, cat).post(`/v1/market/listings/${l.id}/offers`, { amountCents: 100 })).status).toBe(404);
    sellerLive.remove();
    buyerLive.remove();
  });
});

describe('Selling and rating', () => {
  it('opens ratings only after the seller marks it sold to the buyer from the chat', async () => {
    const [ada, bola, cat] = [await seller(), await seller(), await seller()];
    const l = await listed(ada, { title: 'Electric kettle, 1.7 litres' });
    const { conversationId } = (await as(t.app, bola).post(`/v1/market/listings/${l.id}/message`)).body;
    await as(t.app, cat).post(`/v1/market/listings/${l.id}/message`);

    const early = await as(t.app, bola).post(`/v1/market/listings/${l.id}/ratings`, { stars: 5 });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('rating_not_allowed');
    // Only someone who wrote about it can be chosen as the buyer.
    const stranger = await seller();
    expect((await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'sold', buyerId: stranger.id })).status).toBe(400);
    expect((await as(t.app, bola).put(`/v1/market/listings/${l.id}/status`, { status: 'sold', buyerId: bola.id })).status).toBe(404);
    // Sold to someone else: no ratings either.
    await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'sold' });
    expect((await as(t.app, bola).post(`/v1/market/listings/${l.id}/ratings`, { stars: 5 })).body.error.code).toBe('rating_not_allowed');

    const sold = await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'sold', buyerId: bola.id });
    expect(sold.body.listing.status).toBe('sold');
    expect(await notes(bola, 'market_sold_to_you')).toEqual([
      { actor_id: ada.id, entity_type: 'listing', entity_id: l.id, data: { title: 'Electric kettle, 1.7 litres' } },
    ]);
    // Sold things leave the market, but the buyer can still open it and rate.
    expect(ids(await search(cat, { q: 'Electric kettle, 1.7' }))).toEqual([]);
    const forBuyer = (await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).body.listing;
    expect(forBuyer).toMatchObject({ forYou: true, rating: { canRate: true, rated: false, otherUser: { id: ada.id } } });
    const card = (await as(t.app, bola).get(`/v1/conversations/${conversationId}/messages`)).body.items.find((m: any) => m.market).market;
    expect(card).toMatchObject({ soldToBuyer: true, canRate: true });

    // Someone else who wrote about it can't rate, and nobody else can even find it.
    expect((await as(t.app, cat).post(`/v1/market/listings/${l.id}/ratings`, { stars: 1 })).body.error.code).toBe('rating_not_allowed');
    expect((await as(t.app, stranger).post(`/v1/market/listings/${l.id}/ratings`, { stars: 1 })).status).toBe(404);
    expect((await as(t.app, bola).post(`/v1/market/listings/${l.id}/ratings`, { stars: 6 })).status).toBe(400);
    const r1 = await as(t.app, bola).post(`/v1/market/listings/${l.id}/ratings`, { stars: 5, body: 'Easy pickup, kettle works well.' });
    expect(r1.status).toBe(201);
    expect(r1.body.rating).toMatchObject({ raterRole: 'buyer', stars: 5, rater: { id: bola.id }, listingTitle: 'Electric kettle, 1.7 litres' });
    expect((await as(t.app, bola).post(`/v1/market/listings/${l.id}/ratings`, { stars: 4 })).body.error.code).toBe('already_rated');
    expect((await as(t.app, ada).post(`/v1/market/listings/${l.id}/ratings`, { stars: 4 })).status).toBe(201);
    expect((await notes(ada, 'market_rated'))[0]).toMatchObject({ actor_id: bola.id, data: { stars: 5 } });

    // On the seller's Market tab: the rating, the average and the sale.
    const tab = (await as(t.app, cat).get(`/v1/market/sellers/${ada.id}`)).body.market;
    expect(tab.seller).toMatchObject({ rating: { average: 5, count: 1 }, sold: 1 });
    expect(tab.ratings.map((r: any) => r.body)).toEqual(['Easy pickup, kettle works well.']);
    expect((await as(t.app, cat).get(`/v1/market/sellers/${bola.id}`)).body.market.asBuyer).toEqual({ average: 4, count: 1 });
    const profile = (await as(t.app, cat).get(`/v1/users/${ada.username}`)).body;
    expect((profile.profile ?? profile).tabs).toContain('market');
  });

  it('works out how often a seller answers once enough people wrote', async () => {
    const ada = await seller();
    const l = await listed(ada, { title: 'Office chair, adjustable' });
    for (let i = 0; i < 3; i++) {
      const b = await seller();
      const { conversationId } = (await as(t.app, b).post(`/v1/market/listings/${l.id}/message`)).body;
      if (i < 2) await as(t.app, ada).post(`/v1/conversations/${conversationId}/messages`, { body: 'Hello, yes it is.' });
    }
    expect((await as(t.app, ada).get(`/v1/market/listings/${l.id}`)).body.listing.sellerCard.responseRate).toBe(67);
  });
});

describe('Listings ending', () => {
  it('reminds the seller before a listing ends, says when it ended, and can be renewed', async () => {
    const [ada, bola] = [await seller(), await seller()];
    const l = await listed(ada, { title: 'Rice cooker, 1 litre' });
    const early = await as(t.app, ada).post(`/v1/market/listings/${l.id}/renew`);
    expect(early.body.error.code).toBe('renew_too_early');

    await db().query(`UPDATE market_listings SET expires_at = now() + interval '2 days' WHERE id = $1`, [l.id]);
    await sweepMarket({ db: db(), realtime: t.ctx.realtime });
    await sweepMarket({ db: db(), realtime: t.ctx.realtime });
    expect(await notes(ada, 'market_expiring')).toEqual([
      { actor_id: null, entity_type: 'listing', entity_id: l.id, data: { title: 'Rice cooker, 1 litre', days: 2 } },
    ]);
    expect((await as(t.app, ada).get(`/v1/market/listings/${l.id}`)).body.listing.canRenew).toBe(true);

    await db().query(`UPDATE market_listings SET expires_at = now() - interval '1 minute' WHERE id = $1`, [l.id]);
    await sweepMarket({ db: db(), realtime: t.ctx.realtime });
    await sweepMarket({ db: db(), realtime: t.ctx.realtime });
    expect(await notes(ada, 'market_expired')).toHaveLength(1);
    expect(ids(await search(bola, { q: 'Rice cooker, 1' }))).toEqual([]);
    expect((await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).status).toBe(404);
    expect(ids(await as(t.app, ada).get('/v1/market/mine?status=expired'))).toContain(l.id);
    expect((await as(t.app, ada).get(`/v1/market/listings/${l.id}`)).body.listing).toMatchObject({ expired: true, canRenew: true });

    const renewed = await as(t.app, ada).post(`/v1/market/listings/${l.id}/renew`);
    expect(renewed.body.listing.expired).toBe(false);
    expect(ids(await search(bola, { q: 'Rice cooker, 1' }))).toEqual([l.id]);
    // Sold ones aren't reminded or renewed.
    await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'sold' });
    await db().query(`UPDATE market_listings SET expires_at = now() + interval '1 day' WHERE id = $1`, [l.id]);
    await sweepMarket({ db: db(), realtime: t.ctx.realtime });
    expect(await notes(ada, 'market_expiring')).toHaveLength(1);
    expect((await as(t.app, ada).post(`/v1/market/listings/${l.id}/renew`)).body.error.code).toBe('listing_sold');
  });

  it('erases deleted listings and their photos after 30 days, and deletes old ended ones', async () => {
    const ada = await seller();
    const gone = await listed(ada, { title: 'Ironing board' });
    const old = await listed(ada, { title: 'Clothes rack' });
    expect((await as(t.app, ada).del(`/v1/market/listings/${gone.id}`)).status).toBe(200);
    await db().query(`UPDATE market_listings SET deleted_at = now() - interval '31 days' WHERE id = $1`, [gone.id]);
    await db().query(`UPDATE market_listings SET expires_at = now() - interval '181 days' WHERE id = $1`, [old.id]);
    const r = await runRetention({ db: db(), storage: t.ctx.storage, config: t.ctx.config });
    expect(r.errors).toEqual([]);
    expect((await db().query(`SELECT 1 FROM market_listings WHERE id = $1`, [gone.id])).rowCount).toBe(0);
    expect((await db().query(`SELECT 1 FROM media WHERE id = $1`, [gone.photos[0].mediaId])).rowCount).toBe(0);
    expect((await db().query(`SELECT deleted_at FROM market_listings WHERE id = $1`, [old.id])).rows[0].deleted_at).not.toBeNull();
  });
});

describe('Saving, editing, reporting and your data', () => {
  it('saves listings, edits them and marks them reserved', async () => {
    const [ada, bola] = [await seller(), await seller()];
    const l = await listed(ada, { title: 'Wardrobe with mirror' });
    expect((await as(t.app, bola).put(`/v1/market/listings/${l.id}/save`)).body.saved).toBe(true);
    expect((await as(t.app, bola).get('/v1/market/saved')).body.items.map((x: any) => x.id)).toEqual([l.id]);
    expect((await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).body.listing.saved).toBe(true);
    expect((await as(t.app, bola).patch(`/v1/market/listings/${l.id}`, { title: 'Mine now' })).status).toBe(404);
    const edited = await as(t.app, ada).patch(`/v1/market/listings/${l.id}`, { priceCents: 2_000_000, delivery: ['pickup', 'seller_delivers'], place: null });
    expect(edited.body.listing).toMatchObject({ priceCents: 2_000_000, delivery: ['pickup', 'seller_delivers'], hasPlace: false });
    expect((await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'reserved' })).body.listing.status).toBe('reserved');
    expect((await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).body.listing.status).toBe('reserved');
    expect((await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'available' })).body.listing.status).toBe('available');
    expect((await as(t.app, bola).del(`/v1/market/listings/${l.id}/save`)).body.saved).toBe(false);
  });

  it('takes reports on listings and removes them after a decision', async () => {
    const [ada, bola, mod] = [await seller(), await seller(), await moderator()];
    const l = await listed(ada, { title: 'Designer handbag, like new' });
    expect((await as(t.app, ada).post('/v1/reports', { targetType: 'listing', targetId: l.id, reason: 'fraud' })).status).toBe(400);
    const r = await as(t.app, bola).post('/v1/reports', { targetType: 'listing', targetId: l.id, reason: 'fraud', details: 'Looks fake' });
    expect(r.status).toBe(201);
    const c = (await as(t.app, mod).get('/v1/admin/moderation/cases')).body.items.find((x: any) => x.target_type === 'listing' && x.target_id === l.id);
    expect(c).toMatchObject({ source: 'report', subject_user_id: ada.id });
    expect(c.media).toMatchObject({ kind: 'image' });
    await as(t.app, mod).post(`/v1/admin/moderation/cases/${c.id}/decide`, { decision: 'remove' });
    expect((await as(t.app, bola).get(`/v1/market/listings/${l.id}`)).status).toBe(404);
    expect((await db().query(`SELECT moderation_status FROM market_listings WHERE id = $1`, [l.id])).rows[0].moderation_status).toBe('removed');
  });

  it('shows a public preview for shared links only while it is for sale', async () => {
    const [ada, priv] = [await seller(), await seller()];
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [priv.id]);
    const l = await listed(ada, { title: 'Guitar with case', category: 'music', place: HERE });
    const r = await t.app.inject({ method: 'GET', url: `/v1/public/market/${l.id}` });
    expect(r.statusCode).toBe(200);
    const preview = r.json().listing;
    expect(preview).toMatchObject({
      title: 'Guitar with case',
      area: 'Yaba, Lagos',
      seller: { username: ada.username },
      imageUrl: 'http://localhost:4000/media/item_medium.webp',
    });
    expect(JSON.stringify(preview)).not.toContain(String(approximatePoint(HERE).lat));
    const hidden = await listed(priv, { title: 'Keyboard stand' });
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/market/${hidden.id}` })).json().listing.seller).toBeNull();
    await as(t.app, ada).put(`/v1/market/listings/${l.id}/status`, { status: 'sold' });
    expect((await t.app.inject({ method: 'GET', url: `/v1/public/market/${l.id}` })).statusCode).toBe(404);
  });

  it('puts Market in the data download and deletes it with the account', async () => {
    const [ada, bola] = [await seller(), await seller()];
    const mine = await listed(ada, { title: 'Table lamp, brass' });
    const theirs = await listed(bola, { title: 'Floor rug, grey' });
    await as(t.app, ada).put(`/v1/market/listings/${theirs.id}/save`);
    await as(t.app, ada).post(`/v1/market/listings/${theirs.id}/offers`, { amountCents: 50_000 });
    const d = (await as(t.app, ada).get('/v1/me/export')).body;
    expect(d.readme.sections.market).toBeTruthy();
    expect(d.market.listings[0]).toMatchObject({ id: mine.id, title: 'Table lamp, brass', area: 'Yaba, Lagos', has_approximate_place: true });
    expect(d.market.listings[0]).not.toHaveProperty('approx_lat');
    expect(JSON.stringify(d.market)).not.toContain(String(approximatePoint(HERE).lat));
    expect(d.market.saved).toMatchObject([{ listing_id: theirs.id }]);
    expect(d.market.chatsAboutListings).toMatchObject([{ listing_id: theirs.id, seller: bola.username }]);
    expect(d.market.offers).toMatchObject([{ your_side: 'buyer', with: bola.username, made_by: 'you', amount_cents: 50000, status: 'pending' }]);

    expect((await as(t.app, ada).del('/v1/me', { password: ada.password })).status).toBe(200);
    expect((await db().query(`SELECT 1 FROM market_listings WHERE seller_id = $1`, [ada.id])).rowCount).toBe(0);
    for (const table of ['market_saves WHERE user_id', 'market_offers WHERE buyer_id', 'market_chats WHERE buyer_id', 'market_ratings WHERE rater_id'])
      expect((await db().query(`SELECT 1 FROM ${table} = $1`, [ada.id])).rowCount).toBe(0);
    expect((await as(t.app, bola).get(`/v1/market/listings/${theirs.id}`)).status).toBe(200);
  });
});
