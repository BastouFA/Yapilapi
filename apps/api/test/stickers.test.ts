import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messagePreviewText, STICKER_MAX, t as tr, type MessageKey } from '@yapilapi/shared';
import type { BuiltApp } from '../src/app.ts';
import { pushTextFor } from '../src/lib/push.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
let png: Buffer;
beforeAll(async () => {
  t = await testApp();
  // A sticker as the maker makes it: 512 × 512, see-through around a circle.
  png = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="230" fill="#e4572e"/></svg>') }])
    .png()
    .toBuffer();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

async function upload(u: TestUser, data = png, name = 'sticker.png', mime = 'image/png'): Promise<string> {
  const boundary = '----yp' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().media.id;
}

async function chat(a: TestUser, b: TestUser): Promise<string> {
  await befriend(a, b);
  const r = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.conversation.id;
}

const send = (u: TestUser, conversationId: string, body: Record<string, unknown>) =>
  as(t.app, u).post(`/v1/conversations/${conversationId}/messages`, { clientId: `s-${Math.random()}`, ...body });

async function sticker(u: TestUser) {
  const mediaId = await upload(u);
  const r = await as(t.app, u).post('/v1/stickers', { mediaId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.sticker as { id: string; media: { id: string; url: string } };
}

describe('stickers', () => {
  it('adds your own photos as stickers, lists them newest first, and removes them', async () => {
    const a = await signUp(t.app);
    const first = await sticker(a);
    const second = await sticker(a);
    expect(first.media.url).toMatch(/\.png$/);
    // The same photo twice is one sticker.
    const again = await as(t.app, a).post('/v1/stickers', { mediaId: first.media.id });
    expect(again.body.sticker.id).toBe(first.id);
    const list = await as(t.app, a).get('/v1/stickers');
    expect(list.status).toBe(200);
    expect(list.body.max).toBe(STICKER_MAX);
    expect(list.body.items.map((s: { id: string }) => s.id)).toEqual([second.id, first.id]);
    expect(list.body.items[0].media).toMatchObject({ id: second.media.id, mime: 'image/png' });

    // Only your own: someone else can't list, add or remove yours.
    const b = await signUp(t.app);
    expect((await as(t.app, b).get('/v1/stickers')).body.items).toEqual([]);
    expect((await as(t.app, b).post('/v1/stickers', { mediaId: first.media.id })).status).toBe(404);
    expect((await as(t.app, b).del(`/v1/stickers/${first.id}`)).status).toBe(404);

    expect((await as(t.app, a).del(`/v1/stickers/${first.id}`)).status).toBe(200);
    expect((await as(t.app, a).get('/v1/stickers')).body.items.map((s: { id: string }) => s.id)).toEqual([second.id]);
    expect((await t.app.inject({ method: 'GET', url: '/v1/stickers' })).statusCode).toBe(401);
  });

  it('takes photos only, and none that are view once, removed or too big', async () => {
    const a = await signUp(t.app);
    const { rows } = await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status) VALUES ($1,'audio','http://localhost:4000/media/a.m4a','audio/mp4','ready') RETURNING id`,
      [a.id],
    );
    const voice = await as(t.app, a).post('/v1/stickers', { mediaId: rows[0].id });
    expect(voice.status).toBe(422);
    expect(voice.body.error.code).toBe('sticker_not_image');
    const blocked = await upload(a);
    await db().query(`UPDATE media SET moderation = 'blocked' WHERE id = $1`, [blocked]);
    expect((await as(t.app, a).post('/v1/stickers', { mediaId: blocked })).body.error.code).toBe('sticker_unavailable');
    const big = await upload(a);
    await db().query(`UPDATE media SET size_bytes = $2 WHERE id = $1`, [big, 6 * 1024 * 1024]);
    expect((await as(t.app, a).post('/v1/stickers', { mediaId: big })).status).toBe(413);
  });

  it(`keeps up to ${STICKER_MAX}`, async () => {
    const a = await signUp(t.app);
    await db().query(
      `WITH m AS (INSERT INTO media (owner_id, kind, url, mime, status) SELECT $1, 'image', 'http://localhost:4000/media/s' || g || '.png', 'image/png', 'ready'
                  FROM generate_series(1, $2) g RETURNING id)
       INSERT INTO stickers (owner_id, media_id) SELECT $1, id FROM m`,
      [a.id, STICKER_MAX],
    );
    const r = await as(t.app, a).post('/v1/stickers', { mediaId: await upload(a) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('sticker_limit');
    expect(r.body.error.message).toBe('You can keep up to 200 stickers. Remove one to add another.');
    expect((await as(t.app, a).get('/v1/stickers')).body.items).toHaveLength(STICKER_MAX);
  });

  it('sends a sticker as one photo with no words, and says "Sticker" in previews, quotes and pushes', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const id = await chat(a, b);
    const s = await sticker(a);
    const other = await upload(a);
    const { rows } = await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status) VALUES ($1,'audio','http://localhost:4000/media/a.m4a','audio/mp4','ready') RETURNING id`,
      [a.id],
    );
    for (const bad of [
      { body: 'hi', attachments: [{ mediaId: s.media.id }] },
      { attachments: [{ mediaId: s.media.id }, { mediaId: other }] },
      { attachments: [{ mediaId: rows[0].id }] },
      { attachments: [{ mediaId: s.media.id }], kind: 'yap' },
    ]) {
      const r = await send(a, id, { ...bad, sticker: true });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code, JSON.stringify(bad)).toBe('sticker_invalid');
    }
    const sent = await send(a, id, { attachments: [{ mediaId: s.media.id }], sticker: true });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.message).toMatchObject({ sticker: true, body: '', attachments: [{ kind: 'image', mediaId: s.media.id, url: s.media.url }] });
    // Kept: it's a sticker for whoever reads the chat, and it can't be edited into a text.
    const read = await as(t.app, b).get(`/v1/conversations/${id}/messages`);
    expect(read.body.items.at(-1)).toMatchObject({ id: sent.body.message.id, sticker: true });
    expect((await as(t.app, a).patch(`/v1/messages/${sent.body.message.id}`, { body: 'words' })).body.error.code).toBe('not_editable');

    const inbox = await as(t.app, b).get('/v1/conversations');
    const last = inbox.body.items.find((c: { id: string }) => c.id === id).lastMessage;
    expect(last.preview).toMatchObject({ sticker: true, attachmentKind: 'image' });
    expect(messagePreviewText(last.preview, { t: (k: MessageKey, v?: Record<string, string | number>) => tr(k, 'en', v) })).toBe('Sticker');
    expect(pushTextFor('message', 'Ada', { preview: last.preview }, 'en')).toBe('Ada: Sticker');
    expect(pushTextFor('message', 'Ada', { preview: last.preview, private: true }, 'en')).toBe('Ada: Sticker');

    const reply = await send(b, id, { body: 'Nice', replyToId: sent.body.message.id });
    expect(reply.body.message.replyTo).toMatchObject({ id: sent.body.message.id, sticker: true });

    // Forwarded, it's still a sticker.
    const c = await signUp(t.app);
    const other2 = await chat(b, c);
    const fwd = await as(t.app, b).post(`/v1/messages/${sent.body.message.id}/forward`, { conversationIds: [other2] });
    expect(fwd.status, JSON.stringify(fwd.body)).toBe(201);
    expect(fwd.body.messages[0]).toMatchObject({ sticker: true, forwarded: true });
  });

  it('saves a sticker someone sent as a copy of your own, which you can send on', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const id = await chat(a, b);
    const s = await sticker(a);
    const sent = await send(a, id, { attachments: [{ mediaId: s.media.id }], sticker: true });
    const photo = await send(a, id, { attachments: [{ mediaId: await upload(a) }] });

    // Only people in the chat, and only a sticker.
    const stranger = await signUp(t.app);
    expect((await as(t.app, stranger).post('/v1/stickers/save', { messageId: sent.body.message.id })).status).toBe(404);
    const notSticker = await as(t.app, b).post('/v1/stickers/save', { messageId: photo.body.message.id });
    expect(notSticker.status).toBe(422);
    expect(notSticker.body.error.code).toBe('not_a_sticker');

    const saved = await as(t.app, b).post('/v1/stickers/save', { messageId: sent.body.message.id });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.sticker.fromMediaId).toBe(s.media.id);
    expect(saved.body.sticker.media.id).not.toBe(s.media.id);
    const { rows } = await db().query(`SELECT owner_id, kind, mime FROM media WHERE id = $1`, [saved.body.sticker.media.id]);
    expect(rows[0]).toEqual({ owner_id: b.id, kind: 'image', mime: 'image/png' });
    // Saving it again is the same sticker.
    const again = await as(t.app, b).post('/v1/stickers/save', { messageId: sent.body.message.id });
    expect(again.body.sticker.id).toBe(saved.body.sticker.id);
    expect((await as(t.app, b).get('/v1/stickers')).body.items).toHaveLength(1);

    // It's theirs now: they can send it to someone else, and it stays when the first person removes theirs.
    const c = await signUp(t.app);
    const bc = await chat(b, c);
    await as(t.app, a).del(`/v1/stickers/${s.id}`);
    const on = await send(b, bc, { attachments: [{ mediaId: saved.body.sticker.media.id }], sticker: true });
    expect(on.status, JSON.stringify(on.body)).toBe(201);
    expect(on.body.message.attachments[0].url).toBe(saved.body.sticker.media.url);
    // In their data export too.
    const exported = await db().query(`SELECT count(*)::int AS n FROM stickers WHERE owner_id = $1`, [b.id]);
    expect(exported.rows[0].n).toBe(1);
  });

  it('respects blocks', async () => {
    const a = await signUp(t.app);
    const b = await signUp(t.app);
    const c = await signUp(t.app);
    await befriend(a, b);
    await befriend(a, c);
    await befriend(b, c);
    const group = await as(t.app, a).post('/v1/conversations', { memberIds: [b.id, c.id], title: 'Crew' });
    const id = group.body.conversation.id;
    const s = await sticker(a);
    const sent = await send(a, id, { attachments: [{ mediaId: s.media.id }], sticker: true });
    expect(sent.status).toBe(201);
    // Someone who blocked the sender, or whom the sender blocked, can't keep their sticker.
    expect((await as(t.app, b).post(`/v1/users/${a.id}/block`)).status).toBeLessThan(300);
    expect((await as(t.app, b).post('/v1/stickers/save', { messageId: sent.body.message.id })).status).toBe(404);
    expect((await as(t.app, a).post(`/v1/users/${c.id}/block`)).status).toBeLessThan(300);
    expect((await as(t.app, c).post('/v1/stickers/save', { messageId: sent.body.message.id })).status).toBe(404);
  });

  it('goes with the account', async () => {
    const a = await signUp(t.app);
    await sticker(a);
    const exp = await import('../src/lib/data-export.ts');
    const sections = await exp.exportSections(db(), a.id);
    expect(sections.chats.stickers).toHaveLength(1);
    expect(sections.chats.stickers[0]).toMatchObject({ saved_from_chat: false });
    const del = await t.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { password: a.password },
    });
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await db().query(`SELECT 1 FROM stickers WHERE owner_id = $1`, [a.id])).rowCount).toBe(0);
  });
});
