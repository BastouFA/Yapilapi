import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowsDerivatives, echoFrame, echoNoticeText, echoVolumes, t as tr, tp as trp, type MusicTrack } from '@yapilapi/shared';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import { processJobs } from '../src/lib/jobs.ts';
import { mediaJobHandlers, probe, run } from '../src/lib/media-processing.ts';
import { planEcho, shiftCues } from '../src/lib/echoes.ts';
import { saveCaptionTrack } from '../src/lib/studio.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

const UPLOADS = '/tmp/ypl-test-uploads';
let t: BuiltApp;

beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const handlers = () => ({ ...mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }), ...t.ctx.jobs });
async function drain() {
  for (let i = 0; i < 20; i++) if (!(await processJobs(t.ctx.db, handlers()))) return;
}

let n = 0;
/**
 * A tiny test video made by ffmpeg (a moving test pattern, and a tone unless `silent`), stored like
 * an upload and ready. `meta` is written into the file, to check that echoes leave it out.
 */
async function video(owner: TestUser, o: { seconds?: number; size?: string; freq?: number; silent?: boolean; meta?: string } = {}) {
  const seconds = o.seconds ?? 2;
  const size = o.size ?? '180x320';
  const key = `tests/${Date.now()}-${n++}-echo.mp4`;
  await mkdir(path.dirname(path.join(UPLOADS, key)), { recursive: true });
  await run([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=15:duration=${seconds}`,
    ...(o.silent ? [] : ['-f', 'lavfi', '-i', `sine=frequency=${o.freq ?? 330}:duration=${seconds}`]),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...(o.silent ? [] : ['-c:a', 'aac', '-shortest']),
    ...(o.meta ? ['-metadata', `title=${o.meta}`, '-metadata', 'location=+06.4550+003.3841/'] : []),
    path.join(UPLOADS, key),
  ]);
  const [w, h] = size.split('x').map(Number);
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, moderation, duration_ms, width, height, storage_key)
     VALUES ($1,'video',$2,'video/mp4','ready','ok',$3,$4,$5,$6) RETURNING id, url`,
    [owner.id, `http://localhost/media/${key}`, seconds * 1000, w, h, key],
  );
  return { id: rows[0].id as string, url: rows[0].url as string };
}

async function reel(owner: TestUser, extra: Record<string, unknown> = {}, v?: { id: string; url: string }) {
  const m = v ?? (await video(owner));
  const res = await as(t.app, owner).post('/v1/posts', {
    format: 'reel',
    body: 'Dance with me',
    visibility: 'public',
    media: [{ id: m.id, url: m.url, kind: 'video' }],
    ...extra,
  });
  expect(res.status, res.body?.error?.message).toBe(201);
  return { postId: res.body.post.id as string, mediaId: m.id };
}

/** Make an echo of `postId` as `user` and wait for it. */
async function makeEcho(user: TestUser, postId: string, body: Record<string, unknown> = {}, v?: { id: string; url: string }) {
  const mine = v ?? (await video(user, { seconds: 1.5, size: '160x284', freq: 550 }));
  const res = await as(t.app, user).post(`/v1/posts/${postId}/echoes`, { mediaId: mine.id, ...body });
  expect(res.status, res.body?.error?.message).toBe(202);
  expect(res.body.echo.status).toBe('queued');
  await drain();
  const done = await as(t.app, user).get(`/v1/echoes/${res.body.echo.id}`);
  expect(done.body.echo.status, done.body.echo.error).toBe('ready');
  return done.body.echo as { id: string; media: { id: string; url: string; width: number; height: number; durationMs: number }; theirAudio: string };
}

async function postEcho(user: TestUser, echo: { id: string; media: { id: string; url: string } }, extra: Record<string, unknown> = {}) {
  return as(t.app, user).post('/v1/posts', {
    format: 'reel',
    body: 'My answer',
    visibility: 'public',
    media: [{ id: echo.media.id, url: echo.media.url, kind: 'video' }],
    echo: echo.id,
    ...extra,
  });
}

/** What ffmpeg says about a stored file (its streams and any metadata left in it). */
function describeFile(file: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath as string, ['-hide_banner', '-i', file]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve(err));
  });
}
const storedFile = async (mediaId: string) =>
  path.join(UPLOADS, (await t.ctx.db.query(`SELECT storage_key FROM media WHERE id = $1`, [mediaId])).rows[0].storage_key);

