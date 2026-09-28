import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t } from '@yapilapi/shared/i18n';
import type { BuiltApp } from '../src/app.ts';
import { drawCredit } from '../src/lib/echoes.ts';
import { messageFailureCode, recapFailure } from '../src/lib/failures.ts';
import { recapCandidates } from '../src/lib/recaps.ts';
import { recordSignIn } from '../src/lib/sign-in-alerts.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/**
 * The last sentences the API wrote in English for the apps to show as they were: why a job
 * failed, chat lines the server makes, a sign-in's device and place, the "On this day" title, an
 * assistant's product line, a boost's name and the credit burned into an echo. The API sends codes
 * (keeping its English for older apps) or writes the text in its reader's language.
 */
let t0: BuiltApp;
beforeAll(async () => {
  t0 = await testApp();
});
afterAll(() => t0.close());

const db = () => t0.ctx.db;
const adult = (extra: Record<string, unknown> = {}) => signUp(t0.app, { birthDate: '1990-01-01', ...extra });
async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}
async function direct(a: TestUser, b: TestUser) {
  await befriend(a, b);
  const r = await as(t0.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status).toBe(201);
  return r.body.conversation.id as string;
}
const lastMessageIn = async (u: TestUser, conversationId: string) =>
  ((await as(t0.app, u).get('/v1/conversations')).body.items as { id: string; lastMessage: any }[]).find((c) => c.id === conversationId)!.lastMessage;

describe('why a job failed', () => {
  it('reads a stored code back with its English, and gives rows from before codes a code', () => {
    expect(recapFailure('items_unreadable')).toEqual({
      code: 'items_unreadable',
      english: "We couldn't read the photos or videos you chose. Try again later.",
    });
    // What ffmpeg said is dropped.
    expect(
      recapFailure("We couldn't make this recap. Try again with fewer or different photos and videos. (Invalid data found when processing input)"),
    ).toEqual({
      code: 'render_failed',
      english: "We couldn't make this recap. Try again with fewer or different photos and videos.",
    });
    expect(recapFailure('Something else entirely')).toMatchObject({ code: 'failed' });
    expect(recapFailure(null)).toBeNull();
  });

  it('turns why a send was refused into a code', () => {
    expect(messageFailureCode({ status: 403, code: 'not_member' })).toBe('left_chat');
    expect(messageFailureCode({ status: 403, code: 'forbidden' })).toBe('cannot_message');
    expect(messageFailureCode({ status: 403, code: 'minor_protection' })).toBe('cannot_message');
    expect(messageFailureCode({ status: 403, code: 'account_restricted' })).toBe('account_limited');
    expect(messageFailureCode({ status: 403, code: 'verification_required' })).toBe('verify');
    expect(messageFailureCode({ status: 422, code: 'content_blocked' })).toBe('content_blocked');
    expect(messageFailureCode({ status: 429, code: 'slow_down' })).toBe('too_fast');
    expect(messageFailureCode({ status: 500, code: 'internal' })).toBe('not_sent');
  });
});

describe('sending a story to people', () => {
  it('says why it didn’t reach someone as a code, with the English for older apps', async () => {
    const ada = await adult();
    const bola = await adult();
    const cleo = await adult();
    await befriend(ada, bola);
    await befriend(ada, cleo);
    const story = (await as(t0.app, ada).post('/v1/moments', { body: 'Sunset', visibility: 'friends' })).body.moment;
    expect((await as(t0.app, cleo).post(`/v1/users/${ada.id}/block`)).status).toBeLessThan(300);
    const r = await as(t0.app, ada).post(`/v1/moments/${story.id}/send`, { userIds: [bola.id, cleo.id] });
    expect(r.status).toBe(201);
    expect(r.body.failed).toEqual([{ id: cleo.id, code: 'cannot_message', message: "You can't message this person right now." }]);
    // Nobody reached: the refusal says why as a code too.
    const none = await as(t0.app, ada).post(`/v1/moments/${story.id}/send`, { userIds: [cleo.id] });
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: 'not_sent', details: { reason: 'cannot_message' } });
  });
});

