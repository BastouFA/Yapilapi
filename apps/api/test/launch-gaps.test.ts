import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTransport } from 'nodemailer';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import type { BuiltApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { smtpEmailSender, type MailTransport } from '../src/lib/email.ts';
import { detectMedia, toWebFormat } from '../src/lib/media-formats.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { maybeRunRetention, RETENTION, runRetention } from '../src/lib/retention.ts';
import { track } from '../src/lib/services.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
const recordings = mkdtempSync(path.join(tmpdir(), 'ypl-gaps-rec-'));
const work = mkdtempSync(path.join(tmpdir(), 'ypl-gaps-'));
const UPLOADS = '/tmp/ypl-test-uploads';

beforeAll(async () => {
  t = await testApp({ LIVE_RECORDINGS_DIR: recordings });
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

// ─── Fixtures ────────────────────────────────────────────────────────────

/** A JPEG with camera and GPS EXIF, like a phone photo. */
async function gpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Pocket 9' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 51/1 24/1', GPSLongitudeRef: 'E', GPSLongitude: '2/1 17/1 40/1' },
    })
    .toBuffer();
}

/** Whether EXIF data points at a GPS block (tag 0x8825, either byte order). */
function hasGps(exif: Buffer | undefined): boolean {
  if (!exif) return false;
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

function ffmpeg(args: string[]) {
  execFileSync(ffmpegPath as unknown as string, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** What ffmpeg prints about a file (its tags included). */
function probeText(file: string): string {
  return spawnSync(ffmpegPath as unknown as string, ['-hide_banner', '-i', file]).stderr.toString();
}

/** A short QuickTime video tagged with where it was filmed, as iPhones do. */
function geoVideo(): Buffer {
  const out = path.join(work, `geo-${randomUUID()}.mov`);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=2:size=64x48:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=2',
    '-shortest',
    '-metadata',
    'location=+48.8584+002.2945/',
    '-metadata',
    'com.apple.quicktime.location.ISO6709=+48.8584+002.2945/',
    '-movflags',
    'use_metadata_tags',
    out,
  ]);
  return readFileSync(out);
}

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = `----ypl${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(
  u: TestUser,
  name: string,
  data: Buffer,
  type: string,
): Promise<{ id: string; storage_key: string; mime: string; url: string; kind: string }> {
  const body = multipart({ name, type, data });
  const res = await t.app.inject({ method: 'POST', url: '/v1/media', headers: { ...body.headers, authorization: `Bearer ${u.token}` }, payload: body.payload });
  expect(res.statusCode).toBe(201);
  const row = (await db().query(`SELECT id, storage_key, mime, url, kind FROM media WHERE id = $1`, [res.json().media.id])).rows[0];
  // Tests drive processing themselves.
  await db().query(`DELETE FROM jobs WHERE payload->>'mediaId' = $1`, [row.id]);
  return row;
}

// ─── 2. Location metadata ────────────────────────────────────────────────

describe('location metadata', () => {
  it('stores photos without their EXIF, GPS included', async () => {
    const u = await signUp(t.app);
    const jpeg = await gpsJpeg();
    const before = await sharp(jpeg).metadata();
    expect(hasGps(before.exif)).toBe(true);
    expect(jpeg.includes(Buffer.from('TestCam'))).toBe(true);

    const m = await upload(u, 'IMG_2041.JPG', jpeg, 'image/jpeg');
    const stored = await t.ctx.storage.read(m.storage_key);
    const after = await sharp(stored).metadata();
    expect(after.exif).toBeUndefined();
    expect(stored.includes(Buffer.from('TestCam'))).toBe(false);
    expect([after.width, after.height]).toEqual([40, 30]);

    // The sizes made from it carry nothing either.
    await mediaJobHandlers({ db: db(), storage: t.ctx.storage })['media.process']({ mediaId: m.id });
    const base = m.storage_key.replace(/\.[^.]+$/, '');
    expect((await sharp(await t.ctx.storage.read(`${base}_thumb.webp`)).metadata()).exif).toBeUndefined();
  });

  it('strips them from resumable uploads too', async () => {
    const u = await signUp(t.app);
    const jpeg = await gpsJpeg();
    const s = await as(t.app, u).post('/v1/uploads', { filename: 'IMG_2042.JPG', mime: 'image/jpeg', size: jpeg.length });
    expect(s.status).toBe(201);
    const chunk = await t.app.inject({
      method: 'PUT',
      url: `/v1/uploads/${s.body.uploadId}/chunks/0`,
      headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/octet-stream' },
      payload: jpeg,
    });
    expect(chunk.statusCode).toBe(200);
    const done = await as(t.app, u).post(`/v1/uploads/${s.body.uploadId}/complete`, {});
    expect(done.status).toBe(201);
    const key = (await db().query(`SELECT storage_key FROM media WHERE id = $1`, [done.body.media.id])).rows[0].storage_key;
    expect((await sharp(await t.ctx.storage.read(key)).metadata()).exif).toBeUndefined();
  });

  it('strips PNG and WebP tags, and keeps untagged photos byte for byte', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0a0' } })
      .png()
      .withExif({ IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '1/1 17/1 0/1' } })
      .toBuffer();
    expect((await sharp(png).metadata()).exif).toBeDefined();
    const cleanPng = await toWebFormat(png, detectMedia(png)!);
    expect(cleanPng.mime).toBe('image/png');
    expect((await sharp(cleanPng.buf).metadata()).exif).toBeUndefined();

    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00a' } })
      .webp()
      .withExif({ IFD0: { Make: 'TestCam' } })
      .toBuffer();
    const cleanWebp = await toWebFormat(webp, detectMedia(webp)!);
    expect((await sharp(cleanWebp.buf).metadata()).exif).toBeUndefined();

    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aaa' } })
      .jpeg()
      .toBuffer();
    expect((await toWebFormat(plain, detectMedia(plain)!)).buf.equals(plain)).toBe(true);
  });

  it('removes where a video was filmed from the stored file and the web MP4', async () => {
    const u = await signUp(t.app);
    const mov = geoVideo();
    const original = path.join(work, 'original.mov');
    writeFileSync(original, mov);
    expect(probeText(original)).toMatch(/48\.8584/);

    const m = await upload(u, 'IMG_2043.MOV', mov, 'video/quicktime');
    const stored = path.join(UPLOADS, m.storage_key);
    expect(existsSync(stored)).toBe(true);
    expect(probeText(stored)).not.toMatch(/48\.8584|location/i);
    // Still a playable video with its audio.
    expect(probeText(stored)).toMatch(/Video:/);
    expect(probeText(stored)).toMatch(/Audio:/);

    await mediaJobHandlers({ db: db(), storage: t.ctx.storage })['media.process']({ mediaId: m.id });
    const base = m.storage_key.replace(/\.[^.]+$/, '');
    expect(probeText(path.join(UPLOADS, `${base}_web.mp4`))).not.toMatch(/48\.8584|location/i);
    expect(existsSync(path.join(UPLOADS, `${base}_hls`, 'index.m3u8'))).toBe(true);
  });
});

// ─── 3. Email ────────────────────────────────────────────────────────────

describe('email delivery', () => {
  it('sends through SMTP with nodemailer', async () => {
    // nodemailer's stream transport builds the real message without a server.
    const sent: string[] = [];
    const stream = createTransport({ streamTransport: true, buffer: true });
    const transport: MailTransport = {
      async sendMail(msg) {
        const info = (await stream.sendMail(msg)) as { message: Buffer };
        sent.push(info.message.toString());
        return info;
      },
    };
    const sender = smtpEmailSender({ url: 'smtp://localhost:2525', from: 'YAPILAPI <no-reply@yapilapi.test>', transport });
    expect(sender.name).toBe('smtp');
    await sender.send({ to: 'ada@example.test', subject: 'Hello', text: 'A link: https://example.test/x' });
    expect(sent[0]).toMatch(/^To: ada@example.test/m);
    expect(sent[0]).toMatch(/^From: YAPILAPI <no-reply@yapilapi.test>/m);
    expect(sent[0]).toMatch(/^Subject: Hello/m);
    expect(sent[0]).toContain('https://example.test/x');
  });

  it('needs SMTP in production, and an SMTP_URL with it', () => {
    const prod = {
      DATABASE_URL: 'postgres://x',
      APP_ENV: 'production',
      PAYMENTS_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk',
      STRIPE_WEBHOOK_SECRET: 'wh',
      STRIPE_PUBLISHABLE_KEY: 'pk',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      COOKIE_SECURE: 'true',
    };
    expect(() => loadConfig(prod)).toThrow(/EMAIL_TRANSPORT=smtp/);
    expect(() => loadConfig({ ...prod, EMAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_URL/);
    const smtp = { ...prod, EMAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtps://u:p@smtp.example.test:465' };
    // Event tickets are signed with a real secret too.
    expect(() => loadConfig(smtp)).toThrow(/TICKET_TOKEN_SECRET/);
    const tickets = { ...smtp, TICKET_TOKEN_SECRET: 'x'.repeat(32) };
    // The placeholder sender would be refused by every relay.
    expect(() => loadConfig(tickets)).toThrow(/EMAIL_FROM/);
    const sender = { ...tickets, EMAIL_FROM: 'YAPILAPI <hello@yapilapi.test>' };
    // Mini App tokens are signed with the live hook secret, so the dev one is refused.
    expect(() => loadConfig(sender)).toThrow(/LIVE_HOOK_SECRET/);
    expect(() => loadConfig({ ...sender, LIVE_HOOK_SECRET: 'dev-live-hook-secret' })).toThrow(/LIVE_HOOK_SECRET/);
    const ready = { ...sender, LIVE_HOOK_SECRET: 'h'.repeat(32) };
    expect(loadConfig(ready).EMAIL_TRANSPORT).toBe('smtp');
    // Storage keys left at the development values never reach a real bucket.
    expect(() => loadConfig({ ...ready, STORAGE_DRIVER: 's3' })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(loadConfig({ ...ready, STORAGE_DRIVER: 's3', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' }).STORAGE_DRIVER).toBe('s3');
    // Browser push needs a real contact address.
    const vapid = { ...ready, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    expect(() => loadConfig(vapid)).toThrow(/VAPID_SUBJECT/);
    expect(loadConfig({ ...vapid, VAPID_SUBJECT: 'mailto:support@yapilapi.test' }).VAPID_SUBJECT).toBe('mailto:support@yapilapi.test');
  });

  it('treats blank settings as unset and trims pasted values', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgres://x',
      EMAIL_FROM: '',
      MEDIA_MODERATION_PROVIDER: '',
      TRUST_PROXY: ' ',
      STRIPE_SECRET_KEY: ' sk_test_abc\n',
    });
    expect(cfg.EMAIL_FROM).toBe('YAPILAPI <no-reply@yapilapi.local>');
    expect(cfg.MEDIA_MODERATION_PROVIDER).toBe('dev');
    expect(cfg.TRUST_PROXY).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    expect(cfg.STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL is required/);
  });

  it('checks optional services are set up in full', () => {
    const base = { DATABASE_URL: 'postgres://x' };
    expect(() => loadConfig({ ...base, TRANSCRIBE_PROVIDER: 'openai-compatible' })).toThrow(/TRANSCRIBE_API_URL/);
    expect(loadConfig({ ...base, TRANSCRIBE_PROVIDER: 'openai-compatible', TRANSCRIBE_API_URL: 'https://stt.example.test/v1' }).TRANSCRIBE_PROVIDER).toBe(
      'openai-compatible',
    );
    expect(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: 'pub' })).toThrow(/VAPID_PRIVATE_KEY/);
  });

  it('sends verification, password reset and security emails through the configured transport', async () => {
    const mails: { to: string; subject: string; text: string }[] = [];
    let failing = false;
    const smtp = await testApp(
      {
        EMAIL_TRANSPORT: 'smtp',
        SMTP_URL: 'smtp://localhost:2525',
        EMAIL_FROM: 'YAPILAPI <no-reply@yapilapi.test>',
        WEB_ORIGIN: 'https://app.example.test,https://other.example.test',
      },
      {
        mailTransport: {
          async sendMail(m) {
            if (failing) throw new Error('connection refused');
            mails.push({ to: String(m.to), subject: String(m.subject), text: String(m.text) });
            return {};
          },
        },
      },
    );
    try {
      expect(smtp.ctx.email.name).toBe('smtp');
      const u = await signUp(smtp.app);
      const verify = mails.find((m) => m.to === u.email && /Confirm your email/.test(m.subject));
      expect(verify?.text).toMatch(/^Confirm your email: https:\/\/app\.example\.test\/verify-email\?token=/);

      expect((await as(smtp.app, null).post('/v1/auth/password/forgot', { email: u.email })).status).toBe(200);
      const reset = mails.find((m) => m.to === u.email && /Reset your YAPILAPI password/.test(m.subject));
      expect(reset?.text).toContain('https://app.example.test/reset-password?token=');

      // A security notice when the password changes (sent in the background).
      expect((await as(smtp.app, u).post('/v1/auth/password/change', { currentPassword: u.password, newPassword: 'another-good-password' })).status).toBe(200);
      expect(await until(() => mails.some((m) => m.to === u.email && m.subject === 'Your YAPILAPI password was changed'))).toBe(true);
      expect(mails.find((m) => m.subject === 'Your YAPILAPI password was changed')!.text).toContain('https://app.example.test/forgot-password');

      // A mail server that is down doesn't break sign-up or the reset form.
      failing = true;
      const later = await signUp(smtp.app);
      expect(later.id).toBeTruthy();
      expect((await as(smtp.app, null).post('/v1/auth/password/forgot', { email: later.email })).status).toBe(200);
    } finally {
      await smtp.close();
    }
  });

  it('writes emails to the log outside production', async () => {
    expect(t.ctx.email.name).toBe('log');
    const u = await signUp(t.app);
    const outbox = (await t.app.inject({ url: '/dev/outbox' })).json().items as { to: string }[];
    expect(outbox.some((m) => m.to === u.email)).toBe(true);
  });
});

// ─── 4. Privacy switches ─────────────────────────────────────────────────

describe('analytics and personalization consents', () => {
  const events = async (id: string) => Number((await db().query(`SELECT count(*) FROM analytics_events WHERE user_id = $1`, [id])).rows[0].count);

  it('records no analytics events for someone who turned analytics off', async () => {
    const u = await signUp(t.app);
    await track(db(), u.id, 'probe_event');
    expect(await events(u.id)).toBeGreaterThan(0);

    expect((await as(t.app, u).put('/v1/me/consents', { purpose: 'analytics', granted: false })).status).toBe(200);
    // What was recorded before is no longer linked to them.
    expect(await events(u.id)).toBe(0);
    await track(db(), u.id, 'probe_event');
    await as(t.app, u).post('/v1/posts', { body: 'Posting records an event for others' });
    expect(await events(u.id)).toBe(0);

    await as(t.app, u).put('/v1/me/consents', { purpose: 'analytics', granted: true });
    await track(db(), u.id, 'probe_event');
    expect(await events(u.id)).toBe(1);
  });

  it('ranks For you without personal signals when personalization is off', async () => {
    const viewer = await signUp(t.app);
    const friend = await signUp(t.app);
    await as(t.app, viewer).post(`/v1/users/${friend.id}/follow`);
    const post = (await as(t.app, friend).post('/v1/posts', { body: 'Fresh from someone you follow', visibility: 'public' })).body.post;

    const on = await as(t.app, viewer).get('/v1/feed?mode=for_you&limit=20');
    expect(on.body.items.find((p: { id: string }) => p.id === post.id)?.reason).toMatch(/^You follow /);

    await as(t.app, viewer).put('/v1/me/consents', { purpose: 'personalization', granted: false });
    const off = await as(t.app, viewer).get('/v1/feed?mode=for_you&limit=20');
    expect(off.status).toBe(200);
    expect(off.body.items.find((p: { id: string }) => p.id === post.id)?.reason).toBe('Popular with people on YAPILAPI right now');
    for (const p of off.body.items as { reason: string }[]) expect(p.reason).toMatch(/^(Your post|Popular with people on YAPILAPI right now|Popular in )/);
    const why = await as(t.app, viewer).get(`/v1/posts/${post.id}/why`);
    expect(why.body.reasons[0]).toMatch(/Personalization is off/);
    // Reels still load.
    expect((await as(t.app, viewer).get('/v1/reels')).status).toBe(200);
  });

  it('suggests people without interests or follows when personalization is off', async () => {
    const topic = `gapstopic${Date.now().toString(36)}`;
    const viewer = await signUp(t.app);
    const alike = await signUp(t.app);
    for (const u of [viewer, alike]) await as(t.app, u).put('/v1/me/interests', { topics: [topic] });
    const on = await as(t.app, viewer).get('/v1/me/suggestions?limit=30');
    expect(on.body.items.find((s: { user: { id: string } }) => s.user.id === alike.id)).toMatchObject({
      reason: '1 shared interest',
      reasonCode: 'shared_interests',
      reasonParams: { count: 1 },
    });
    // Someone a person you follow follows: counted, with the English for older apps.
    const middle = await signUp(t.app);
    const friendOfFriend = await signUp(t.app);
    await as(t.app, viewer).post(`/v1/users/${middle.id}/follow`);
    await as(t.app, middle).post(`/v1/users/${friendOfFriend.id}/follow`);
    const mutual = (await as(t.app, viewer).get('/v1/me/suggestions?limit=30')).body.items.find(
      (s: { user: { id: string } }) => s.user.id === friendOfFriend.id,
    );
    expect(mutual).toMatchObject({ reason: 'Followed by 1 person you follow', reasonCode: 'mutual', reasonParams: { count: 1 } });

    await as(t.app, viewer).put('/v1/me/consents', { purpose: 'personalization', granted: false });
    const off = await as(t.app, viewer).get('/v1/me/suggestions?limit=30');
    for (const s of off.body.items) expect(s).toMatchObject({ reason: 'Popular on YAPILAPI', reasonCode: 'popular', reasonParams: {} });
  });
});

// ─── 5. Retention ────────────────────────────────────────────────────────

describe('data retention', () => {
  const count = async (sql: string, params: unknown[]) => Number((await db().query(sql, params)).rows[0].count);

  it('deletes what is past its period and keeps what is not', async () => {
    const u = await signUp(t.app);
    const ago = (d: number) => new Date(Date.now() - d * 86400_000);
    // Sessions: one that ended long ago, and the live one.
    await db().query(`INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES ($1, $2, $3, $3), ($1, $4, $5, NULL)`, [
      u.id,
      `old-${randomUUID()}`,
      ago(RETENTION.endedSessionsDays + 5),
      `recent-${randomUUID()}`,
      ago(RETENTION.endedSessionsDays - 5),
    ]);
    await db().query(`INSERT INTO security_events (user_id, type, created_at) VALUES ($1, 'login', $2), ($1, 'login', now())`, [
      u.id,
      ago(RETENTION.securityEventsDays + 1),
    ]);
    await db().query(`INSERT INTO analytics_events (user_id, name, created_at) VALUES ($1, 'old', $2), ($1, 'new', $3)`, [
      u.id,
      ago(RETENTION.analyticsEventsDays + 1),
      ago(RETENTION.analyticsEventsDays - 30),
    ]);
    await db().query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'verify_email', $2, $3)`, [
      u.id,
      `gone-${randomUUID()}`,
      ago(RETENTION.oneTimeDataDays + 1),
    ]);
    await db().query(`INSERT INTO notifications (user_id, category, type, created_at) VALUES ($1, 'social', 'old_one', $2)`, [
      u.id,
      ago(RETENTION.notificationsDays + 1),
    ]);

    // A view-once photo that was never sent, with its private file.
    const form = multipart({ name: 'a.jpg', type: 'image/jpeg', data: await gpsJpeg() });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/media?viewOnce=true',
      headers: { ...form.headers, authorization: `Bearer ${u.token}` },
      payload: form.payload,
    });
    const unsent = res.json().media.id as string;
    await db().query(`DELETE FROM jobs WHERE payload->>'mediaId' = $1`, [unsent]);
    const privateKey = (await db().query(`SELECT storage_key FROM media WHERE id = $1`, [unsent])).rows[0].storage_key as string;
    const privateFile = path.join('/tmp/ypl-test-private', privateKey);
    expect(existsSync(privateFile)).toBe(true);
    await db().query(`UPDATE media SET created_at = now() - interval '2 days' WHERE id = $1`, [unsent]);

    // A post deleted 31 days ago, with a video and its HLS segments.
    const video = await upload(u, 'clip.mov', geoVideo(), 'video/quicktime');
    await mediaJobHandlers({ db: db(), storage: t.ctx.storage })['media.process']({ mediaId: video.id });
    const post = (await as(t.app, u).post('/v1/posts', { body: 'Soon gone', media: [{ id: video.id, url: video.url, kind: video.kind }] })).body.post;
    expect(post?.id).toBeTruthy();
    await as(t.app, u).del(`/v1/posts/${post.id}`);
    await db().query(`UPDATE posts SET deleted_at = $2 WHERE id = $1`, [post.id, ago(RETENTION.deletedContentDays + 1)]);
    const base = path.join(UPLOADS, video.storage_key.replace(/\.[^.]+$/, ''));
    expect(existsSync(`${base}_hls/v0_000.ts`)).toBe(true);

    // A post deleted yesterday stays for now.
    const recent = (await as(t.app, u).post('/v1/posts', { body: 'Deleted yesterday' })).body.post;
    await as(t.app, u).del(`/v1/posts/${recent.id}`);

    const r = await runRetention({ db: db(), storage: t.ctx.storage, config: t.ctx.config });
    expect(r.errors).toEqual([]);

    expect(await count(`SELECT count(*) FROM sessions WHERE user_id = $1`, [u.id])).toBe(2); // the recent one and the sign-up session
    expect(await count(`SELECT count(*) FROM security_events WHERE user_id = $1 AND created_at < now() - interval '1 day'`, [u.id])).toBe(0);
    expect(await count(`SELECT count(*) FROM security_events WHERE user_id = $1`, [u.id])).toBeGreaterThan(0);
    expect(await count(`SELECT count(*) FROM analytics_events WHERE user_id = $1 AND name IN ('old', 'new')`, [u.id])).toBe(1);
    expect(await count(`SELECT count(*) FROM auth_tokens WHERE user_id = $1 AND expires_at < now() - interval '1 day'`, [u.id])).toBe(0);
    expect(await count(`SELECT count(*) FROM notifications WHERE user_id = $1 AND type = 'old_one'`, [u.id])).toBe(0);

    expect(await count(`SELECT count(*) FROM media WHERE id = $1`, [unsent])).toBe(0);
    expect(existsSync(privateFile)).toBe(false);

    expect(await count(`SELECT count(*) FROM posts WHERE id = $1`, [post.id])).toBe(0);
    expect(await count(`SELECT count(*) FROM media WHERE id = $1`, [video.id])).toBe(0);
    expect(existsSync(path.join(UPLOADS, video.storage_key))).toBe(false);
    expect(existsSync(`${base}_web.mp4`)).toBe(false);
    expect(existsSync(`${base}_poster.jpg`)).toBe(false);
    expect(existsSync(`${base}_hls`)).toBe(false);

    expect(await count(`SELECT count(*) FROM posts WHERE id = $1`, [recent.id])).toBe(1);
  });

  it('keeps a file another post still uses', async () => {
    const u = await signUp(t.app);
    const m = await upload(u, 'shared.jpg', await gpsJpeg(), 'image/jpeg');
    const a = (await as(t.app, u).post('/v1/posts', { body: 'One', media: [{ id: m.id, url: m.url, kind: m.kind }] })).body.post;
    const b = (await as(t.app, u).post('/v1/posts', { body: 'Two', media: [{ id: m.id, url: m.url, kind: m.kind }] })).body.post;
    expect(b?.id).toBeTruthy();
    await db().query(`UPDATE posts SET deleted_at = now() - interval '40 days' WHERE id = $1`, [a.id]);
    await runRetention({ db: db(), storage: t.ctx.storage, config: t.ctx.config });
    expect(await count(`SELECT count(*) FROM media WHERE id = $1`, [m.id])).toBe(1);
    expect(existsSync(path.join(UPLOADS, m.storage_key))).toBe(true);
  });

  it('runs at most once a day', async () => {
    await db().query(`DELETE FROM maintenance_runs WHERE name = 'retention'`);
    const deps = { db: db(), storage: t.ctx.storage, config: t.ctx.config };
    expect(await maybeRunRetention(deps)).not.toBeNull();
    expect(await maybeRunRetention(deps)).toBeNull();
    await db().query(`UPDATE maintenance_runs SET ran_at = now() - interval '25 hours' WHERE name = 'retention'`);
    expect(await maybeRunRetention(deps)).not.toBeNull();
  });

  it('removes raw live recordings once the live has ended for a while', async () => {
    const host = await signUp(t.app);
    const live = (await db().query(`INSERT INTO live_sessions (host_id, title) VALUES ($1, $2) RETURNING id`, [host.id, 'Old live'])).rows[0];
    await db().query(`UPDATE live_sessions SET status = 'ended', ended_at = now() - interval '5 days' WHERE id = $1`, [live.id]);
    const folder = path.join(recordings, 'live', live.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, '2026-01-01_10-00-00-000000.mp4'), 'x');
    const old = new Date(Date.now() - 5 * 86400_000);
    utimesSync(folder, old, old);
    await runRetention({ db: db(), storage: t.ctx.storage, config: t.ctx.config });
    expect(existsSync(folder)).toBe(false);
  });
});

