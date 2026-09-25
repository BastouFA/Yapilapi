import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { withTransaction } from '@yapilapi/database';
import { DefaultMediaProcessor } from '../src/modules/media/processor.js';
import { LocalStorageAdapter } from '../src/modules/media/storage.js';
import {
  cleanupExpiredUploads,
  getMediaRuntime,
  overrideMediaRuntime,
  purgeDeletedMedia,
} from '../src/modules/media/index.js';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  type TestApp,
  type TestUser,
} from './helpers.js';
import {
  exe,
  ftypOnly,
  hasFfmpeg,
  jpegWithGps,
  mp4,
  pathOf,
  pdf,
  png,
  raw,
  upload,
  wav,
} from './media-fixtures.js';

let t: TestApp;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'yl-media-test-'));
  t = await createTestApp({ MEDIA_LOCAL_DIR: dir });
});
afterAll(async () => {
  await getMediaRuntime(t.ctx).queue.idle();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const sql = <T extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<T>(text, params);
const idle = () => getMediaRuntime(t.ctx).queue.idle();
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const befriend = async (a: TestUser, b: TestUser) => {
  await a.client.post('/v1/friends/requests', { username: b.username });
  await b.client.post(`/v1/friends/requests/${a.id}/accept`);
};

async function uploadOk(u: TestUser, data: Buffer, opts: Parameters<typeof upload>[3] = {}) {
  const r = await upload(t, u, data, opts);
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** Upload and wait for the processing pipeline. */
async function uploadReady(u: TestUser, data: Buffer, opts: Parameters<typeof upload>[3] = {}) {
  const m = await uploadOk(u, data, opts);
  await idle();
  const r = await u.client.get(`/v1/media/${m.id}`);
  return r.body;
}
const fetchUrl = (u: TestUser | null, url: string, headers: Record<string, string> = {}) =>
  raw(t, u, 'GET', pathOf(url), { headers });
const statusOf = async (u: TestUser | null, url: string) => (await fetchUrl(u, url)).status;

describe('uploads: sniffing, limits, privacy', () => {
  it('requires authentication', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/media',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--',
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores a PNG by what it IS, whatever the client calls it', async () => {
    const a = await signup(t);
    const m = await uploadOk(a, await png(), {
      filename: 'holiday.exe',
      contentType: 'application/x-msdownload',
    });
    expect(m).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      status: 'uploaded',
      purpose: 'attachment',
      needsAltText: true,
    });
    expect(m.url).toMatch(/\/media\/m\/[0-9a-f]{2}\/[0-9a-f]{32}\.png$/); // 128-bit random key, extension from the sniffed type
    expect(m.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    await idle();
    const ready = (await a.client.get(`/v1/media/${m.id}`)).body;
    expect(ready).toMatchObject({ status: 'ready', width: 16, height: 16, processing: 'variants' });
    expect(ready.blurhash).toBeTruthy();
    expect(ready.variants.map((v: any) => v.name)).toContain('thumb');
    const thumb = ready.variants.find((v: any) => v.name === 'thumb');
    expect(thumb.mimeType).toBe('image/webp');
    expect(await statusOf(a, thumb.url)).toBe(200);
  });

  it('keys are unguessable and unique', async () => {
    const a = await signup(t);
    const keys = new Set<string>();
    for (let i = 0; i < 3; i++) keys.add((await uploadOk(a, await png(`rgb(${i * 40},0,0)`))).url);
    expect(keys.size).toBe(3);
  });

  it('rejects a renamed executable, script and SVG, and a PNG labelled as video', async () => {
    const a = await signup(t);
    expect(
      (await upload(t, a, exe(), { filename: 'cute-cat.png', contentType: 'image/png' })).status,
    ).toBe(415);
    expect(
      (
        await upload(
          t,
          a,
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          { filename: 'x.svg', contentType: 'image/svg+xml' },
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await upload(t, a, Buffer.from('<html><script>alert(1)</script></html>'), {
          filename: 'x.jpg',
          contentType: 'image/jpeg',
        })
      ).status,
    ).toBe(415);
    // A real PNG that the client claims is a video: rejected, not silently re-typed.
    expect(
      (await upload(t, a, await png(), { filename: 'clip.mp4', contentType: 'video/mp4' })).status,
    ).toBe(415);
    expect(
      (await upload(t, a, await png(), { filename: 'clip.bin', fields: { kind: 'video' } })).status,
    ).toBe(415);
    // and an executable inside a chunked upload
    const data = exe();
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'image',
      size: data.length,
      sha256: sha(data),
    });
    expect(init.status).toBe(201);
    expect(
      (
        await raw(t, a, 'PUT', `/v1/media/uploads/${init.body.id}/chunks/0`, {
          payload: data,
          headers: { 'content-type': 'application/octet-stream' },
        })
      ).status,
    ).toBe(415);
    expect((await sql('SELECT 1 FROM media WHERE id = $1', [init.body.id])).rowCount).toBe(0); // failed fast and cleaned up
    expect((await sql(`SELECT 1 FROM media WHERE owner_id = $1`, [a.id])).rowCount).toBe(0);
  });

  it('rejects empty, malformed and oversized uploads', async () => {
    const a = await signup(t);
    expect((await upload(t, a, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(t, a, Buffer.from('%PDF-'), {})).status).toBe(415); // too short to be a real file
    const notMultipart = await raw(t, a, 'POST', '/v1/media', {
      payload: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(notMultipart.status).toBe(415);
    // 21 MB "PNG": over the 20 MB image ceiling.
    const bigImage = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(21 * 1024 * 1024),
    ]);
    expect((await upload(t, a, bigImage)).status).toBe(413);
    // 33 MB: over the single-request ceiling for any kind; must use resumable uploads.
    const huge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(33 * 1024 * 1024)]);
    expect((await upload(t, a, huge)).status).toBe(413);
    // files: 25 MB max
    const bigPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(26 * 1024 * 1024)]);
    expect((await upload(t, a, bigPdf)).status).toBe(413);
    // an image that has valid magic bytes but cannot be decoded is refused, not stored
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      randomBytes(64),
    ]);
    expect((await upload(t, a, broken)).status).toBe(422);
    // public purpose is for images only
    expect((await upload(t, a, pdf(), { fields: { purpose: 'public' } })).status).toBe(400);
  });

  it('strips EXIF/GPS from images before they are stored', async () => {
    const a = await signup(t);
    const src = await jpegWithGps();
    expect((await sharp(src).metadata()).exif).toBeDefined();
    const m = await uploadOk(a, src, { filename: 'IMG_0001.JPG', contentType: 'image/jpeg' });
    expect(m.metadataStripped).toBe(true);
    const served = await fetchUrl(a, m.url);
    expect(served.status).toBe(200);
    const stored = Buffer.from(served.rawBody);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from('SecretCam'))).toBe(false);
    expect(stored.includes(Buffer.from('GPS'))).toBe(false);
    // The checksum we report is of the stored (stripped) bytes.
    expect(m.checksumSha256).toBe(sha(stored));
  });

  it('prompts for alt text and lets the owner set it or mark the image decorative', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const m = await uploadOk(a, await png());
    expect(m.needsAltText).toBe(true);
    const withAlt = await uploadOk(a, await png('blue'), {
      fields: { altText: '  A red square  ' },
    });
    expect(withAlt).toMatchObject({ altText: 'A red square', needsAltText: false });
    expect(
      (await uploadOk(a, await png('green'), { fields: { decorative: 'true' } })).needsAltText,
    ).toBe(false);
    const patched = await a.client.patch(`/v1/media/${m.id}`, { altText: 'A tiny red square' });
    expect(patched.body).toMatchObject({ altText: 'A tiny red square', needsAltText: false });
    expect(
      (await a.client.patch(`/v1/media/${m.id}`, { decorative: true, altText: null })).body
        .needsAltText,
    ).toBe(false);
    expect((await a.client.patch(`/v1/media/${m.id}`, { altText: 'x'.repeat(1501) })).status).toBe(
      400,
    );
    expect((await b.client.patch(`/v1/media/${m.id}`, { altText: 'hijack' })).status).toBe(404);
  });
});