describe('chat lines the server writes', () => {
  const LONG = 'Our first morning at the new studio, with the light coming in over the river and the whole team';
  const QUOTE = `${LONG.slice(0, 80)}…`;
  it('keeps a story reply’s text apart from what it answers', async () => {
    const author = await adult();
    const fan = await adult();
    await as(t0.app, fan).post(`/v1/users/${author.id}/follow`);
    const s = (await as(t0.app, author).post('/v1/moments', { body: LONG, visibility: 'followers' })).body.moment;
    const r = await as(t0.app, fan).post(`/v1/moments/${s.id}/reply`, { body: 'So good' });
    expect(r.status).toBe(201);
    const chat = r.body.conversationId as string;
    const [reply] = (await as(t0.app, author).get(`/v1/conversations/${chat}/messages`)).body.items.slice(-1);
    expect(reply).toMatchObject({ body: 'So good', storyReply: { quote: QUOTE } });
    // In the inbox too, for its one-line preview.
    expect(await lastMessageIn(author, chat)).toMatchObject({
      body: 'So good',
      storyReply: { quote: QUOTE },
      preview: { body: 'So good', storyReply: { quote: QUOTE } },
    });
  });

  it('only lets you mark a message as a reply to the other person’s story, one you can see', async () => {
    const author = await adult();
    const ada = await adult();
    const bola = await adult();
    await befriend(author, ada);
    const s = (await as(t0.app, author).post('/v1/moments', { body: 'Friends only', visibility: 'friends' })).body.moment;
    const send = (chat: string, storyReplyTo: string) => as(t0.app, ada).post(`/v1/conversations/${chat}/messages`, { body: 'Hi', storyReplyTo });
    // Not in a chat with someone other than its author.
    expect((await send(await direct(ada, bola), s.id)).status).toBe(404);
    // Your chat with the author: yes.
    const withAuthor = await direct(ada, author);
    expect((await send(withAuthor, s.id)).body.message).toMatchObject({ body: 'Hi', storyReply: { quote: 'Friends only' } });
    // Not a story you can't see any more.
    await db().query(`UPDATE moments SET deleted_at = now() WHERE id = $1`, [s.id]);
    expect((await send(withAuthor, s.id)).status).toBe(404);
  });

  it('sends the inbox what a location, a game or an offer is, not only its English body', async () => {
    const ada = await adult();
    const bola = await adult();
    const chat = await direct(ada, bola);
    const pin = await as(t0.app, ada).post(`/v1/conversations/${chat}/location`, { lat: 6.52437, lng: 3.37921, precision: 'approximate', mode: 'once' });
    expect(pin.status).toBe(201);
    expect(await lastMessageIn(bola, chat)).toMatchObject({ body: 'Location', preview: { kind: 'location', live: false } });
    const game = await as(t0.app, ada).post(`/v1/conversations/${chat}/games`, { kind: 'noughts', playerIds: [bola.id] });
    expect(game.status).toBe(201);
    expect(await lastMessageIn(bola, chat)).toMatchObject({ body: 'Noughts', preview: { kind: 'game', gameKind: 'noughts' } });
  });

  it('sends an offer’s amount for the app to write in the reader’s language', async () => {
    const seller = await adult();
    const buyer = await adult();
    await db().query(`UPDATE profiles SET country = 'NG' WHERE user_id = ANY($1::uuid[])`, [[seller.id, buyer.id]]);
    const photo = (
      await db().query(
        `INSERT INTO media (owner_id, kind, url, mime, status, moderation) VALUES ($1,'image','http://localhost:4000/media/x.jpg','image/jpeg','ready','ok') RETURNING id`,
        [seller.id],
      )
    ).rows[0].id;
    const listing = await as(t0.app, seller).post('/v1/market/listings', {
      title: 'Wooden study desk for a child',
      description: 'Solid desk with two drawers, a few marks on the top.',
      category: 'furniture',
      condition: 'good',
      priceCents: 2_500_000,
      photos: [{ mediaId: photo, altText: 'A brown desk' }],
      area: 'Yaba, Lagos',
      place: { lat: 6.51234, lng: 3.37891 },
      delivery: ['pickup'],
    });
    expect(listing.status, JSON.stringify(listing.body)).toBe(201);
    const offered = await as(t0.app, buyer).post(`/v1/market/listings/${listing.body.listing.id}/offers`, { amountCents: 2_000_000 });
    expect(offered.status).toBe(201);
    expect(await lastMessageIn(seller, offered.body.conversationId)).toMatchObject({
      body: 'Offer · NGN 20,000.00',
      preview: { kind: 'offer', offer: { amountCents: 2_000_000, currency: 'NGN', counter: false } },
    });
  });
});

