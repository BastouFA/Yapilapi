import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJobs } from '../src/lib/jobs.ts';
import { mediaJobHandlers, probe } from '../src/lib/media-processing.ts';
import { studioJobHandlers } from '../src/lib/studio.ts';
import type { TranscriptionProvider } from '../src/lib/transcription.ts';
import { parseVtt, sanitizeCueText, serializeVtt, VttError } from '../src/lib/webvtt.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
let clip: Buffer;
beforeAll(async () => {
  t = await testApp();
  // A 6 second test video with sound, like the processing tests use.
  const dir = mkdtempSync(path.join(tmpdir(), 'ypl-studio-'));
  const src = path.join(dir, 'clip.mp4');
  const r = spawnSync(ffmpegPath as unknown as string, [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=24:duration=6',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    src,
  ]);
  expect(r.status).toBe(0);
  clip = readFileSync(src);
});
afterAll(async () => {
  t.ctx.transcription = null;
  await t.close();
});

const handlers = () => ({
  ...mediaJobHandlers({ db: t.ctx.db, storage: t.ctx.storage }),
  ...studioJobHandlers({ db: t.ctx.db, storage: t.ctx.storage, transcription: t.ctx.transcription }),
});

/** Run jobs until the queue has nothing due. */
async function drain() {
  for (let i = 0; i < 50; i++) if (!(await processJobs(t.ctx.db, handlers()))) return;
}

async function uploadVideo(owner: TestUser, processed = true) {
  const stored = await t.ctx.storage.put(clip, 'mp4', 'video/mp4');
  const { rows } = await t.ctx.db.query(`INSERT INTO media (owner_id, kind, url, mime, storage_key) VALUES ($1,'video',$2,'video/mp4',$3) RETURNING id`, [
    owner.id,
    stored.url,
    stored.key,
  ]);
  if (processed) {
    await t.ctx.db.query(`INSERT INTO jobs (kind, payload) VALUES ('media.process', $1)`, [{ mediaId: rows[0].id }]);
    await drain();
  }
  return rows[0].id as string;
}

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer | string }) {
  const boundary = `----ypl${Date.now()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function uploadVtt(user: TestUser, mediaId: string, lang: string, data: Buffer | string, label = 'English') {
  const body = multipart({ label }, { name: 'captions.vtt', type: 'text/vtt', data });
  const res = await t.app.inject({
    method: 'PUT',
    url: `/v1/media/${mediaId}/captions/${lang}/file`,
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${user.token}` },
  });
  return { status: res.statusCode, body: res.json() as any };
}

const GOOD_VTT = `WEBVTT - demo

NOTE this is ignored

STYLE
::cue { color: red }

intro
00:00.500 --> 00:02.000 align:center line:90% onclick:alert(1)
<v Ada>Hello <b>there</b></v> & welcome

00:00:02.500 --> 00:00:04.000
<script>alert(1)</script><img src=x onerror=alert(1)>
<i>Second</i> line
`;