const follow = (a: TestUser, b: TestUser) => as(t.app, a).post(`/v1/users/${b.id}/follow`);
async function befriend(a: TestUser, b: TestUser) {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  await as(t.app, b).post(`/v1/users/${a.id}/friend-request`);
}

describe('echo helpers', () => {
  it('lays out the frame, the balance and the credit', () => {
    expect(echoFrame('side')).toMatchObject({ width: 720, height: 640, theirs: { x: 0, width: 360, height: 640 }, yours: { x: 360, width: 360 } });
    expect(echoFrame('stack')).toMatchObject({ width: 720, height: 1280, theirs: { y: 0, height: 640 }, yours: { y: 640, height: 640 } });
    const corner = echoFrame('corner');
    expect(corner.yours).toEqual({ x: 0, y: 0, width: 720, height: 1280 });
    expect(corner.theirs.x + corner.theirs.width).toBeLessThan(720);
    expect((corner.theirs.width % 2) + (corner.theirs.height % 2)).toBe(0);
    expect(echoVolumes(50)).toEqual({ theirs: 1, yours: 1 });
    expect(echoVolumes(0)).toEqual({ theirs: 1, yours: 0 });
    expect(echoVolumes(75)).toEqual({ theirs: 0.5, yours: 1 });
    expect(echoVolumes(50, true).theirs).toBe(0);
    // "Echo after": their captions move to where their part plays.
    const cues = shiftCues(
      [
        { start: 0.2, end: 1, text: 'First' },
        { start: 1.2, end: 1.8, text: 'Second', id: 'x' },
      ],
      1000,
      5000,
    );
    expect(cues).toEqual([{ start: expect.closeTo(0.2, 5), end: expect.closeTo(0.8, 5), text: 'Second' }]);
    // Notifications read as whole sentences.
    const tt = (k: any, v?: any) => tr(k, 'en', v);
    const ttp = (k: any, c: number, v?: any) => trp(k, c, 'en', v);
    expect(echoNoticeText({ type: 'reel_echo', actor: { displayName: 'Ada' }, data: { count: 4 } }, tt, ttp)).toBe('Ada and 3 others echoed your reel');
    expect(echoNoticeText({ type: 'reel_echo', actor: { displayName: 'Ada' }, data: {} }, tt, ttp)).toBe('Ada echoed your reel');
    // Licences: stated by the provider, or Creative Commons without "No derivatives".
    expect(allowsDerivatives({ name: 'Partner', derivatives: true })).toBe(true);
    expect(allowsDerivatives({ name: 'CC BY 4.0' })).toBe(true);
    expect(allowsDerivatives({ name: 'CC BY-ND 4.0' })).toBe(false);
    expect(allowsDerivatives({ name: 'Partner' })).toBe(false);
  });

  it('plans the command: the cut first, the layout, their sound and yours, no metadata', () => {
    const plan = planEcho({
      layout: 'stack',
      theirs: 'a.mp4',
      theirStartMs: 2000,
      yours: 'b.mp4',
      theirAudio: { file: 'a.mp4', loop: false },
      yoursHasAudio: true,
      credit: 'credit.png',
      cutMs: 3000,
      yoursMs: 4000,
      volumes: { theirs: 0.5, yours: 1 },
      output: 'out.mp4',
    });
    expect(plan).toMatchObject({ width: 720, height: 1280, durationMs: 7000 });
    const graph = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('vstack');
    expect(graph).toContain('concat=n=2');
    expect(graph).toContain("volume='if(lt(t,3.000),1,0.5)'");
    expect(graph).toContain('adelay=3000|3000');
    expect(plan.args).toEqual(expect.arrayContaining(['-map_metadata', '-1']));
  });
});

