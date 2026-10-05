import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ffmpegPath from '../src/lib/ffmpeg-path.ts';
import { studioJobHandlers } from '../src/lib/studio.ts';
import type { TranscriptionProvider } from '../src/lib/transcription.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, jobRunner, signUp, testApp, type JobRunner, type TestUser } from './helpers.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  t.ctx.transcription = null;
  await t.close();
});

const db = () => t.ctx.db;

/** A tone of the given length, as an M4A file. */
function tone(seconds: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-audio-post-'));
  try {
    const out = path.join(dir, 'tone.m4a');
    execFileSync(ffmpegPath as unknown as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      out,
    ]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function upload(u: TestUser, name: string, mime: string, data: Buffer) {
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
  expect(res.statusCode).toBe(201);
  return res.json().media as { id: string; url: string; kind: string };
}

/** A stored recording of a given length, as if uploaded (the upload measures the length). */
async function recording(owner: TestUser, durationMs: number): Promise<{ id: string; url: string }> {
  const { rows } = await db().query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'audio','http://localhost:4000/media/rec.m4a','audio/mp4','ready',$2) RETURNING id, url`,
    [owner.id, durationMs],
  );
  return rows[0];
}

const post = (u: TestUser, body: Record<string, unknown>) => as(t.app, u).post('/v1/posts', { visibility: 'public', ...body });

describe('audio posts', () => {
  it('a recording goes out as an audio post, whatever the app called it', async () => {
    const u = await signUp(t.app);
    const up = await upload(u, 'voice.m4a', 'audio/mp4', tone(2));
    expect(up.kind).toBe('audio');
    // The app says it's a photo; the stored file says otherwise.
    const r = await post(u, { body: '[Dev data] A voice note', media: [{ id: up.id, url: up.url, kind: 'image' }] });
    expect(r.status).toBe(201);
    expect(r.body.post.kind).toBe('audio');
    expect(r.body.post.media).toHaveLength(1);
    expect(r.body.post.media[0].kind).toBe('audio');
  });

  it('is a post on its own: not a reel, and without photos, videos, a poll or music', async () => {
    const u = await signUp(t.app);
    const rec = await recording(u, 20_000);
    const audio = { id: rec.id, url: rec.url, kind: 'audio' };
    const photo = await recording(u, 1); // any other stored item will do for the mix
    await db().query(`UPDATE media SET kind = 'image', duration_ms = NULL WHERE id = $1`, [photo.id]);

    expect((await post(u, { body: 'x', format: 'reel', media: [audio] })).status).toBe(400);
    // An app that calls the recording a video is told the same.
    const reel = await post(u, { body: 'x', format: 'reel', media: [{ ...audio, kind: 'video' }] });
    expect(reel.status).toBe(400);
    expect(reel.body.error.message).toBe('A reel is a video. Share a recording as a post.');
    const mixed = await post(u, { body: 'x', media: [audio, { id: photo.id, url: photo.url, kind: 'image' }] });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.message).toBe('A recording goes in a post on its own, without photos, videos or a poll.');
    const poll = await post(u, { body: 'x', media: [audio], poll: { options: ['Yes', 'No'] } });
    expect(poll.status).toBe(400);
    expect((await post(u, { body: 'x', media: [audio] })).status).toBe(201);
  });

  it('is between a second and 5 minutes, or 10 with Plus', async () => {
    const u = await signUp(t.app);
    const short = await recording(u, 400);
    const r1 = await post(u, { body: 'x', media: [{ ...short, kind: 'audio' }] });
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toBe('This recording is too short.');

    const six = await recording(u, 6 * 60_000);
    const r2 = await post(u, { body: 'x', media: [{ ...six, kind: 'audio' }] });
    expect(r2.status).toBe(400);
    expect(r2.body.error.message).toBe('Recordings can be up to 5 minutes, or 10 minutes with YAPILAPI Plus.');

    await db().query(`UPDATE profiles SET plus_until = now() + interval '1 day' WHERE user_id = $1`, [u.id]);
    expect((await post(u, { body: 'x', media: [{ ...six, kind: 'audio' }] })).status).toBe(201);
    const eleven = await recording(u, 11 * 60_000);
    const r3 = await post(u, { body: 'x', media: [{ ...eleven, kind: 'audio' }] });
    expect(r3.status).toBe(400);
    expect(r3.body.error.message).toBe('Recordings can be up to 10 minutes.');
  });

  it('gets a transcript in its author’s language when speech-to-text is set up, shown with the post', async () => {
    const heard: { language?: string }[] = [];
    const fake: TranscriptionProvider = {
      name: 'fake',
      async transcribe(input) {
        heard.push({ language: input.language });
        return 'WEBVTT\n\n00:00.000 --> 00:01.500\nBonjour à tous\n';
      },
    };
    const u = await signUp(t.app);
    await db().query(`UPDATE profiles SET locale = 'fr' WHERE user_id = $1`, [u.id]);
    const up = await upload(u, 'voice.m4a', 'audio/mp4', tone(2));

    // Without a provider nothing is queued.
    t.ctx.transcription = null;
    const quiet = await post(u, { body: 'x', media: [{ id: up.id, url: up.url, kind: 'audio' }] });
    expect(quiet.status).toBe(201);
    expect((await db().query(`SELECT 1 FROM caption_tracks WHERE media_id = $1`, [up.id])).rowCount).toBe(0);

    t.ctx.transcription = fake;
    const up2 = await upload(u, 'voice2.m4a', 'audio/mp4', tone(2));
    const r = await post(u, { body: 'x', media: [{ id: up2.id, url: up2.url, kind: 'audio' }] });
    expect(r.status).toBe(201);
    const handlers = studioJobHandlers({ db: db(), storage: t.ctx.storage, transcription: fake });
    for (let i = 0; i < 20; i++) if (!(await runJobs(handlers))) break;
    expect(heard).toEqual([{ language: 'fr' }]);

    const shown = (await as(t.app, await signUp(t.app)).get(`/v1/posts/${r.body.post.id}`)).body.post;
    expect(shown.media[0].captions).toEqual([expect.objectContaining({ lang: 'fr', label: 'Français' })]);
    // The author can change the transcript, as with a video's captions.
    const edit = await as(t.app, u).put(`/v1/media/${up2.id}/captions/fr`, {
      label: 'Français',
      cues: [{ start: 0, end: 1.5, text: 'Bonjour à toutes et à tous' }],
    });
    expect(edit.status).toBe(200);
    t.ctx.transcription = null;
  });
});