describe('WebVTT validation', () => {
  it('parses good files and sanitizes cue text to cue tags only', () => {
    const cues = parseVtt(GOOD_VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0.5, end: 2, id: 'intro', settings: 'align:center line:90%' });
    expect(cues[0]!.text).toBe('<v Ada>Hello <b>there</b></v> &amp; welcome');
    expect(cues[1]!.text).toBe('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;\n<i>Second</i> line');
    const out = serializeVtt(cues);
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).not.toMatch(/<script|<img|STYLE|onclick/);
    // Serializing is stable.
    expect(serializeVtt(parseVtt(out))).toBe(out);
  });

  it('rejects files that are not well-formed WebVTT', () => {
    const bad = [
      '00:00.000 --> 00:01.000\nNo header',
      'WEBVTT\n00:00.000 --> 00:01.000\nNo blank line after the header',
      'WEBVTT\n\n00:00.000 -> 00:01.000\nWrong arrow',
      'WEBVTT\n\n00:00:61.000 --> 00:01:02.000\nSeconds out of range',
      'WEBVTT\n\n00:02.000 --> 00:01.000\nEnds before it starts',
      'WEBVTT\n\ncue-id\nno timing here',
      'WEBVTT\n\n00:00.000 --> 00:01.000\nOne\n00:01.000 --> 00:02.000\nMissing blank line',
      `WEBVTT\n\n${'00:00.000 --> 00:01.000\nx\n\n'.repeat(30_000)}`,
    ];
    for (const input of bad) expect(() => parseVtt(input), input.slice(0, 40)).toThrow(VttError);
  });

  it('escapes stray markup in editor text', () => {
    expect(sanitizeCueText('a < b > c')).toBe('a &lt; b &gt; c');
    expect(sanitizeCueText('<u>ok</u> <span>no</span> <c.yellow>hi</c>')).toBe('<u>ok</u> &lt;span&gt;no&lt;/span&gt; <c.yellow>hi</c>');
    expect(sanitizeCueText('Tom &amp; Jerry & co')).toBe('Tom &amp; Jerry &amp; co');
  });
});