describe('making echoes', () => {
  it('puts the two together side by side, top and bottom or in a corner, at the right size and length, without metadata', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const original = await reel(ada);

    const options = await as(t.app, bola).get(`/v1/posts/${original.postId}/echo`);
    expect(options.status).toBe(200);
    expect(options.body).toMatchObject({ canEcho: true, reason: null, theirAudio: 'mixed', original: { id: original.postId, durationMs: 2000 } });
    expect((await as(t.app, bola).get(`/v1/posts/${original.postId}`)).body.post.viewer.canEcho).toBe(true);

    const mine = await video(bola, { seconds: 1.5, size: '160x284', freq: 550, meta: 'Secret title' });
    const side = await makeEcho(bola, original.postId, { layout: 'side' }, mine);
    expect(side.media).toMatchObject({ width: 720, height: 640 });
    const sideInfo = await probe(await storedFile(side.media.id));
    expect(sideInfo).toMatchObject({ width: 720, height: 640, hasAudio: true });
    expect(Math.abs(sideInfo.durationMs! - 1500)).toBeLessThan(200);
    const described = await describeFile(await storedFile(side.media.id));
    expect(described).not.toContain('Secret title');
    expect(described).not.toContain('+06.4550');
    // It went through the same processing as an upload (poster, web MP4, HLS).
    const processed = (await t.ctx.db.query(`SELECT status, poster_url, hls_url, variants FROM media WHERE id = $1`, [side.media.id])).rows[0];
    expect(processed.status).toBe('ready');
    expect(processed.poster_url).toBeTruthy();
    expect(processed.variants.mp4).toBeTruthy();

    // "Echo after": one second of theirs first, then both, one on top of the other.
    const stack = await makeEcho(bola, original.postId, { layout: 'stack', cut: { startMs: 500, endMs: 1500 } }, mine);
    const stackInfo = await probe(await storedFile(stack.media.id));
    expect(stackInfo).toMatchObject({ width: 720, height: 1280, hasAudio: true });
    expect(Math.abs(stackInfo.durationMs! - 2500)).toBeLessThan(250);

    // Theirs small in a corner, with their sound left out, from a video without sound: still has an audio track.
    const quiet = await video(bola, { seconds: 1, size: '160x284', silent: true });
    const corner = await makeEcho(bola, original.postId, { layout: 'corner', muteTheirs: true }, quiet);
    expect(corner.theirAudio).toBe('muted');
    const cornerInfo = await probe(await storedFile(corner.media.id));
    expect(cornerInfo).toMatchObject({ width: 720, height: 1280, hasAudio: true });
    expect(Math.abs(cornerInfo.durationMs! - 1000)).toBeLessThan(200);
  });

  it('checks the request: your own video, a cut within their reel of up to 15 seconds', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const original = await reel(ada);
    const adas = await video(ada);
    expect((await as(t.app, bola).post(`/v1/posts/${original.postId}/echoes`, { mediaId: adas.id })).status).toBe(404);
    const mine = await video(bola, { seconds: 1 });
    const long = await as(t.app, bola).post(`/v1/posts/${original.postId}/echoes`, { mediaId: mine.id, cut: { startMs: 0, endMs: 16_000 } });
    expect(long.status).toBe(400);
    const past = await as(t.app, bola).post(`/v1/posts/${original.postId}/echoes`, { mediaId: mine.id, cut: { startMs: 5000, endMs: 7000 } });
    expect(past.status).toBe(400);
    expect(past.body.error.details.fields['cut.startMs']).toBeTruthy();
    const photo = (
      await t.ctx.db.query(
        `INSERT INTO media (owner_id, kind, url, mime, status, storage_key) VALUES ($1,'image','http://localhost/x.jpg','image/jpeg','ready','x.jpg') RETURNING id`,
        [bola.id],
      )
    ).rows[0].id;
    expect((await as(t.app, bola).post(`/v1/posts/${original.postId}/echoes`, { mediaId: photo })).status).toBe(400);
  });

  it('carries their captions to where their part plays', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const original = await reel(ada);
    await saveCaptionTrack(t.ctx, {
      mediaId: original.mediaId,
      lang: 'en',
      label: 'English',
      source: 'manual',
      cues: [
        { start: 0.1, end: 0.9, text: 'Hello there' },
        { start: 1.2, end: 1.9, text: 'Your turn' },
      ],
      userId: ada.id,
    });
    const echo = await makeEcho(bola, original.postId, { cut: { startMs: 1000, endMs: 2000 } });
    const tracks = await t.ctx.db.query(`SELECT lang, label, cue_count FROM caption_tracks WHERE media_id = $1`, [echo.media.id]);
    expect(tracks.rows).toEqual([{ lang: 'en', label: 'English', cue_count: 1 }]);
  });
});