describe('serving', () => {
  it('sends safe headers, honours Range and validators, and refuses traversal', async () => {
    const a = await signup(t);
    const data = await png('purple', 64);
    const m = await uploadReady(a, data);
    const r = await fetchUrl(a, m.url);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(r.headers['content-disposition']).toMatch(
      /^inline; filename="yapilapi-[0-9a-f]+\.png"$/,
    );
    expect(r.headers['cache-control']).toBe('private, max-age=3600');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(Number(r.headers['content-length'])).toBe(r.rawBody.length);

    const part = await fetchUrl(a, m.url, { range: 'bytes=0-7' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-7/${r.rawBody.length}`);
    expect(part.rawBody.equals(r.rawBody.subarray(0, 8))).toBe(true);
    const tail = await fetchUrl(a, m.url, { range: 'bytes=-4' });
    expect(tail.status).toBe(206);
    expect(tail.rawBody.equals(r.rawBody.subarray(-4))).toBe(true);
    const bad = await fetchUrl(a, m.url, { range: `bytes=${r.rawBody.length + 10}-` });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${r.rawBody.length}`);
    expect((await fetchUrl(a, m.url, { 'if-none-match': r.headers.etag as string })).status).toBe(
      304,
    );

    const key = pathOf(m.url).replace('/media/', '');
    for (const evil of [
      '/media/../../etc/passwd',
      '/media/%2e%2e/%2e%2e/etc/passwd',
      `/media/${key}/../../../x`,
      '/media/u/anything/0',
      '/media/m/zz/nope.png',
      '/media/',
    ]) {
      expect([400, 404]).toContain((await raw(t, a, 'GET', evil)).status);
    }
  });

  it('serves PDFs as attachments and only ever with the sniffed type', async () => {
    const a = await signup(t);
    const m = await uploadReady(a, pdf(), { filename: 'evil.html', contentType: 'text/html' });
    expect(m).toMatchObject({
      kind: 'file',
      mimeType: 'application/pdf',
      processing: 'passthrough',
      status: 'ready',
    });
    const r = await fetchUrl(a, m.url);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(
      /^attachment; filename="yapilapi-[0-9a-f]+\.pdf"$/,
    );
    expect(r.headers['content-security-policy']).toContain('sandbox');
  });

  it('keeps unattached media owner-only, and public media world-readable with immutable caching', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const priv = await uploadReady(a, await png('orange'));
    expect(await statusOf(a, priv.url)).toBe(200);
    expect(await statusOf(b, priv.url)).toBe(404);
    expect(await statusOf(null, priv.url)).toBe(404);
    expect((await b.client.get(`/v1/media/${priv.id}`)).status).toBe(404);
    expect((await new Client(t).get(`/v1/media/${priv.id}`)).status).toBe(404);

    const pub = await uploadReady(a, await png('teal'), { fields: { purpose: 'public' } });
    for (const who of [a, b, null]) expect(await statusOf(who, pub.url)).toBe(200);
    const r = await fetchUrl(null, pub.url);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(String(r.headers.vary ?? '')).not.toMatch(/cookie/i); // shareable by CDNs
  });

  it('does not serve pending, failed or blocked media', async () => {
    const a = await signup(t);
    const m = await uploadReady(a, await png('gray'));
    const key = pathOf(m.url).replace('/media/', '');
    await sql(`UPDATE media SET status = 'failed' WHERE id = $1`, [m.id]);
    expect(await statusOf(a, m.url)).toBe(404);
    await sql(`UPDATE media SET status = 'pending' WHERE id = $1`, [m.id]);
    expect(await statusOf(a, m.url)).toBe(404);
    await sql(`UPDATE media SET status = 'ready' WHERE id = $1`, [m.id]);
    expect(await statusOf(a, m.url)).toBe(200);
    expect(key).toBeTruthy();
  });
});