describe('trim and clips', () => {
  it('renders a trimmed copy as a new, shorter, processed video', async () => {
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner);
    const source = (await t.ctx.db.query(`SELECT duration_ms FROM media WHERE id = $1`, [id])).rows[0];
    expect(source.duration_ms).toBeGreaterThanOrEqual(5900);

    const res = await as(t.app, owner).post(`/v1/media/${id}/edits`, { kind: 'trim', segments: [{ start: 1, end: 3.5 }] });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ kind: 'trim', start: 1, end: 3.5, status: 'queued', result: null });

    await drain();
    const list = await as(t.app, owner).get(`/v1/media/${id}/edits`);
    const edit = list.body.items[0];
    expect(edit.status).toBe('ready');
    expect(edit.result.id).not.toBe(id);
    expect(edit.result.durationMs).toBeGreaterThan(2000);
    expect(edit.result.durationMs).toBeLessThan(3000);
    expect(edit.result.posterUrl).toMatch(/_poster\.jpg$/);
    expect(edit.result.variants.mp4).toMatch(/_web\.mp4$/);
    expect(edit.result.hlsUrl).toMatch(/_hls\/index\.m3u8$/);

    // The rendered file really is shorter, and belongs to the same person.
    const m = (await t.ctx.db.query(`SELECT owner_id, storage_key FROM media WHERE id = $1`, [edit.result.id])).rows[0];
    expect(m.owner_id).toBe(owner.id);
    const dir = mkdtempSync(path.join(tmpdir(), 'ypl-studio-out-'));
    writeFileSync(path.join(dir, 'out.mp4'), await t.ctx.storage.read(m.storage_key));
    const info = await probe(path.join(dir, 'out.mp4'));
    expect(info.durationMs).toBeLessThan(source.duration_ms);
    expect(info.hasAudio).toBe(true);

    const mine = await as(t.app, owner).get('/v1/me/videos');
    expect(mine.body.items.find((v: any) => v.id === edit.result.id)).toMatchObject({ editOf: id, processed: true });
  }, 180_000);

  it('makes several clips in one request', async () => {
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner);
    const res = await as(t.app, owner).post(`/v1/media/${id}/edits`, {
      kind: 'clip',
      segments: [
        { start: 0, end: 1.5 },
        { start: 4, end: 6 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(2);
    await drain();
    const list = (await as(t.app, owner).get(`/v1/media/${id}/edits`)).body.items;
    expect(list.map((e: any) => e.status)).toEqual(['ready', 'ready']);
  }, 180_000);

  it('refuses people who do not own the video', async () => {
    const owner = await signUp(t.app);
    const other = await signUp(t.app);
    const id = await uploadVideo(owner, false);
    await t.ctx.db.query(`UPDATE media SET variants = '{"mp4":"x"}', duration_ms = 6000 WHERE id = $1`, [id]);
    expect((await as(t.app, other).post(`/v1/media/${id}/edits`, { kind: 'trim', segments: [{ start: 0, end: 2 }] })).status).toBe(404);
    expect((await as(t.app, other).get(`/v1/media/${id}/edits`)).status).toBe(404);
    expect((await as(t.app, null).post(`/v1/media/${id}/edits`, { kind: 'trim', segments: [{ start: 0, end: 2 }] })).status).toBe(401);
    expect((await as(t.app, other).put(`/v1/media/${id}/captions/en`, { label: 'English', cues: [] })).status).toBe(404);
    expect((await uploadVtt(other, id, 'en', GOOD_VTT)).status).toBe(404);
    expect((await as(t.app, other).del(`/v1/media/${id}/captions/en`)).status).toBe(404);
    expect((await t.ctx.db.query(`SELECT count(*)::int AS n FROM media_edits WHERE source_media_id = $1`, [id])).rows[0].n).toBe(0);
  });

  it('rejects invalid segments', async () => {
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner, false);
    const post = (b: object) => as(t.app, owner).post(`/v1/media/${id}/edits`, b);
    // Not processed yet.
    expect((await post({ kind: 'trim', segments: [{ start: 0, end: 2 }] })).status).toBe(409);
    await t.ctx.db.query(`UPDATE media SET variants = '{"mp4":"x"}', duration_ms = 6000 WHERE id = $1`, [id]);
    const cases: [object, string][] = [
      [{ kind: 'trim', segments: [{ start: 2, end: 1 }] }, 'segments.0'],
      [{ kind: 'trim', segments: [{ start: 1, end: 1.5 }] }, 'segments.0'],
      [{ kind: 'trim', segments: [{ start: 1, end: 9 }] }, 'segments.0'],
      [{ kind: 'trim', segments: [{ start: -1, end: 2 }] }, 'segments.0.start'],
      [{ kind: 'trim', segments: [] }, 'segments'],
      [
        {
          kind: 'trim',
          segments: [
            { start: 0, end: 2 },
            { start: 3, end: 5 },
          ],
        },
        'segments',
      ],
      [{ kind: 'clip', segments: Array.from({ length: 21 }, () => ({ start: 0, end: 2 })) }, 'segments'],
      [{ kind: 'crop', segments: [{ start: 0, end: 2 }] }, 'kind'],
    ];
    for (const [body, field] of cases) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(Object.keys(r.body.error.details.fields)).toContain(field);
    }
    // Longer than 10 minutes.
    await t.ctx.db.query(`UPDATE media SET duration_ms = 3600000 WHERE id = $1`, [id]);
    expect((await post({ kind: 'trim', segments: [{ start: 0, end: 601 }] })).body.error.details.fields['segments.0']).toMatch(/10 minutes/);
    expect((await t.ctx.db.query(`SELECT count(*)::int AS n FROM media_edits WHERE source_media_id = $1`, [id])).rows[0].n).toBe(0);
  });
});