describe('posting echoes', () => {
  it('posts as a reel linked to the original, counted there, listed, and tells its creator once for several people', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const cleo = await signUp(t.app);
    const dayo = await signUp(t.app);
    const original = await reel(ada);

    const echo = await makeEcho(bola, original.postId);
    // Only the video made for it.
    const other = await video(bola);
    const wrong = await as(t.app, bola).post('/v1/posts', {
      format: 'reel',
      visibility: 'public',
      media: [{ id: other.id, url: other.url, kind: 'video' }],
      echo: echo.id,
    });
    expect(wrong.status).toBe(400);
    // Not as a draft, and not with someone else's sound.
    expect((await postEcho(bola, echo, { draft: true })).status).toBe(400);
    const posted = await postEcho(bola, echo);
    expect(posted.status, posted.body?.error?.message).toBe(201);
    const post = posted.body.post;
    expect(post.echoOf).toMatchObject({ post: { id: original.postId, author: { id: ada.id } }, layout: 'side', theirAudio: 'mixed' });
    expect(post.allowRemix).toBe(false);
    expect(post.sound ?? null).toBeNull();
    expect(post.viewer.canEcho).toBe(false);
    // Once only.
    expect((await postEcho(bola, echo)).status).toBe(409);

    // Seen from the original: counted and listed, for people who can see both.
    const seen = (await as(t.app, dayo).get(`/v1/posts/${original.postId}`)).body.post;
    expect(seen.counts.echoes).toBe(1);
    const list = await as(t.app, dayo).get(`/v1/posts/${original.postId}/echoes`);
    expect(list.body.items.map((p: any) => p.id)).toEqual([post.id]);
    expect(list.body.items[0].echoOf.post.id).toBe(original.postId);

    // Ada hears about it; Cleo's echo joins the same notification.
    const cleos = await makeEcho(cleo, original.postId, { layout: 'corner' });
    expect((await postEcho(cleo, cleos)).status).toBe(201);
    const notes = (await as(t.app, ada).get('/v1/notifications')).body.items.filter((x: any) => x.type === 'reel_echo');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ actor: { id: cleo.id }, data: { originalId: original.postId, count: 2 } });

    // Reported like any post.
    expect((await as(t.app, dayo).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'spam' })).status).toBeLessThan(300);
  });

  it("can't be for subscribers, now or later", async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const original = await reel(ada);
    const echo = await makeEcho(bola, original.postId);
    expect((await postEcho(bola, echo, { visibility: 'subscribers' })).status).toBe(400);
    const posted = await postEcho(bola, echo);
    expect((await as(t.app, bola).patch(`/v1/posts/${posted.body.post.id}`, { visibility: 'subscribers' })).status).toBe(400);
  });
});