describe('a sign-in from a new device', () => {
  const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

  it('names the device and the country in the reader’s language, in the list and live', async () => {
    const fr = await adult({ locale: 'fr' });
    await db().query(`INSERT INTO known_sign_ins (user_id, fingerprint) VALUES ($1, 'firefox on linux|')`, [fr.id]);
    const sent = await recordSignIn(
      { db: db(), realtime: t0.ctx.realtime, email: t0.ctx.email, webOrigin: 'https://y.test' },
      { userId: fr.id, sessionId: randomUUID(), userAgent: CHROME_MAC, country: 'DE' },
    );
    expect(sent).toBe(true);
    const stored = (await db().query(`SELECT data FROM notifications WHERE user_id = $1 AND type = 'new_sign_in'`, [fr.id])).rows[0].data;
    // The English stays for older apps; the labels come in the account's language.
    expect(stored).toMatchObject({ device: 'Chrome on macOS', place: 'Germany', country: 'DE', deviceLabel: 'Chrome sur macOS', placeLabel: 'Allemagne' });
    // Read in the language set now.
    await db().query(`UPDATE profiles SET locale = 'es' WHERE user_id = $1`, [fr.id]);
    const [n] = (await as(t0.app, fr).get('/v1/notifications')).body.items.filter((x: { type: string }) => x.type === 'new_sign_in');
    expect(n.data).toMatchObject({
      device: 'Chrome on macOS',
      deviceLabel: t('email.device.name', 'es', { browser: 'Chrome', os: 'macOS' }),
      placeLabel: 'Alemania',
    });
  });

  it('names each signed-in device in the reader’s language, keeping the stored name', async () => {
    const fr = await adult({ locale: 'fr' });
    const [s] = (await as(t0.app, fr).get('/v1/auth/sessions')).body.items;
    // The test client names no browser or system: an unknown device.
    expect(s).toMatchObject({ device: 'Unknown device', deviceLabel: t('email.device.unknown', 'fr') });
  });
});

describe('text the server makes itself', () => {
  it('titles "On this day" in your language', async () => {
    // What GET /v1/recaps/candidates?source=on_this_day pre-fills (the endpoint is behind the Memory flag).
    const fr = await adult({ locale: 'fr' });
    expect((await recapCandidates(db(), fr.id, { source: 'on_this_day' })).title).toBe(t('m.recap.onThisDay', 'fr'));
    const en = await adult();
    expect((await recapCandidates(db(), en.id, { source: 'on_this_day' })).title).toBe('On this day');
  });

  it('names a boost with a code, from its post’s words', async () => {
    const ada = await adult();
    const post = (await as(t0.app, ada).post('/v1/posts', { body: 'Our new menu', visibility: 'public' })).body.post;
    for (const [name, days] of [
      ['Boost: Our new menu', 7],
      ['Boost', 3],
      ['Summer sale', null],
    ] as const)
      await db().query(`INSERT INTO ad_campaigns (advertiser_id, post_id, name, currency, cpm_cents, boost_days) VALUES ($1,$2,$3,'USD',500,$4)`, [
        ada.id,
        post.id,
        name,
        days,
      ]);
    const items = (await as(t0.app, ada).get('/v1/ads/campaigns')).body.items as { name: string; nameCode?: string; nameParams?: object }[];
    const by = (name: string) => items.find((c) => c.name === name)!;
    expect(by('Boost: Our new menu')).toMatchObject({ nameCode: 'boost', nameParams: { excerpt: 'Our new menu' } });
    expect(by('Boost')).toMatchObject({ nameCode: 'boost', nameParams: { excerpt: '' } });
    expect(by('Summer sale').nameCode).toBeUndefined();
  });

  it('draws the echo credit in the echo author’s language', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ypl-credit-'));
    try {
      const width = async (locale: string) => {
        const file = path.join(dir, `${locale}.png`);
        expect(await drawCredit(file, 'ada_lagos', 32, locale)).toBe(true);
        return (await sharp(file).metadata()).width!;
      };
      // "Echo of @ada_lagos" and "Mwangwi wa @ada_lagos" aren't the same length.
      expect(await width('sw')).not.toBe(await width('en'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