describe('captions', () => {
  it('accepts a good .vtt upload, stores it sanitized and serves it as text/vtt', async () => {
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner, false);
    const res = await uploadVtt(owner, id, 'en', GOOD_VTT);
    expect(res.status).toBe(200);
    expect(res.body.track).toMatchObject({ lang: 'en', label: 'English', source: 'upload', status: 'ready', cueCount: 2 });
    const key = new URL(res.body.track.url).pathname.replace('/media/', '');
    expect(key).toMatch(/^captions\/.+\/en-[0-9a-f]{8}\.vtt$/);
    const stored = (await t.ctx.storage.read(key)).toString();
    expect(stored).not.toMatch(/<script|<img/);

    const served = await t.app.inject({ method: 'GET', url: `/media/${key}`, headers: { origin: 'http://localhost:3000' } });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toMatch(/^text\/vtt/);
    // Browsers load cross-origin <track> files only with CORS.
    expect(served.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const cues = await as(t.app, owner).get(`/v1/media/${id}/captions/en`);
    expect(cues.body.cues[0].text).toBe('<v Ada>Hello <b>there</b></v> & welcome');

    // Replacing writes a new file, so cached copies of the old one never go stale.
    const again = await uploadVtt(owner, id, 'en', 'WEBVTT\n\n00:01.000 --> 00:02.000\nReplaced\n');
    expect(again.body.track.url).not.toBe(res.body.track.url);
    expect(again.body.track.cueCount).toBe(1);
  });

  it('rejects bad .vtt uploads', async () => {
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner, false);
    const noHeader = await uploadVtt(owner, id, 'en', '1\n00:00:01,000 --> 00:00:02,000\nThis is SRT\n');
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error.code).toBe('invalid_vtt');
    const badTiming = await uploadVtt(owner, id, 'en', 'WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nComma\n');
    expect(badTiming.status).toBe(400);
    expect(badTiming.body.error.message).toMatch(/^Line 3:/);
    expect((await uploadVtt(owner, id, 'en', 'WEBVTT\n\nNOTE nothing\n')).body.error.message).toMatch(/no captions/);
    const huge = `WEBVTT\n\n00:00.000 --> 00:01.000\n${'a'.repeat(600 * 1024)}\n`;
    expect((await uploadVtt(owner, id, 'en', huge)).status).toBe(413);
    expect((await uploadVtt(owner, id, 'english', GOOD_VTT)).status).toBe(400);
    expect((await as(t.app, owner).get(`/v1/media/${id}/captions`)).body.items).toEqual([]);
  });

  it('saves captions from the editor and validates cues', async () => {
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner, false);
    const put = (b: object, lang = 'fr') => as(t.app, owner).put(`/v1/media/${id}/captions/${lang}`, b);
    expect((await put({ label: 'Français', cues: [{ start: 2, end: 1, text: 'x' }] })).status).toBe(400);
    expect((await put({ label: 'Français', cues: [{ start: 0, end: 1, text: '   ' }] })).status).toBe(400);
    expect((await put({ label: '', cues: [] })).status).toBe(400);
    const ok = await put({
      label: 'Français',
      cues: [
        { start: 3, end: 4.25, text: 'Deuxième' },
        { start: 0.5, end: 2, text: 'Bonjour <script>x</script> & <i>salut</i>' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.track).toMatchObject({ lang: 'fr', label: 'Français', source: 'manual', cueCount: 2 });
    const back = await as(t.app, owner).get(`/v1/media/${id}/captions/fr`);
    expect(back.body.cues).toEqual([
      { start: 0.5, end: 2, text: 'Bonjour <script>x</script> & <i>salut</i>' },
      { start: 3, end: 4.25, text: 'Deuxième' },
    ]);
    const file = (await t.ctx.storage.read(new URL(ok.body.track.url).pathname.replace('/media/', ''))).toString();
    expect(file).toContain('00:00:00.500 --> 00:00:02.000\nBonjour &lt;script&gt;x&lt;/script&gt; &amp; <i>salut</i>');
    expect((await as(t.app, owner).del(`/v1/media/${id}/captions/fr`)).status).toBe(200);
    expect((await as(t.app, owner).get(`/v1/media/${id}/captions/fr`)).status).toBe(404);
  });

  it('shows captions to whoever can see the video, following post visibility', async () => {
    const owner = await signUp(t.app);
    const follower = await signUp(t.app);
    const stranger = await signUp(t.app);
    await as(t.app, follower).post(`/v1/users/${owner.id}/follow`);
    const id = await uploadVideo(owner, false);
    await as(t.app, owner).put(`/v1/media/${id}/captions/en`, { label: 'English', cues: [{ start: 0, end: 1, text: 'Hi' }] });

    // Not attached to any post: only the owner sees it.
    expect((await as(t.app, owner).get(`/v1/media/${id}/captions`)).body.items).toHaveLength(1);
    expect((await as(t.app, stranger).get(`/v1/media/${id}/captions`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/media/${id}/captions`)).status).toBe(404);

    const post = await as(t.app, owner).post('/v1/posts', {
      body: 'Followers only',
      visibility: 'followers',
      media: [{ id, url: 'http://x.test/v.mp4', kind: 'video' }],
    });
    expect(post.status).toBe(201);
    expect(post.body.post.media[0].captions).toEqual([{ lang: 'en', label: 'English', url: expect.stringMatching(/\.vtt$/) }]);
    const seen = await as(t.app, follower).get(`/v1/media/${id}/captions`);
    expect(seen.status).toBe(200);
    expect(seen.body.items[0]).toMatchObject({ lang: 'en', status: 'ready', error: null });
    expect(seen.body.autoCaptions).toBeUndefined();
    expect((await as(t.app, follower).get(`/v1/media/${id}/captions/en`)).body.cues).toEqual([{ start: 0, end: 1, text: 'Hi' }]);
    expect((await as(t.app, stranger).get(`/v1/media/${id}/captions`)).status).toBe(404);
    expect((await as(t.app, stranger).get(`/v1/media/${id}/captions/en`)).status).toBe(404);

    await t.ctx.db.query(`UPDATE posts SET visibility = 'public' WHERE id = $1`, [post.body.post.id]);
    expect((await as(t.app, stranger).get(`/v1/media/${id}/captions`)).body.items).toHaveLength(1);
    expect((await as(t.app, null).get(`/v1/media/${id}/captions`)).status).toBe(200);
    // Seeing captions doesn't let you change them.
    expect((await as(t.app, stranger).put(`/v1/media/${id}/captions/en`, { label: 'Mine', cues: [] })).status).toBe(404);
  });
});

describe('automatic captions', () => {
  it('says the feature is not configured when no speech-to-text provider is set up', async () => {
    expect(t.ctx.transcription).toBeNull();
    const owner = await signUp(t.app);
    const id = await uploadVideo(owner, false);
    const res = await as(t.app, owner).post(`/v1/media/${id}/captions/transcribe`, { lang: 'en', label: 'English' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('not_configured');
    expect((await as(t.app, owner).get(`/v1/media/${id}/captions`)).body).toMatchObject({ items: [], autoCaptions: false });
    expect((await t.ctx.db.query(`SELECT count(*)::int AS n FROM caption_tracks WHERE media_id = $1`, [id])).rows[0].n).toBe(0);
  });

  it('stores what a configured provider returns, sanitized', async () => {
    // A stand-in provider for the test only; the app never ships one.
    const seen: { bytes: number; language?: string }[] = [];
    const provider: TranscriptionProvider = {
      name: 'test',
      async transcribe({ audio, language }) {
        seen.push({ bytes: audio.length, language });
        return 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nA tone <b>plays</b><script>x</script>\n';
      },
    };
    t.ctx.transcription = provider;
    try {
      const owner = await signUp(t.app);
      const id = await uploadVideo(owner);
      const res = await as(t.app, owner).post(`/v1/media/${id}/captions/transcribe`, { lang: 'en', label: 'English (automatic)' });
      expect(res.status).toBe(202);
      expect(res.body.track).toMatchObject({ status: 'processing', source: 'auto' });
      expect((await as(t.app, owner).post(`/v1/media/${id}/captions/transcribe`, { lang: 'en', label: 'Again' })).status).toBe(409);
      await drain();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.bytes).toBeGreaterThan(1000);
      const track = (await as(t.app, owner).get(`/v1/media/${id}/captions/en`)).body;
      expect(track.track).toMatchObject({ status: 'ready', source: 'auto', cueCount: 1 });
      expect(track.cues[0].text).toBe('A tone <b>plays</b><script>x</script>');
      const file = (await t.ctx.storage.read(new URL(track.track.url).pathname.replace('/media/', ''))).toString();
      expect(file).toContain('A tone <b>plays</b>&lt;script&gt;x&lt;/script&gt;');
    } finally {
      t.ctx.transcription = null;
    }
  }, 120_000);
});
