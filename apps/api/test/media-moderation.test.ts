import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { mediaJobHandlers, sampleTimes } from '../src/lib/media-processing.ts';
import {
  devMediaModerator,
  mediaModeratorFromConfig,
  rekognitionModerator,
  verdictForLabels,
  type MediaFrame,
  type MediaModerator,
} from '../src/lib/media-moderation.ts';
import { signingKey, signV4 } from '../src/lib/sigv4.ts';
import { loadConfig } from '../src/config.ts';

let t: BuiltApp;
let mod: TestUser;
let photo: Buffer;
let clip: Buffer;
const ADULT = '1990-01-01';
const MINOR = '2012-06-01';

beforeAll(async () => {
  t = await testApp();
  mod = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'moderator' WHERE id = $1`, [mod.id]);
  photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3a7bd5' } })
    .jpeg()
    .toBuffer();
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-moderation-'));
  const src = path.join(dir, 'clip.mp4');
  const r = spawnSync(ffmpegPath as unknown as string, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=24:duration=4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    src,
  ]);
  expect(r.status).toBe(0);
  clip = readFileSync(src);
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;

function multipart(file: { name: string; type: string; data: Buffer }) {
  const boundary = `----ypl${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Upload through the real endpoint, then run the media job it queued (with the app's moderator unless one is given). */
async function upload(owner: TestUser, name: string, opts: { data?: Buffer; type?: string; moderator?: MediaModerator; process?: boolean } = {}) {
  const body = multipart({ name, type: opts.type ?? 'image/jpeg', data: opts.data ?? photo });
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/media',
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${owner.token}` },
  });
  expect(res.statusCode).toBe(201);
  const media = res.json().media as { id: string; url: string; kind: 'image' | 'video' };
  if (opts.process !== false) await runJob(media.id, opts.moderator);
  return media;
}

async function runJob(mediaId: string, moderator: MediaModerator = t.ctx.mediaModerator) {
  const job = (await db().query(`SELECT id, payload FROM jobs WHERE kind = 'media.process' AND payload->>'mediaId' = $1`, [mediaId])).rows[0];
  const handlers = mediaJobHandlers({ db: db(), storage: t.ctx.storage, moderator, realtime: t.ctx.realtime });
  await handlers['media.process'](job.payload);
  await db().query(`UPDATE jobs SET status = 'done', finished_at = now() WHERE id = $1`, [job.id]);
}

const moderation = async (id: string) => (await db().query(`SELECT moderation, moderation_provider, moderation_labels FROM media WHERE id = $1`, [id])).rows[0];
const befriend = (a: TestUser, b: TestUser) => {
  const [x, y] = [a.id, b.id].sort();
  return db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
};
async function storedVideo(owner: TestUser, verdict: string) {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms, moderation) VALUES ($1,'video','http://localhost:4000/media/t.mp4','video/mp4','ready',8000,$2) RETURNING id, url`,
    [owner.id, verdict],
  );
  return rows[0] as { id: string; url: string };
}

describe('automated media checks in the media job', () => {
  it('marks ordinary photos ok', async () => {
    const u = await signUp(t.app, { birthDate: ADULT });
    const m = await upload(u, 'holiday.jpg');
    expect(await moderation(m.id)).toMatchObject({ moderation: 'ok', moderation_provider: 'dev' });
    const post = await as(t.app, u).post('/v1/posts', { body: 'Holiday', media: [{ id: m.id, url: m.url, kind: 'image' }] });
    expect(post.body.post.media[0].sensitive).toBeUndefined();
  });

  it('blurs sensitive photos for adults and never sends them to people under 18', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const adult = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: MINOR });
    const unknownAge = await signUp(t.app);
    const m = await upload(author, 'beach-sensitive.jpg');
    expect((await moderation(m.id)).moderation).toBe('sensitive');
    const post = (await as(t.app, author).post('/v1/posts', { body: 'At the beach', media: [{ id: m.id, url: m.url, kind: 'image' }] })).body.post;
    expect(post.media).toHaveLength(1);
    expect(post.media[0]).toMatchObject({ id: m.id, sensitive: true });

    const seenByAdult = (await as(t.app, adult).get(`/v1/posts/${post.id}`)).body.post;
    expect(seenByAdult.media[0]).toMatchObject({ id: m.id, sensitive: true });
    for (const viewer of [teen, unknownAge]) {
      const seen = (await as(t.app, viewer).get(`/v1/posts/${post.id}`)).body.post;
      expect(seen.body).toBe('At the beach');
      expect(seen.media).toEqual([]);
      expect(JSON.stringify(seen)).not.toContain(m.url);
    }
    // People who aren't signed in (link previews) don't get it either.
    const preview = await t.app.inject({ method: 'GET', url: `/v1/public/posts/${post.id}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().post.image).toBeNull();
  });

  it('checks the poster and sampled frames of videos', async () => {
    expect(sampleTimes(4000)).toEqual([1, 2, 3]);
    expect(sampleTimes(800)).toEqual([]);
    const u = await signUp(t.app, { birthDate: ADULT });
    const seen: { frames: MediaFrame[]; kind: string; filename?: string | null }[] = [];
    const dev = devMediaModerator();
    const spy: MediaModerator = {
      name: 'dev',
      moderate: async (frames, hints) => {
        seen.push({ frames, kind: hints.kind, filename: hints.filename });
        return dev.moderate(frames, hints);
      },
    };
    const v = await upload(u, 'party-sensitive.mp4', { data: clip, type: 'video/mp4', moderator: spy });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('video');
    expect(seen[0]!.filename).toBe('party-sensitive.mp4');
    expect(seen[0]!.frames.map((f) => f.label)).toEqual(['poster', 'frame@1s', 'frame@2s', 'frame@3s']);
    for (const f of seen[0]!.frames) expect((await sharp(f.data).metadata()).format).toBe('jpeg');
    const row = (await db().query(`SELECT moderation, poster_url, hls_url FROM media WHERE id = $1`, [v.id])).rows[0];
    expect(row.moderation).toBe('sensitive');
    expect(row.poster_url).toBeTruthy();
  }, 60_000);

  it('keeps sensitive reels out of the reels feed for people under 18', async () => {
    const creator = await signUp(t.app, { birthDate: ADULT });
    const adult = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: MINOR });
    for (const f of [adult, teen]) await as(t.app, f).post(`/v1/users/${creator.id}/follow`);
    const v = await storedVideo(creator, 'sensitive');
    const reel = (await as(t.app, creator).post('/v1/posts', { format: 'reel', body: 'Night out', media: [{ id: v.id, url: v.url, kind: 'video' }] })).body
      .post;
    const adultFeed = (await as(t.app, adult).get('/v1/reels?limit=20')).body.items;
    expect(adultFeed.find((p: any) => p.id === reel.id)?.media[0].sensitive).toBe(true);
    const teenFeed = (await as(t.app, teen).get('/v1/reels?limit=20')).body.items;
    expect(teenFeed.map((p: any) => p.id)).not.toContain(reel.id);
  });

  it('applies to stories', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const adult = await signUp(t.app, { birthDate: ADULT });
    const teen = await signUp(t.app, { birthDate: MINOR });
    for (const f of [adult, teen]) await as(t.app, f).post(`/v1/users/${author.id}/follow`);
    const sensitive = await storedVideo(author, 'sensitive');
    const s = (await as(t.app, author).post('/v1/moments', { mediaId: sensitive.id, visibility: 'followers' })).body.moment;
    const plain = (await as(t.app, author).post('/v1/moments', { body: 'Good morning', visibility: 'followers' })).body.moment;
    const storiesOf = async (viewer: TestUser) =>
      ((await as(t.app, viewer).get('/v1/moments')).body.items.find((g: any) => g.author.id === author.id)?.moments ?? []) as any[];
    expect((await storiesOf(adult)).find((m) => m.id === s.id)).toMatchObject({ sensitive: true });
    expect((await storiesOf(teen)).map((m) => m.id)).toEqual([plain.id]);
    expect((await as(t.app, teen).post(`/v1/moments/${s.id}/view`)).status).toBe(404);
  });

  it('applies to chat attachments', async () => {
    const sender = await signUp(t.app, { birthDate: ADULT });
    const adult = await signUp(t.app, { birthDate: ADULT });
    const unknownAge = await signUp(t.app);
    await befriend(sender, adult);
    await befriend(sender, unknownAge);
    const m = await upload(sender, 'sunset-nsfw.jpg');
    const convA = (await as(t.app, sender).post('/v1/conversations', { memberIds: [adult.id] })).body.conversation;
    const convB = (await as(t.app, sender).post('/v1/conversations', { memberIds: [unknownAge.id] })).body.conversation;
    const sent = await as(t.app, sender).post(`/v1/conversations/${convA.id}/messages`, { attachments: [{ mediaId: m.id }] });
    expect(sent.body.message.attachments[0]).toMatchObject({ mediaId: m.id, sensitive: true });
    await as(t.app, sender).post(`/v1/conversations/${convB.id}/messages`, { attachments: [{ mediaId: m.id }] });

    const forAdult = (await as(t.app, adult).get(`/v1/conversations/${convA.id}/messages`)).body.items[0].attachments[0];
    expect(forAdult).toMatchObject({ mediaId: m.id, sensitive: true, kind: 'image' });
    expect(forAdult.url).toBeTruthy();
    const forOther = (await as(t.app, unknownAge).get(`/v1/conversations/${convB.id}/messages`)).body.items[0].attachments[0];
    expect(forOther).toEqual({ kind: 'image', mediaId: m.id, url: '', removed: true });
    const inList = (await as(t.app, unknownAge).get('/v1/conversations')).body.items.find((c: any) => c.id === convB.id);
    expect(inList.lastMessage.attachments[0]).toMatchObject({ removed: true, url: '' });
  });

  it('removes blocked media everywhere, opens a case, tells the uploader, and restores it if a moderator disagrees', async () => {
    const u = await signUp(t.app, { birthDate: ADULT });
    const friend = await signUp(t.app, { birthDate: ADULT });
    await befriend(u, friend);
    await as(t.app, friend).post(`/v1/users/${u.id}/follow`);
    // Shared before the check finished: the post, a story and a chat message.
    const m = await upload(u, 'blocked-example.jpg', { process: false });
    expect((await moderation(m.id)).moderation).toBe('pending');
    const post = (await as(t.app, u).post('/v1/posts', { body: 'Look', media: [{ id: m.id, url: m.url, kind: 'image' }] })).body.post;
    const story = (await as(t.app, u).post('/v1/moments', { mediaId: m.id, visibility: 'followers' })).body.moment;
    const conv = (await as(t.app, u).post('/v1/conversations', { memberIds: [friend.id] })).body.conversation;
    await as(t.app, u).post(`/v1/conversations/${conv.id}/messages`, { body: 'see this', attachments: [{ mediaId: m.id }] });
    expect((await as(t.app, friend).get(`/v1/posts/${post.id}`)).status).toBe(200);

    await runJob(m.id);
    expect((await moderation(m.id)).moderation).toBe('blocked');
    expect((await as(t.app, friend).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await db().query(`SELECT moderation_status FROM posts WHERE id = $1`, [post.id])).rows[0].moderation_status).toBe('removed');
    const stories = (await as(t.app, friend).get('/v1/moments')).body.items.find((g: any) => g.author.id === u.id)?.moments ?? [];
    expect(stories.map((s: any) => s.id)).not.toContain(story.id);
    const msg = (await as(t.app, friend).get(`/v1/conversations/${conv.id}/messages`)).body.items[0];
    expect(msg.body).toBe('see this');
    expect(msg.attachments).toEqual([{ kind: 'image', mediaId: m.id, url: '', removed: true }]);

    const kase = (
      await db().query(`SELECT id, status, source, subject_user_id, signals FROM moderation_cases WHERE target_type = 'media' AND target_id = $1`, [m.id])
    ).rows[0];
    expect(kase).toMatchObject({ status: 'open', source: 'automated', subject_user_id: u.id });
    expect(kase.signals.posts).toEqual([post.id]);
    expect(kase.signals.stories).toEqual([story.id]);
    expect(kase.signals.media.labels[0].name).toBe('Test: blocked');
    const note = (await as(t.app, u).get('/v1/notifications')).body.items.find((n: any) => n.type === 'media_blocked');
    expect(note).toMatchObject({ category: 'moderation', entityType: 'moderation_case', entityId: kase.id });

    // It can't be shared again, and the reason is in plain words.
    const again = await as(t.app, u).post('/v1/posts', { body: 'Again', media: [{ id: m.id, url: m.url, kind: 'image' }] });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('media_blocked');
    expect(again.body.error.message).toMatch(/goes against our community rules/);
    expect((await as(t.app, u).post('/v1/moments', { mediaId: m.id })).status).toBe(422);
    expect((await as(t.app, u).post(`/v1/conversations/${conv.id}/messages`, { attachments: [{ mediaId: m.id }] })).status).toBe(422);

    // The moderator console shows the media; "no action" puts everything back.
    const listed = await db().query(`SELECT 1 FROM moderation_cases WHERE id = $1 AND status = 'open'`, [kase.id]);
    expect(listed.rowCount).toBe(1);
    expect((await as(t.app, mod).post(`/v1/admin/moderation/cases/${kase.id}/decide`, { decision: 'no_action' })).status).toBe(200);
    expect((await moderation(m.id)).moderation).toBe('ok');
    expect((await as(t.app, friend).get(`/v1/posts/${post.id}`)).body.post.media).toHaveLength(1);
    expect((await as(t.app, u).get('/v1/notifications')).body.items.map((n: any) => n.type)).toContain('media_restored');
  });

  it('keeps media as it is with the none provider', async () => {
    const u = await signUp(t.app);
    const none = mediaModeratorFromConfig(loadConfig({ DATABASE_URL: 'postgres://x', MEDIA_MODERATION_PROVIDER: 'none' }));
    expect(none.name).toBe('none');
    const m = await upload(u, 'blocked-but-unchecked.jpg', { moderator: none });
    expect((await moderation(m.id)).moderation).toBe('pending');
  });

  it('defaults to dev outside production and none in production', () => {
    expect(mediaModeratorFromConfig(loadConfig({ DATABASE_URL: 'postgres://x', APP_ENV: 'test' })).name).toBe('dev');
    const prod = loadConfig({
      DATABASE_URL: 'postgres://x',
      APP_ENV: 'production',
      PAYMENTS_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk',
      STRIPE_WEBHOOK_SECRET: 'wh',
      STRIPE_PUBLISHABLE_KEY: 'pk',
      MFA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      COOKIE_SECURE: 'true',
    });
    expect(prod.MEDIA_MODERATION_PROVIDER).toBe('none');
    expect(prod.REQUIRE_VERIFICATION).toBe(true);
    expect(prod.SPAM_CHECKS).toBe(true);
  });
});

describe('AWS Rekognition adapter', () => {
  it('signs requests with SigV4 (AWS documentation example)', () => {
    expect(signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
    const h = signV4({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      region: 'us-east-1',
      service: 'iam',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
  });

  it('maps moderation labels to ok, sensitive and blocked', () => {
    expect(verdictForLabels([])).toBe('ok');
    expect(verdictForLabels([{ name: 'Alcohol', confidence: 99 }])).toBe('ok');
    expect(verdictForLabels([{ name: 'Suggestive', confidence: 75 }])).toBe('sensitive');
    expect(verdictForLabels([{ name: 'Female Swimwear Or Underwear', parent: 'Suggestive', confidence: 88 }])).toBe('sensitive');
    expect(verdictForLabels([{ name: 'Graphic Male Nudity', parent: 'Explicit Nudity', confidence: 97 }])).toBe('blocked');
    // Less certain matches on blockable labels are blurred rather than removed.
    expect(verdictForLabels([{ name: 'Explicit Nudity', confidence: 65 }])).toBe('sensitive');
    expect(verdictForLabels([{ name: 'Suggestive', confidence: 40 }])).toBe('ok');
  });

  it('calls DetectModerationLabels for each frame and keeps the most severe verdict', async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    const answers = [
      { ModerationLabels: [{ Name: 'Suggestive', ParentName: '', Confidence: 81.234 }] },
      { ModerationLabels: [{ Name: 'Explicit Nudity', ParentName: '', Confidence: 96 }] },
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answers[calls.length - 1] ?? { ModerationLabels: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const rk = rekognitionModerator({
      region: 'eu-west-1',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret',
      sessionToken: 'session',
      fetch: fakeFetch,
      now: () => new Date('2026-09-26T10:00:00Z'),
    });
    const frame = (label: string): MediaFrame => ({ data: photo, mime: 'image/jpeg', label });
    const result = await rk.moderate([frame('poster'), frame('frame@1s'), frame('frame@2s')], { mediaId: 'x', kind: 'video' });
    expect(result.verdict).toBe('blocked');
    // It stops at the first blocked frame.
    expect(calls).toHaveLength(2);
    expect(result.labels).toEqual([
      { name: 'Suggestive', parent: null, confidence: 81.2 },
      { name: 'Explicit Nudity', parent: null, confidence: 96 },
    ]);
    const c = calls[0]!;
    expect(c.url).toBe('https://rekognition.eu-west-1.amazonaws.com/');
    expect(c.headers['x-amz-target']).toBe('RekognitionService.DetectModerationLabels');
    expect(c.headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(c.headers['x-amz-date']).toBe('20260926T100000Z');
    expect(c.headers['x-amz-security-token']).toBe('session');
    expect(c.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20260926\/eu-west-1\/rekognition\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    expect(Buffer.from(c.body.Image.Bytes, 'base64').equals(photo)).toBe(true);
    expect(c.body.MinConfidence).toBe(50);

    const failing = rekognitionModerator({
      region: 'eu-west-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      fetch: (async () => new Response('{"__type":"ThrottlingException"}', { status: 400 })) as unknown as typeof fetch,
    });
    // Errors throw so the job retries instead of passing unchecked media as ok.
    await expect(failing.moderate([frame('image')], { mediaId: 'x', kind: 'image' })).rejects.toThrow(/rekognition 400/);
  });
});