describe('authorization follows what the media is attached to', () => {
  it('posts: every audience x every viewer', async () => {
    const author = await signup(t);
    const follower = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    const blocked = await signup(t);
    await follower.client.put(`/v1/users/${author.username}/follow`);
    await befriend(author, friend);
    await author.client.put(`/v1/users/${blocked.username}/block`);

    const make = async (visibility: string) => {
      const m = await uploadReady(author, await png(`rgb(${randomBytes(1)[0]},10,10)`));
      const p = await author.client.post('/v1/posts', {
        body: `media ${visibility}`,
        visibility,
        mediaIds: [m.id],
      });
      expect(p.status).toBe(201);
      return {
        url: m.url as string,
        thumb: m.variants[0].url as string,
        postId: p.body.id as string,
      };
    };
    const items = {
      public: await make('public'),
      followers: await make('followers'),
      friends: await make('friends'),
      private: await make('private'),
    };
    const viewers: Array<[string, TestUser | null, Record<string, boolean>]> = [
      ['author', author, { public: true, followers: true, friends: true, private: true }],
      ['follower', follower, { public: true, followers: true, friends: false, private: false }],
      ['friend', friend, { public: true, followers: false, friends: true, private: false }],
      ['stranger', stranger, { public: true, followers: false, friends: false, private: false }],
      ['blocked', blocked, { public: false, followers: false, friends: false, private: false }],
      ['anonymous', null, { public: true, followers: false, friends: false, private: false }],
    ];
    for (const [who, u, expected] of viewers) {
      for (const [vis, item] of Object.entries(items)) {
        expect({ who, vis, original: await statusOf(u, item.url) }).toEqual({
          who,
          vis,
          original: expected[vis] ? 200 : 404,
        });
        expect({ who, vis, variant: await statusOf(u, item.thumb) }).toEqual({
          who,
          vis,
          variant: expected[vis] ? 200 : 404,
        });
      }
    }
    // Metadata endpoint follows the same rule.
    expect(
      (
        await stranger.client.get(
          `/v1/media/${(await sql(`SELECT media_id FROM post_media WHERE post_id = $1`, [items.friends.postId])).rows[0].media_id}`,
        )
      ).status,
    ).toBe(404);

    // Deleting the post takes the media out of reach of everyone but the owner.
    expect((await author.client.del(`/v1/posts/${items.public.postId}`)).status).toBe(204);
    expect(await statusOf(stranger, items.public.url)).toBe(404);
    expect(await statusOf(null, items.public.url)).toBe(404);
    expect(await statusOf(author, items.public.url)).toBe(200);
  });

  it('posts: an unlink/visibility change (private account) applies to media immediately', async () => {
    const a = await signup(t);
    const stranger = await signup(t);
    const m = await uploadReady(a, await png('navy'));
    const p = await a.client.post('/v1/posts', {
      body: 'x',
      visibility: 'public',
      mediaIds: [m.id],
    });
    expect(p.status).toBe(201);
    expect(await statusOf(stranger, m.url)).toBe(200);
    await a.client.patch('/v1/profile', { isPrivate: true });
    expect(await statusOf(stranger, m.url)).toBe(404);
    expect(await statusOf(null, m.url)).toBe(404);
  });

  it('moments: audience and expiry apply to their media', async () => {
    const author = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(author, friend);
    const m = await uploadReady(author, await png('maroon'));
    const mo = await sql<{ id: string }>(
      `INSERT INTO moments (author_id, kind, media_id, visibility, expiry, expires_at) VALUES ($1,'photo',$2,'friends','24h', now() + interval '1 hour') RETURNING id`,
      [author.id, m.id],
    );
    expect(await statusOf(friend, m.url)).toBe(200);
    expect(await statusOf(stranger, m.url)).toBe(404);
    expect(await statusOf(null, m.url)).toBe(404);
    await sql(`UPDATE moments SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      mo.rows[0]!.id,
    ]);
    expect(await statusOf(friend, m.url)).toBe(404); // expired: gone immediately, no cleanup job needed
    expect(await statusOf(author, m.url)).toBe(200); // owner still owns the bytes until the sweep runs
  });

  it('messages: only conversation members, and group members only from when they joined', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const late = await signup(t);
    const m = await uploadReady(a, await png('pink'));
    const conv = (await a.client.post('/v1/conversations/direct', { userId: b.id })).body.id;
    const sent = await a.client.post(`/v1/conversations/${conv}/messages`, {
      kind: 'media',
      attachmentIds: [m.id],
    });
    expect(sent.status).toBe(201);
    expect(await statusOf(a, m.url)).toBe(200);
    expect(await statusOf(b, m.url)).toBe(200);
    expect(await statusOf(c, m.url)).toBe(404);
    expect(await statusOf(null, m.url)).toBe(404);
    await a.client.put(`/v1/users/${b.username}/block`);
    expect(await statusOf(b, m.url)).toBe(404); // direct conversations vanish when blocked

    const m2 = await uploadReady(a, await png('cyan'));
    const grp = (
      await a.client.post('/v1/conversations/group', { title: 'crew', memberIds: [c.id] })
    ).body.id;
    expect(
      (
        await a.client.post(`/v1/conversations/${grp}/messages`, {
          kind: 'media',
          attachmentIds: [m2.id],
        })
      ).status,
    ).toBe(201);
    await new Promise((r) => setTimeout(r, 20));
    const added = await a.client.post(`/v1/conversations/${grp}/members`, { userIds: [late.id] });
    expect(added.status).toBe(200);
    expect(await statusOf(c, m2.url)).toBe(200);
    expect(await statusOf(late, m2.url)).toBe(404); // history before joining stays hidden
  });

  it('public profile media cannot be attached to audience-restricted content (database guard)', async () => {
    const a = await signup(t);
    const pub = await uploadReady(a, await png('lime'), { fields: { purpose: 'public' } });
    expect(
      (await a.client.post('/v1/posts', { body: 'x', visibility: 'friends', mediaIds: [pub.id] }))
        .status,
    ).toBe(422);
    expect(await statusOf(null, pub.url)).toBe(200);
  });
});

describe('resumable uploads', () => {
  const bigPdf = (n: number) => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(n)]);
  const putChunk = (
    u: TestUser,
    id: string,
    n: number,
    data: Buffer,
    headers: Record<string, string> = {},
  ) =>
    raw(t, u, 'PUT', `/v1/media/uploads/${id}/chunks/${n}`, {
      payload: data,
      headers: { 'content-type': 'application/octet-stream', ...headers },
    });

  it('init -> chunks (with a retried chunk and an out-of-order resume) -> complete', async () => {
    const a = await signup(t);
    const data = bigPdf(150_000); // 3 chunks at 64 KiB
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'file',
      size: data.length,
      sha256: sha(data),
      chunkSize: 65536,
      altText: 'report',
    });
    expect(init.status).toBe(201);
    expect(init.body).toMatchObject({
      mode: 'chunked',
      chunkSize: 65536,
      chunkCount: 3,
      status: 'pending',
    });
    const id = init.body.id;
    const chunk = (n: number) => data.subarray(n * 65536, Math.min(data.length, (n + 1) * 65536));

    // Out of order: last chunk first.
    const last = await putChunk(a, id, 2, chunk(2), { 'x-chunk-sha256': sha(chunk(2)) });
    expect(last.body).toMatchObject({
      index: 2,
      duplicate: false,
      receivedCount: 1,
      complete: false,
    });
    // Retry of the same chunk (e.g. response lost): idempotent.
    const retry = await putChunk(a, id, 2, chunk(2));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ index: 2, duplicate: true, receivedCount: 1 });
    // The client resumes: asks what is missing.
    const status = await a.client.get(`/v1/media/uploads/${id}`);
    expect(status.body).toMatchObject({
      received: [2],
      missing: [0, 1],
      status: 'pending',
      expired: false,
    });
    // Completing early fails and lists the gaps.
    const early = await a.client.post(`/v1/media/uploads/${id}/complete`);
    expect(early.status).toBe(422);
    expect(early.body.error.details.missing).toEqual([0, 1]);
    // Not visible/usable while pending.
    expect((await a.client.post('/v1/posts', { body: 'x', mediaIds: [id] })).status).toBe(400);

    expect((await putChunk(a, id, 0, chunk(0))).status).toBe(200);
    expect((await putChunk(a, id, 1, chunk(1))).body).toMatchObject({
      complete: true,
      receivedCount: 3,
    });
    const done = await a.client.post(`/v1/media/uploads/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      id,
      kind: 'file',
      mimeType: 'application/pdf',
      status: 'uploaded',
      sizeBytes: data.length,
      checksumSha256: sha(data),
      altText: 'report',
    });
    // Idempotent complete.
    const again = await a.client.post(`/v1/media/uploads/${id}/complete`);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
    await idle();
    const served = await fetchUrl(a, done.body.url);
    expect(served.status).toBe(200);
    expect(sha(Buffer.from(served.rawBody))).toBe(sha(data));
    // Chunk staging was cleaned up.
    expect(await getMediaRuntime(t.ctx).adapter.stat(`u/${id}/0`)).toBeNull();
    // A finished upload accepts no more chunks.
    expect((await putChunk(a, id, 0, chunk(0))).status).toBe(409);
  });

  it('rejects a wrong final checksum and lets the client start over cleanly', async () => {
    const a = await signup(t);
    const data = bigPdf(70_000);
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'file',
      size: data.length,
      sha256: sha(Buffer.from('something else')),
      chunkSize: 65536,
    });
    const id = init.body.id;
    await putChunk(a, id, 0, data.subarray(0, 65536));
    await putChunk(a, id, 1, data.subarray(65536));
    const done = await a.client.post(`/v1/media/uploads/${id}/complete`);
    expect(done.status).toBe(422);
    expect(done.body.error.message).toMatch(/checksum/i);
    // Chunks were discarded and the upload is still open for a retry.
    expect((await a.client.get(`/v1/media/uploads/${id}`)).body).toMatchObject({
      received: [],
      status: 'pending',
    });
    expect((await sql('SELECT status FROM media WHERE id = $1', [id])).rows[0].status).toBe(
      'pending',
    );
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM media WHERE id = $1 AND status = 'uploaded'`, [
          id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('validates chunks: per-chunk checksum, size, range, ownership, content type', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const data = bigPdf(70_000);
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'file',
      size: data.length,
      sha256: sha(data),
      chunkSize: 65536,
    });
    const id = init.body.id;
    const c0 = data.subarray(0, 65536);
    const corrupted = Buffer.from(c0);
    corrupted[100] ^= 0xff;
    expect((await putChunk(a, id, 0, corrupted, { 'x-chunk-sha256': sha(c0) })).status).toBe(400); // corrupted in transit
    expect((await putChunk(a, id, 0, c0.subarray(0, 1000))).status).toBe(400); // wrong length
    expect((await putChunk(a, id, 5, c0)).status).toBe(400); // out of range
    expect((await putChunk(b, id, 0, c0)).status).toBe(404); // someone else's upload
    expect((await b.client.get(`/v1/media/uploads/${id}`)).status).toBe(404);
    expect((await b.client.post(`/v1/media/uploads/${id}/complete`)).status).toBe(404);
    expect(
      (
        await raw(t, a, 'PUT', `/v1/media/uploads/${id}/chunks/0`, {
          payload: '{"a":1}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(415);
    expect((await new Client(t).put(`/v1/media/uploads/${id}/chunks/0`)).status).toBe(401);
    // the corrected chunk is accepted
    expect((await putChunk(a, id, 0, c0, { 'x-chunk-sha256': sha(c0) })).status).toBe(200);
  });

  it('enforces size limits and kinds at init; direct mode is unavailable on the local adapter', async () => {
    const a = await signup(t);
    const ok = { sha256: sha(Buffer.from('x')) };
    expect(
      (await a.client.post('/v1/media/uploads', { kind: 'image', size: 21 * 1024 * 1024, ...ok }))
        .status,
    ).toBe(413);
    expect(
      (await a.client.post('/v1/media/uploads', { kind: 'video', size: 501 * 1024 * 1024, ...ok }))
        .status,
    ).toBe(413);
    expect(
      (await a.client.post('/v1/media/uploads', { kind: 'video', size: 100, sha256: 'nothex' }))
        .status,
    ).toBe(400);
    expect(
      (await a.client.post('/v1/media/uploads', { kind: 'video', size: 0, ...ok })).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/media/uploads', {
          kind: 'file',
          size: 1000,
          ...ok,
          chunkSize: 100,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/media/uploads', {
          kind: 'video',
          size: 500 * 1024 * 1024,
          chunkSize: 65536,
          ...ok,
        })
      ).status,
    ).toBe(400); // > 4096 chunks
    expect(
      (
        await a.client.post('/v1/media/uploads', {
          kind: 'video',
          size: 1000,
          mode: 'direct',
          contentType: 'video/mp4',
          ...ok,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await a.client.post('/v1/media/uploads', {
          kind: 'file',
          size: 1000,
          purpose: 'public',
          ...ok,
        })
      ).status,
    ).toBe(400);
    expect(
      (await new Client(t).post('/v1/media/uploads', { kind: 'file', size: 1000, ...ok })).status,
    ).toBe(401);
  });

  it('strips GPS from images that arrive in chunks too', async () => {
    const a = await signup(t);
    const src = await sharp(randomBytes(300 * 300 * 3), {
      raw: { width: 300, height: 300, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .withExif({
        IFD0: { Make: 'SecretCam' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '10/1 0/1 0/1' },
      })
      .toBuffer();
    expect(src.length).toBeGreaterThan(65536);
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'image',
      size: src.length,
      sha256: sha(src),
      chunkSize: 65536,
    });
    const n = init.body.chunkCount;
    for (let i = 0; i < n; i++)
      expect(
        (await putChunk(a, init.body.id, i, src.subarray(i * 65536, (i + 1) * 65536))).status,
      ).toBe(200);
    const done = await a.client.post(`/v1/media/uploads/${init.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      metadataStripped: true,
    });
    const stored = Buffer.from((await fetchUrl(a, done.body.url)).rawBody);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from('SecretCam'))).toBe(false);
  });

  it('a declared kind that contradicts the assembled bytes is refused', async () => {
    const a = await signup(t);
    const data = bigPdf(70_000);
    // first chunk is a PDF but the client declared video -> refused on chunk 0
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'video',
      size: data.length,
      sha256: sha(data),
      chunkSize: 65536,
    });
    expect((await putChunk(a, init.body.id, 0, data.subarray(0, 65536))).status).toBe(415);
    expect((await a.client.get(`/v1/media/uploads/${init.body.id}`)).status).toBe(404);
  });

  it('expires abandoned uploads and cleans up their chunks', async () => {
    const a = await signup(t);
    const data = bigPdf(70_000);
    const init = await a.client.post('/v1/media/uploads', {
      kind: 'file',
      size: data.length,
      sha256: sha(data),
      chunkSize: 65536,
    });
    const id = init.body.id;
    await putChunk(a, id, 0, data.subarray(0, 65536));
    const adapter = getMediaRuntime(t.ctx).adapter;
    expect(await adapter.stat(`u/${id}/0`)).not.toBeNull();
    // Not expired yet: cleanup leaves it alone.
    await cleanupExpiredUploads(t.ctx);
    expect((await sql('SELECT 1 FROM media WHERE id = $1', [id])).rowCount).toBe(1);
    await sql(
      `UPDATE media SET upload_state = jsonb_set(upload_state, '{expiresAt}', to_jsonb((now() - interval '1 minute')::text)) WHERE id = $1`,
      [id],
    );
    expect((await a.client.get(`/v1/media/uploads/${id}`)).body.expired).toBe(true);
    expect((await putChunk(a, id, 1, data.subarray(65536))).status).toBe(422);
    expect((await a.client.post(`/v1/media/uploads/${id}/complete`)).status).toBe(422);
    expect(await cleanupExpiredUploads(t.ctx)).toBeGreaterThanOrEqual(1);
    expect((await sql('SELECT 1 FROM media WHERE id = $1', [id])).rowCount).toBe(0);
    expect(await adapter.stat(`u/${id}/0`)).toBeNull();
  });

  it('direct-to-storage flow verifies what landed in the bucket (adapter with presigning)', async () => {
    // A local adapter that pretends to presign: the "client" then writes straight into storage, bypassing the API.
    class FakePresignAdapter extends LocalStorageAdapter {
      presignPut = async (
        key: string,
        o: { contentType: string; size: number; sha256Hex: string; expiresInSec: number },
      ) => ({
        url: `https://bucket.test/${key}?sig=fake`,
        method: 'PUT' as const,
        headers: {
          'content-type': o.contentType,
          'content-length': String(o.size),
          'x-amz-checksum-sha256': o.sha256Hex,
        },
        expiresAt: new Date(Date.now() + o.expiresInSec * 1000),
      });
    }
    const original = getMediaRuntime(t.ctx);
    const fake = new FakePresignAdapter(dir);
    overrideMediaRuntime(t.ctx, { adapter: fake });
    try {
      const a = await signup(t);
      const video = mp4();
      expect(
        (
          await a.client.post('/v1/media/uploads', {
            kind: 'image',
            size: 1000,
            sha256: sha(video),
            mode: 'direct',
            contentType: 'image/png',
          })
        ).status,
      ).toBe(400); // images must pass through the API
      expect(
        (
          await a.client.post('/v1/media/uploads', {
            kind: 'video',
            size: video.length,
            sha256: sha(video),
            mode: 'direct',
            contentType: 'video/x-matroska',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await a.client.post('/v1/media/uploads', {
            kind: 'video',
            size: video.length,
            sha256: sha(video),
            mode: 'direct',
            contentType: 'audio/mpeg',
          })
        ).status,
      ).toBe(400);
      const init = await a.client.post('/v1/media/uploads', {
        kind: 'video',
        size: video.length,
        sha256: sha(video),
        mode: 'direct',
        contentType: 'video/mp4',
      });
      expect(init.status).toBe(201);
      expect(init.body.upload).toMatchObject({
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
      });
      const key = new URL(init.body.upload.url).pathname.slice(1);
      expect(key).toMatch(/^m\/[0-9a-f]{2}\/[0-9a-f]{32}\.mp4$/);
      // Not uploaded yet.
      expect((await a.client.post(`/v1/media/uploads/${init.body.id}/complete`)).status).toBe(422);
      await fake.put(key, video, { contentType: 'video/mp4' }); // the client PUTs to the bucket
      const done = await a.client.post(`/v1/media/uploads/${init.body.id}/complete`);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({
        kind: 'video',
        mimeType: 'video/mp4',
        status: 'uploaded',
        sizeBytes: video.length,
      });

      // A client that uploads something else than it declared is caught: wrong type...
      const evil = exe();
      const init2 = await a.client.post('/v1/media/uploads', {
        kind: 'video',
        size: evil.length,
        sha256: sha(evil),
        mode: 'direct',
        contentType: 'video/mp4',
      });
      await fake.put(new URL(init2.body.upload.url).pathname.slice(1), evil, {
        contentType: 'video/mp4',
      });
      expect((await a.client.post(`/v1/media/uploads/${init2.body.id}/complete`)).status).toBe(415);
      expect(await fake.stat(new URL(init2.body.upload.url).pathname.slice(1))).toBeNull(); // and the object is deleted
      // ...or wrong size.
      const init3 = await a.client.post('/v1/media/uploads', {
        kind: 'video',
        size: video.length + 5,
        sha256: sha(video),
        mode: 'direct',
        contentType: 'video/mp4',
      });
      await fake.put(new URL(init3.body.upload.url).pathname.slice(1), video, {
        contentType: 'video/mp4',
      });
      expect((await a.client.post(`/v1/media/uploads/${init3.body.id}/complete`)).status).toBe(422);
      await idle();
    } finally {
      overrideMediaRuntime(t.ctx, { adapter: original.adapter });
    }
  });
});