describe('who can echo', () => {
  it("follows the creator's choice, which they can change for new echoes", async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const cleo = await signUp(t.app);
    const original = await reel(ada, { allowEchoes: 'following' });
    expect((await as(t.app, ada).get(`/v1/posts/${original.postId}`)).body.post.allowEchoes).toBe('following');
    // Only the author sees the setting.
    expect((await as(t.app, bola).get(`/v1/posts/${original.postId}`)).body.post.allowEchoes).toBeUndefined();
    await follow(ada, bola);
    expect((await as(t.app, bola).get(`/v1/posts/${original.postId}/echo`)).body).toMatchObject({ canEcho: true });
    const refused = await as(t.app, cleo).get(`/v1/posts/${original.postId}/echo`);
    expect(refused.body).toMatchObject({ canEcho: false, reason: 'following' });
    const cleos = await video(cleo);
    const tried = await as(t.app, cleo).post(`/v1/posts/${original.postId}/echoes`, { mediaId: cleos.id });
    expect(tried.status).toBe(403);
    expect(tried.body.error.code).toBe('echo_not_allowed');

    // Bola made one; then Ada turns echoes off: Bola can't post it, but earlier echoes stay.
    const early = await makeEcho(bola, original.postId);
    const earlyPost = await postEcho(bola, early);
    const late = await makeEcho(bola, original.postId);
    expect((await as(t.app, bola).put(`/v1/posts/${original.postId}/echo-settings`, { allowEchoes: 'nobody' })).status).toBe(404);
    expect((await as(t.app, ada).put(`/v1/posts/${original.postId}/echo-settings`, { allowEchoes: 'nobody' })).body).toEqual({ allowEchoes: 'nobody' });
    expect((await postEcho(bola, late)).status).toBe(403);
    expect((await as(t.app, cleo).get(`/v1/posts/${earlyPost.body.post.id}`)).status).toBe(200);
    expect((await as(t.app, bola).get(`/v1/posts/${original.postId}`)).body.post.viewer.canEcho).toBe(false);
  });

  it('defaults to nobody for private and under-18 accounts, and keeps adults and teens apart unless friends', async () => {
    const priv = await signUp(t.app);
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [priv.id]);
    const fan = await signUp(t.app);
    await t.ctx.db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [fan.id, priv.id]);
    const privReel = await reel(priv);
    expect((await as(t.app, fan).get(`/v1/posts/${privReel.postId}/echo`)).body).toMatchObject({ canEcho: false, reason: 'nobody' });

    const teen = await signUp(t.app, { birthDate: '2011-03-04' });
    const adult = await signUp(t.app);
    const friend = await signUp(t.app);
    // A teen who opens their account and allows everyone: still only friends among adults.
    await t.ctx.db.query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [teen.id]);
    const teenReel = await reel(teen);
    expect((await as(t.app, teen).get(`/v1/posts/${teenReel.postId}`)).body.post.allowEchoes).toBe('nobody');
    expect((await as(t.app, adult).get(`/v1/posts/${teenReel.postId}/echo`)).body.reason).toBe('nobody');
    await as(t.app, teen).put(`/v1/posts/${teenReel.postId}/echo-settings`, { allowEchoes: 'everyone' });
    expect((await as(t.app, adult).get(`/v1/posts/${teenReel.postId}/echo`)).body).toMatchObject({ canEcho: false, reason: 'nobody' });
    await befriend(teen, friend);
    expect((await as(t.app, friend).get(`/v1/posts/${teenReel.postId}/echo`)).body).toMatchObject({ canEcho: true });
  });

  it('stops at blocks, subscriber-only, sensitive reels and echoes', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const original = await reel(ada);
    await as(t.app, ada).post(`/v1/users/${bola.id}/block`);
    expect((await as(t.app, bola).get(`/v1/posts/${original.postId}/echo`)).status).toBe(404);
    const bolas = await video(bola);
    expect((await as(t.app, bola).post(`/v1/posts/${original.postId}/echoes`, { mediaId: bolas.id })).status).toBe(404);

    const cleo = await signUp(t.app);
    const forSubs = await reel(ada);
    await t.ctx.db.query(`UPDATE posts SET visibility = 'subscribers' WHERE id = $1`, [forSubs.postId]);
    expect((await as(t.app, cleo).get(`/v1/posts/${forSubs.postId}/echo`)).body).toMatchObject({ canEcho: false, reason: 'subscribers' });
    const sensitive = await reel(ada);
    await t.ctx.db.query(`UPDATE media SET moderation = 'sensitive' WHERE id = $1`, [sensitive.mediaId]);
    expect((await as(t.app, cleo).get(`/v1/posts/${sensitive.postId}/echo`)).body).toMatchObject({ canEcho: false, reason: 'sensitive' });

    const plain = await reel(ada);
    const echo = await makeEcho(cleo, plain.postId);
    const posted = await postEcho(cleo, echo);
    expect((await as(t.app, ada).get(`/v1/posts/${posted.body.post.id}/echo`)).body).toMatchObject({ canEcho: false, reason: 'echo' });
  });
});