// ─── 6. Age ──────────────────────────────────────────────────────────────

describe('age gate', () => {
  const register = (extra: Record<string, unknown>) => {
    const s = randomUUID().slice(0, 8);
    return as(t.app, null).post('/v1/auth/register', {
      email: `age_${s}@example.test`,
      password: 'correct-horse-battery',
      username: `age_${s}`,
      displayName: 'Age',
      ...extra,
    });
  };
  const yearsAgo = (y: number) => `${new Date().getUTCFullYear() - y}-01-01`;

  it('requires a real birth date and refuses under 13', async () => {
    const none = await register({});
    expect(none.status).toBe(400);
    expect(none.body.error.details.fields.birthDate).toBeTruthy();
    expect((await register({ birthDate: '2010-02-31' })).status).toBe(400);
    expect((await register({ birthDate: yearsAgo(-1) })).status).toBe(400);
    const kid = await register({ birthDate: yearsAgo(12) });
    expect(kid.status).toBe(403);
    expect(kid.body.error.code).toBe('under_minimum_age');
  });

  it('gives 13 to 17 year olds the protections for minors', async () => {
    const teen = await register({ birthDate: yearsAgo(15) });
    expect(teen.status).toBe(201);
    expect(teen.body.user.needsBirthDate).toBeUndefined();
    const id = teen.body.user.id;
    expect((await db().query(`SELECT is_private FROM profiles WHERE user_id = $1`, [id])).rows[0].is_private).toBe(true);
    expect((await db().query(`SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'advertising'`, [id])).rows[0].granted).toBe(false);
  });

  it('asks an account made before the rule for its birth date, once', async () => {
    const u = await signUp(t.app);
    await db().query(`UPDATE users SET birth_date = NULL WHERE id = $1`, [u.id]);
    expect((await as(t.app, u).get('/v1/auth/me')).body.user.needsBirthDate).toBe(true);
    expect((await as(t.app, u).post('/v1/me/birth-date', { birthDate: 'soon' })).status).toBe(400);
    const set = await as(t.app, u).post('/v1/me/birth-date', { birthDate: yearsAgo(16) });
    expect(set.status).toBe(200);
    expect(set.body.user.needsBirthDate).toBeUndefined();
    expect((await db().query(`SELECT is_private FROM profiles WHERE user_id = $1`, [u.id])).rows[0].is_private).toBe(true);
    expect((await as(t.app, u).post('/v1/me/birth-date', { birthDate: yearsAgo(30) })).status).toBe(409);
  });

  it('closes an account whose birth date says under 13', async () => {
    const u = await signUp(t.app);
    await db().query(`UPDATE users SET birth_date = NULL WHERE id = $1`, [u.id]);
    const r = await as(t.app, u).post('/v1/me/birth-date', { birthDate: yearsAgo(11) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('under_minimum_age');
    expect((await db().query(`SELECT status FROM users WHERE id = $1`, [u.id])).rows[0].status).toBe('suspended');
    expect((await as(t.app, u).get('/v1/auth/me')).status).toBe(401);
    expect((await as(t.app, null).post('/v1/auth/login', { email: u.email, password: u.password })).status).toBe(403);
  });

  it('keeps selling, payouts, paid plans and receiving tips for adults', async () => {
    const teen = await signUp(t.app, { birthDate: yearsAgo(16) });
    const adult = await signUp(t.app);
    const product = await as(t.app, teen).post('/v1/products', { kind: 'product', title: 'Bracelets', priceCents: 500, currency: 'USD' });
    expect(product.status).toBe(403);
    expect(product.body.error.code).toBe('adults_only');
    const plan = await as(t.app, teen).post('/v1/creator/plans', { name: 'Fans', priceCents: 300 });
    expect(plan.body.error.code).toBe('adults_only');
    await db().query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [teen.id]);
    expect((await as(t.app, teen).post('/v1/me/payouts', { amountCents: 1000, currency: 'USD' })).body.error.code).toBe('adults_only');
    const tip = await as(t.app, adult).post(`/v1/users/${teen.id}/tips`, { amountCents: 200, idempotencyKey: `tip-${randomUUID()}` });
    expect(tip.status).toBe(403);
    expect(tip.body.error.code).toBe('recipient_not_eligible');

    // No birth date on record: asked to add one first.
    const legacy = await signUp(t.app);
    await db().query(`UPDATE users SET birth_date = NULL WHERE id = $1`, [legacy.id]);
    expect((await as(t.app, legacy).post('/v1/products', { kind: 'product', title: 'Mugs', priceCents: 900 })).body.error.code).toBe('birth_date_required');

    // Adults still can.
    expect((await as(t.app, adult).post('/v1/products', { kind: 'product', title: 'Prints', priceCents: 900 })).status).toBe(201);
    expect((await as(t.app, teen).post(`/v1/users/${adult.id}/tips`, { amountCents: 200, idempotencyKey: `tip-${randomUUID()}` })).status).toBe(201);
  });
});

// ─── 1. Reporting ────────────────────────────────────────────────────────

describe('reporting stories, rooms and lives', () => {
  it('takes reports of stories, audio rooms and lives, and copyright as a reason', async () => {
    const owner = await signUp(t.app);
    const reporter = await signUp(t.app);
    const story = await db().query(
      `INSERT INTO moments (author_id, body, visibility, expires_at) VALUES ($1, 'Hi', 'public', now() + interval '1 day') RETURNING id`,
      [owner.id],
    );
    const slug = `gaps-${Date.now().toString(36)}`;
    expect((await as(t.app, owner).post('/v1/communities', { name: 'Gaps room', slug, topics: ['music'] })).status).toBe(201);
    const room = (await as(t.app, owner).post(`/v1/communities/${slug}/rooms`, { title: 'Listening' })).body.room;
    const live = (await db().query(`INSERT INTO live_sessions (host_id, title) VALUES ($1, $2) RETURNING id`, [owner.id, 'A live'])).rows[0];

    for (const [targetType, targetId] of [
      ['story', story.rows[0].id],
      ['room', room.id],
      ['live', live.id],
    ]) {
      const r = await as(t.app, reporter).post('/v1/reports', { targetType, targetId, reason: 'copyright' });
      expect(r.status).toBe(201);
      const again = await as(t.app, reporter).post('/v1/reports', { targetType, targetId, reason: 'spam' });
      expect(again.status).toBe(409);
    }
    const cases = await db().query(`SELECT target_type, subject_user_id FROM moderation_cases WHERE target_id = ANY($1::uuid[])`, [
      [story.rows[0].id, room.id, live.id],
    ]);
    expect(cases.rows.map((c) => c.target_type).sort()).toEqual(['live', 'room', 'story']);
    expect(cases.rows.every((c) => c.subject_user_id === owner.id)).toBe(true);
  });
});

// ─── 8. Files left behind ────────────────────────────────────────────────

describe('files of a deleted account', () => {
  it('removes HLS segments, live recordings and recap videos with the account', async () => {
    const u = await signUp(t.app);
    const video = await upload(u, 'clip.mov', geoVideo(), 'video/quicktime');
    await mediaJobHandlers({ db: db(), storage: t.ctx.storage })['media.process']({ mediaId: video.id });
    const base = path.join(UPLOADS, video.storage_key.replace(/\.[^.]+$/, ''));
    expect(existsSync(`${base}_hls/v1_000.ts`)).toBe(true);

    // A live with its stored recording and the raw one on the video server.
    const live = (await db().query(`INSERT INTO live_sessions (host_id, title) VALUES ($1, $2) RETURNING id`, [u.id, 'Recorded'])).rows[0];
    const rec = await upload(u, 'recording.mov', geoVideo(), 'video/quicktime');
    await mediaJobHandlers({ db: db(), storage: t.ctx.storage })['media.process']({ mediaId: rec.id });
    await db().query(`UPDATE live_sessions SET status = 'ended', ended_at = now(), recording_media_id = $2 WHERE id = $1`, [live.id, rec.id]);
    const raw = path.join(recordings, 'live', live.id);
    mkdirSync(raw, { recursive: true });
    writeFileSync(path.join(raw, '2026-01-01_10-00-00-000000.mp4'), 'x');
    const recBase = path.join(UPLOADS, rec.storage_key.replace(/\.[^.]+$/, ''));

    // A recap video with its poster.
    const recap = await upload(u, 'recap.mov', geoVideo(), 'video/quicktime');
    const recapBase = path.join(UPLOADS, recap.storage_key.replace(/\.[^.]+$/, ''));
    writeFileSync(`${recapBase}_recap.jpg`, 'poster');

    // A view-once photo (a private file).
    const photo = await gpsJpeg();
    const body = multipart({ name: 'once.jpg', type: 'image/jpeg', data: photo });
    const once = await t.app.inject({
      method: 'POST',
      url: '/v1/media?viewOnce=true',
      headers: { ...body.headers, authorization: `Bearer ${u.token}` },
      payload: body.payload,
    });
    const onceKey = (await db().query(`SELECT storage_key FROM media WHERE id = $1`, [once.json().media.id])).rows[0].storage_key as string;

    expect((await as(t.app, u).del('/v1/me', { password: u.password })).status).toBe(200);
    const gone = await until(
      () =>
        !existsSync(path.join(UPLOADS, video.storage_key)) &&
        !existsSync(`${base}_hls`) &&
        !existsSync(`${base}_web.mp4`) &&
        !existsSync(`${recBase}_hls`) &&
        !existsSync(path.join(UPLOADS, rec.storage_key)) &&
        !existsSync(raw) &&
        !existsSync(path.join(UPLOADS, recap.storage_key)) &&
        !existsSync(`${recapBase}_recap.jpg`) &&
        !existsSync(path.join('/tmp/ypl-test-private', onceKey)),
      10_000,
    );
    expect(gone).toBe(true);
  });
});

describe('metrics', () => {
  it('are open in development, and need the token when one is set', async () => {
    const open = await testApp();
    expect((await open.app.inject({ url: '/metrics' })).statusCode).toBe(200);
    await open.close();
    const locked = await testApp({ METRICS_TOKEN: 'a-long-metrics-token-for-the-test' });
    expect((await locked.app.inject({ url: '/metrics' })).statusCode).toBe(404);
    expect((await locked.app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(404);
    const ok = await locked.app.inject({ url: '/metrics', headers: { authorization: 'Bearer a-long-metrics-token-for-the-test' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('ypl_http_requests_total');
    await locked.close();
  });
});