describe('processing pipeline', () => {
  it.skipIf(!hasFfmpeg)(
    'probes video, creates a poster and a 720p mp4, and serves them',
    async () => {
      const a = await signup(t);
      const m = await uploadReady(a, mp4(), { filename: 'clip.mp4', contentType: 'video/mp4' });
      expect(m).toMatchObject({
        kind: 'video',
        mimeType: 'video/mp4',
        status: 'ready',
        width: 64,
        height: 48,
        processing: 'variants',
      });
      expect(m.durationMs).toBeGreaterThan(800);
      expect(m.durationMs).toBeLessThan(1500);
      const names = m.variants.map((v: any) => v.name).sort();
      expect(names).toEqual(['720p', 'poster']);
      const mp4v = m.variants.find((v: any) => v.name === '720p');
      expect(mp4v).toMatchObject({ mimeType: 'video/mp4' });
      expect(mp4v.height).toBeLessThanOrEqual(48); // never upscaled
      const served = await fetchUrl(a, mp4v.url);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('video/mp4');
      expect((await fetchUrl(a, mp4v.url, { range: 'bytes=0-15' })).status).toBe(206);
      expect(
        (await fetchUrl(a, m.variants.find((v: any) => v.name === 'poster').url)).headers[
          'content-type'
        ],
      ).toBe('image/jpeg');
    },
  );

  it.skipIf(!hasFfmpeg)('probes audio (metadata only, no derived files)', async () => {
    const a = await signup(t);
    const m = await uploadReady(a, wav(), { filename: 'voice.mp3', contentType: 'audio/mpeg' });
    expect(m).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/wav',
      status: 'ready',
      processing: 'metadata',
      variants: [],
    });
    expect(m.durationMs).toBeGreaterThan(900);
  });

  it.skipIf(!hasFfmpeg)(
    'marks a file with video magic bytes but no streams as failed and stops serving it',
    async () => {
      const a = await signup(t);
      const m = await uploadOk(a, ftypOnly('isom'), {
        filename: 'fake.mp4',
        contentType: 'video/mp4',
      });
      expect(m.status).toBe('uploaded');
      await idle();
      const after = (await a.client.get(`/v1/media/${m.id}`)).body;
      expect(after).toMatchObject({ status: 'failed', url: null });
      expect(after.processingError).toBeTruthy();
      expect(await statusOf(a, m.url)).toBe(404);
      expect((await a.client.post('/v1/posts', { body: 'x', mediaIds: [m.id] })).status).toBe(400); // failed media cannot be attached
    },
  );

  it('without ffmpeg the media is ready as-is and says so (processing: passthrough)', async () => {
    const original = getMediaRuntime(t.ctx);
    overrideMediaRuntime(t.ctx, {
      processor: new DefaultMediaProcessor({
        ffmpegPath: '/nonexistent/ffmpeg',
        ffprobePath: '/nonexistent/ffprobe',
      }),
    });
    try {
      const a = await signup(t);
      const m = await uploadReady(a, mp4(), { filename: 'clip.mp4', contentType: 'video/mp4' });
      expect(m).toMatchObject({
        kind: 'video',
        status: 'ready',
        processing: 'passthrough',
        variants: [],
        durationMs: null,
      });
      expect(await statusOf(a, m.url)).toBe(200);
      const w = await uploadReady(a, wav());
      expect(w).toMatchObject({ status: 'ready', processing: 'passthrough' });
    } finally {
      overrideMediaRuntime(t.ctx, { processor: original.processor });
    }
  });

  it('follows the status lifecycle uploaded -> processing -> ready and never overrides blocked', async () => {
    const a = await signup(t);
    const rt = getMediaRuntime(t.ctx);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    overrideMediaRuntime(t.ctx, {
      processor: {
        process: async (job) => {
          seen.push(
            (await sql('SELECT status FROM media WHERE id = $1', [job.mediaId])).rows[0].status,
          );
          await gate;
          return { variants: [], processing: 'passthrough' };
        },
      },
    });
    try {
      const m = await uploadOk(a, pdf());
      await new Promise((r) => setTimeout(r, 100));
      expect((await a.client.get(`/v1/media/${m.id}`)).body.status).toBe('processing');
      await sql(`UPDATE media SET status = 'blocked' WHERE id = $1`, [m.id]); // moderation acts mid-processing
      release();
      await idle();
      expect(seen).toEqual(['processing']);
      expect((await sql('SELECT status FROM media WHERE id = $1', [m.id])).rows[0].status).toBe(
        'blocked',
      );
    } finally {
      overrideMediaRuntime(t.ctx, { processor: rt.processor });
    }
  });
});