describe('music in the original', () => {
  const songId = async (u: TestUser, q: string, title: string) => {
    const r = await as(t.app, u).get(`/v1/music?q=${encodeURIComponent(q)}`);
    const hit = (r.body.items as MusicTrack[]).find((i) => i.title === title);
    expect(hit, title).toBeTruthy();
    return hit!.id;
  };

  it('keeps their song only when its licence allows derivatives; otherwise only your audio, and says so', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const allowed = await reel(ada, { music: { trackId: await songId(ada, 'morning', '[Dev data] Morning tone'), startMs: 0, durationMs: 10_000 } });
    const refused = await reel(ada, { music: { trackId: await songId(ada, 'evening', '[Dev data] Evening tone'), startMs: 0, durationMs: 10_000 } });

    expect((await as(t.app, bola).get(`/v1/posts/${allowed.postId}/echo`)).body).toMatchObject({
      theirAudio: 'song',
      song: { title: '[Dev data] Morning tone' },
    });
    expect((await as(t.app, bola).get(`/v1/posts/${refused.postId}/echo`)).body.theirAudio).toBe('dropped');

    const withSong = await makeEcho(bola, allowed.postId);
    expect(withSong.theirAudio).toBe('song');
    const songPost = (await postEcho(bola, withSong)).body.post;
    expect(songPost.echoOf.theirAudio).toBe('song');
    expect(songPost.music).toMatchObject({ title: '[Dev data] Morning tone', startMs: 0, durationMs: 10_000 });

    const dropped = await makeEcho(bola, refused.postId);
    expect(dropped.theirAudio).toBe('dropped');
    const droppedPost = (await postEcho(bola, dropped)).body.post;
    expect(droppedPost.echoOf.theirAudio).toBe('dropped');
    expect(droppedPost.music ?? null).toBeNull();
    // Your audio is still there.
    expect((await probe(await storedFile(dropped.media.id))).hasAudio).toBe(true);
  });
});

describe('when the original goes', () => {
  it('hides echoes from everyone but their authors, who can keep them private or delete them', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const cleo = await signUp(t.app);
    const original = await reel(ada);
    const echo = await makeEcho(bola, original.postId);
    const post = (await postEcho(bola, echo)).body.post;
    expect((await as(t.app, cleo).get(`/v1/posts/${post.id}`)).status).toBe(200);
    expect((await as(t.app, cleo).get(`/v1/users/${bola.username}/posts`)).body.items.map((p: any) => p.id)).toContain(post.id);

    expect((await as(t.app, ada).del(`/v1/posts/${original.postId}`)).status).toBe(200);
    expect((await as(t.app, cleo).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, cleo).get(`/v1/users/${bola.username}/posts`)).body.items.map((p: any) => p.id)).not.toContain(post.id);
    const own = await as(t.app, bola).get(`/v1/posts/${post.id}`);
    expect(own.status).toBe(200);
    expect(own.body.post.echoOf).toMatchObject({ post: null });
    expect((await as(t.app, bola).patch(`/v1/posts/${post.id}`, { visibility: 'private' })).status).toBe(200);
    expect((await as(t.app, bola).del(`/v1/posts/${post.id}`)).status).toBe(200);
  });

  it("hides an echo when the original's creator blocks its maker, and from people who blocked the creator", async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const cleo = await signUp(t.app);
    const dayo = await signUp(t.app);
    const original = await reel(ada);
    const post = (await postEcho(bola, await makeEcho(bola, original.postId))).body.post;
    await as(t.app, dayo).post(`/v1/users/${ada.id}/block`);
    expect((await as(t.app, dayo).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, cleo).get(`/v1/posts/${post.id}`)).status).toBe(200);
    await as(t.app, ada).post(`/v1/users/${bola.id}/block`);
    expect((await as(t.app, cleo).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, bola).get(`/v1/posts/${post.id}`)).body.post.echoOf.post).toBeNull();
  });
});

describe('your data', () => {
  it('exports the echoes you made and deletes them with your account', async () => {
    const ada = await signUp(t.app);
    const bola = await signUp(t.app);
    const original = await reel(ada);
    const echo = await makeEcho(bola, original.postId, { layout: 'stack' });
    const post = (await postEcho(bola, echo)).body.post;
    const exported = await as(t.app, bola).get('/v1/me/export');
    expect(exported.status).toBe(200);
    expect(exported.body.echoes).toEqual([
      expect.objectContaining({ id: echo.id, original_post_id: original.postId, original_author: ada.username, post_id: post.id, layout: 'stack' }),
    ]);
    expect(exported.body.posts.find((p: any) => p.id === post.id)).toMatchObject({ is_echo: true, echo_of_post_id: original.postId });

    expect((await as(t.app, bola).del('/v1/me', { password: bola.password })).status).toBe(200);
    expect((await t.ctx.db.query(`SELECT 1 FROM echoes WHERE owner_id = $1`, [bola.id])).rowCount).toBe(0);
    expect((await as(t.app, ada).get(`/v1/posts/${original.postId}/echoes`)).body.items).toEqual([]);
  });
});