describe('delete, block, purge', () => {
  it('owner delete soft-deletes, removes bytes and variants, and clears profile images', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const m = await uploadReady(a, await png('coral'));
    const adapter = getMediaRuntime(t.ctx).adapter;
    const key = pathOf(m.url).replace('/media/', '');
    const thumbKey = pathOf(m.variants[0].url).replace('/media/', '');
    expect(await adapter.stat(key)).not.toBeNull();
    expect((await b.client.del(`/v1/media/${m.id}`)).status).toBe(404);
    expect((await new Client(t).del(`/v1/media/${m.id}`)).status).toBe(401);
    expect((await a.client.del(`/v1/media/${m.id}`)).status).toBe(204);
    expect(await adapter.stat(key)).toBeNull();
    expect(await adapter.stat(thumbKey)).toBeNull();
    expect(
      (await sql('SELECT deleted_at, purged_at FROM media WHERE id = $1', [m.id])).rows[0],
    ).toMatchObject({ deleted_at: expect.any(Date), purged_at: expect.any(Date) });
    expect(await statusOf(a, m.url)).toBe(404);
    expect((await a.client.get(`/v1/media/${m.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/media/${m.id}`)).status).toBe(404);
  });

  it('a deleted post attachment disappears from the post view', async () => {
    const a = await signup(t);
    const m = await uploadReady(a, await png('gold'));
    const p = await a.client.post('/v1/posts', {
      body: 'pic',
      visibility: 'public',
      mediaIds: [m.id],
    });
    expect((await a.client.del(`/v1/media/${m.id}`)).status).toBe(204);
    expect((await a.client.get(`/v1/posts/${p.body.id}`)).body.media).toEqual([]);
  });

  it('moderators can block media (never served again, even to the owner) and unblock it', async () => {
    const owner = await signup(t);
    const mod = await signup(t);
    const regular = await signup(t);
    const viewer = await signup(t);
    await makeStaff(t, mod, 'moderator');
    const m = await uploadReady(owner, await png('salmon'));
    const p = await owner.client.post('/v1/posts', {
      body: 'x',
      visibility: 'public',
      mediaIds: [m.id],
    });
    expect(p.status).toBe(201);
    expect(await statusOf(viewer, m.url)).toBe(200);
    expect(
      (await regular.client.post(`/v1/admin/media/${m.id}/block`, { reason: 'because' })).status,
    ).toBe(403);
    expect(
      (await new Client(t).post(`/v1/admin/media/${m.id}/block`, { reason: 'because' })).status,
    ).toBe(401);
    expect(
      (await mod.client.post(`/v1/admin/media/${m.id}/block`, { reason: 'csam-hash-match' }))
        .status,
    ).toBe(204);
    for (const who of [owner, viewer, null]) expect(await statusOf(who, m.url)).toBe(404);
    expect(await statusOf(owner, m.variants[0].url)).toBe(404);
    expect(
      (
        await sql(`SELECT 1 FROM audit_logs WHERE action = 'media.blocked' AND target_id = $1`, [
          m.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await mod.client.del(`/v1/admin/media/${m.id}/block`)).status).toBe(204);
    await idle();
    expect(await statusOf(viewer, m.url)).toBe(200);
  });

  it('purgeDeletedMedia sweeps objects of media soft-deleted elsewhere, including the account deletion hook', async () => {
    const a = await signup(t);
    const m = await uploadReady(a, await png('khaki'));
    const adapter = getMediaRuntime(t.ctx).adapter;
    const key = pathOf(m.url).replace('/media/', '');
    await withTransaction(t.ctx.db, async (tx) => {
      for (const hook of getDeletionHooks()) await hook(t.ctx, tx, a.id);
    });
    expect(
      (await sql('SELECT deleted_at, purged_at FROM media WHERE id = $1', [m.id])).rows[0],
    ).toMatchObject({ deleted_at: expect.any(Date), purged_at: null });
    expect(await adapter.stat(key)).not.toBeNull(); // hook is transactional; bytes go in the sweep
    expect(await purgeDeletedMedia(t.ctx)).toBeGreaterThanOrEqual(1);
    expect(await adapter.stat(key)).toBeNull();
    expect(
      (await sql('SELECT purged_at FROM media WHERE id = $1', [m.id])).rows[0].purged_at,
    ).toBeInstanceOf(Date);
  });
});

describe('captions', () => {
  const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n';
  it.skipIf(!hasFfmpeg)(
    'accepts validated WebVTT for video, replaces per language, and serves it',
    async () => {
      const a = await signup(t);
      const b = await signup(t);
      const m = await uploadReady(a, mp4());
      const put = (lang: string, body: string, q = '') =>
        raw(t, a, 'PUT', `/v1/media/${m.id}/captions/${lang}${q}`, {
          payload: body,
          headers: { 'content-type': 'text/vtt' },
        });
      const r = await put('en', VTT, '?label=English');
      expect(r.status).toBe(200);
      expect(r.body.captions).toEqual([
        expect.objectContaining({ lang: 'en', label: 'English', kind: 'captions' }),
      ]);
      const url = r.body.captions[0].url;
      const served = await fetchUrl(a, url);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(served.rawBody).toString()).toContain('Hello');
      // A second language, and replacing the first.
      await put('es', VTT.replace('Hello', 'Hola'));
      const rep = await put('en', VTT.replace('Hello', 'Hi again'));
      expect(rep.body.captions.map((c: any) => c.lang).sort()).toEqual(['en', 'es']);
      expect(await statusOf(a, url)).toBe(404); // old file for "en" is gone
      // JSON alternative body
      const j = await a.client.put(`/v1/media/${m.id}/captions/fr`, {
        content: VTT,
        kind: 'subtitles',
      });
      expect(j.status).toBe(200);
      expect(j.body.captions.find((c: any) => c.lang === 'fr').kind).toBe('subtitles');
      // Invalid content / language / owner
      expect((await put('de', 'not vtt at all')).status).toBe(422);
      expect((await put('de', 'WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nbackwards')).status).toBe(
        422,
      );
      expect((await put('not_a_lang', VTT)).status).toBe(400);
      expect((await b.client.put(`/v1/media/${m.id}/captions/de`, { content: VTT })).status).toBe(
        404,
      );
      // Captions follow the media's audience: attached to a private post -> stranger cannot read them.
      const en = (await a.client.get(`/v1/media/${m.id}`)).body.captions.find(
        (c: any) => c.lang === 'en',
      );
      expect(await statusOf(b, en.url)).toBe(404);
      // Delete a track
      expect((await a.client.del(`/v1/media/${m.id}/captions/es`)).status).toBe(204);
      expect((await a.client.del(`/v1/media/${m.id}/captions/es`)).status).toBe(404);
    },
  );

  it('is only for video/audio', async () => {
    const a = await signup(t);
    const img = await uploadReady(a, await png());
    expect((await a.client.put(`/v1/media/${img.id}/captions/en`, { content: VTT })).status).toBe(
      400,
    );
  });
});

describe('profile avatar and cover', () => {
  it('sets avatar/cover from an owned ready image and serves it publicly', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const av = await uploadReady(a, await png('red', 32), {
      fields: { purpose: 'public', altText: 'me' },
    });
    const set = await a.client.put('/v1/profile/avatar', { mediaId: av.id });
    expect(set.status).toBe(200);
    expect(set.body.avatarUrl).toBe(av.url);
    const prof = await new Client(t).get(`/v1/users/${a.username}`);
    expect(prof.body.avatarUrl).toBe(av.url);
    const r = await fetchUrl(null, av.url);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('immutable');

    // A default-purpose, unattached image is promoted to public when chosen as cover (owner's explicit act).
    const cv = await uploadReady(a, await png('blue', 32));
    expect(await statusOf(null, cv.url)).toBe(404);
    expect((await a.client.put('/v1/profile/cover', { mediaId: cv.id })).body.coverUrl).toBe(
      cv.url,
    );
    expect(await statusOf(null, cv.url)).toBe(200);

    // Replacing the avatar retires the old media.
    const av2 = await uploadReady(a, await png('green', 32), { fields: { purpose: 'public' } });
    expect((await a.client.put('/v1/profile/avatar', { mediaId: av2.id })).status).toBe(200);
    expect(
      (await sql('SELECT deleted_at FROM media WHERE id = $1', [av.id])).rows[0].deleted_at,
    ).toBeInstanceOf(Date);
    await purgeDeletedMedia(t.ctx);
    expect(await statusOf(null, av.url)).toBe(404);

    // Removing clears the URL.
    expect((await a.client.del('/v1/profile/avatar')).status).toBe(204);
    expect((await new Client(t).get(`/v1/users/${a.username}`)).body.avatarUrl).toBeNull();
    // Deleting the media that is the cover also clears the profile.
    expect((await a.client.del(`/v1/media/${cv.id}`)).status).toBe(204);
    expect((await new Client(t).get(`/v1/users/${a.username}`)).body.coverUrl).toBeNull();
    expect(b.id).toBeTruthy();
  });

  it("refuses other people's media, non-images, unfinished media and attached media", async () => {
    const a = await signup(t);
    const b = await signup(t);
    const theirs = await uploadReady(b, await png('red'), { fields: { purpose: 'public' } });
    expect((await a.client.put('/v1/profile/avatar', { mediaId: theirs.id })).status).toBe(400);
    const doc = await uploadReady(a, pdf());
    expect((await a.client.put('/v1/profile/avatar', { mediaId: doc.id })).status).toBe(400);
    expect(
      (
        await a.client.put('/v1/profile/avatar', {
          mediaId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(400);
    expect((await a.client.put('/v1/profile/avatar', { mediaId: 'nope' })).status).toBe(400);
    const pending = await uploadOk(a, await png('gray'));
    await sql(`UPDATE media SET status = 'processing' WHERE id = $1`, [pending.id]);
    expect((await a.client.put('/v1/profile/avatar', { mediaId: pending.id })).status).toBe(409);
    await sql(`UPDATE media SET status = 'ready' WHERE id = $1`, [pending.id]);
    // Attached to a friends-only post: must not silently become world-readable.
    const attached = await uploadReady(a, await png('silver'));
    expect(
      (
        await a.client.post('/v1/posts', {
          body: 'x',
          visibility: 'friends',
          mediaIds: [attached.id],
        })
      ).status,
    ).toBe(201);
    expect((await a.client.put('/v1/profile/cover', { mediaId: attached.id })).status).toBe(400);
    expect(await statusOf(null, attached.url)).toBe(404);
    expect((await new Client(t).put('/v1/profile/avatar', { mediaId: theirs.id })).status).toBe(
      401,
    );
  });
});
