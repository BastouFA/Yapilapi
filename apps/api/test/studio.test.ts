import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpeechProvider } from '@yapilapi/ai';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import { teenBirth } from './entity-helpers.js';
import { hasFfmpeg, upload } from './media-fixtures.js';
import { getMediaRuntime } from '../src/modules/media/index.js';
import { overrideStudioRuntime, publishDueStudioPosts } from '../src/modules/studio/index.js';

let t: TestApp;
let clip: Buffer | null = null;
beforeAll(async () => {
  t = await createTestApp();
  if (hasFfmpeg) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yl-studio-fixture-'));
    const f = path.join(dir, 'clip.mp4');
    // 6 s, 320x240, tone / 2 s of silence / tone: a known shape for silence detection and cuts.
    const r = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=10:duration=6',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(between(t,2,4),0,0.3*sin(2*PI*440*t))':s=8000:d=6",
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      '-y',
      f,
    ]);
    if (r.status === 0) clip = readFileSync(f);
    rmSync(dir, { recursive: true, force: true });
  }
});
afterAll(async () => {
  overrideStudioRuntime(t.ctx, { speech: undefined, assist: undefined, capabilities: undefined });
  await t.close();
});
const haveClip = () => clip !== null;
const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const n = async (q: string, p: unknown[] = []): Promise<number> =>
  Number((await sql(q, p)).rows[0].n);
const anon = () => new Client(t);
const auditN = (action: string, targetId?: string) =>
  n(
    `SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND ($2::text IS NULL OR target_id::text = $2)`,
    [action, targetId ?? null],
  );
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A ready 6 s video row without touching ffmpeg (for tests about rules, not pixels). */
async function fakeVideo(
  owner: TestUser,
  over: { durationMs?: number; kind?: string; status?: string } = {},
): Promise<string> {
  const { rows } = await sql(
    `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose, duration_ms, width, height, checksum_sha256) VALUES ($1,$2,$3,$4,1000,$5,'attachment',$6,320,240,$7) RETURNING id`,
    [
      owner.id,
      over.kind ?? 'video',
      `test/${uniq('s')}.mp4`,
      over.kind === 'audio' ? 'audio/mp4' : 'video/mp4',
      over.status ?? 'ready',
      over.durationMs ?? 6000,
      uniq('sum'),
    ],
  );
  return rows[0].id;
}
/** The real clip through the real upload pipeline. */
async function realVideo(owner: TestUser): Promise<string> {
  const r = await upload(t, owner, clip!, { filename: 'clip.mp4', contentType: 'video/mp4' });
  if (r.status !== 201) throw new Error(`upload failed ${r.status} ${JSON.stringify(r.body)}`);
  await getMediaRuntime(t.ctx).queue.idle();
  const m = (await sql('SELECT status, duration_ms FROM media WHERE id = $1', [r.body.id])).rows[0];
  if (m.status !== 'ready') throw new Error(`clip not ready: ${m.status}`);
  return r.body.id;
}
async function mkProject(
  u: TestUser,
  mediaId: string,
  over: Record<string, unknown> = {},
): Promise<any> {
  const r = await u.client.post('/v1/studio/projects', {
    title: `Cut ${uniq('p')}`,
    mediaId,
    ...over,
  });
  if (r.status !== 201) throw new Error(`project failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const putEdl = (u: TestUser, id: string, edl: unknown, expectedVersion?: number) =>
  u.client.put(`/v1/studio/projects/${id}/edl`, {
    edl,
    ...(expectedVersion ? { expectedVersion } : {}),
  });
const edl = (over: Record<string, unknown> = {}) => ({
  version: 1,
  segments: [],
  aspect: null,
  thumbnail: null,
  captions: null,
  ...over,
});
const grantAi = (u: TestUser) =>
  u.client.put('/v1/privacy/consents/ai_processing', { granted: true });
const mediaRow = async (id: string) =>
  (
    await sql(
      'SELECT status, kind, width, height, duration_ms, size_bytes, checksum_sha256, variants, captions FROM media WHERE id = $1',
      [id],
    )
  ).rows[0];
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

// ================================================================== projects and ownership
describe('projects', () => {
  it('are created from OWN ready video/audio only, listed privately, and hidden from everyone else', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const media = await fakeVideo(a);
    expect((await anon().post('/v1/studio/projects', { title: 'x', mediaId: media })).status).toBe(
      401,
    );
    expect(
      (await b.client.post('/v1/studio/projects', { title: 'stolen', mediaId: media })).status,
    ).toBe(404); // someone else's file looks missing
    expect(
      (await a.client.post('/v1/studio/projects', { title: 'x', mediaId: 'nope' })).status,
    ).toBe(400);
    const img = (
      await sql(
        `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, status, purpose) VALUES ($1,'image',$2,'image/jpeg',10,'ready','attachment') RETURNING id`,
        [a.id, `test/${uniq('i')}.jpg`],
      )
    ).rows[0].id;
    expect((await a.client.post('/v1/studio/projects', { title: 'x', mediaId: img })).status).toBe(
      422,
    );
    expect(
      (
        await a.client.post('/v1/studio/projects', {
          title: 'x',
          mediaId: await fakeVideo(a, { status: 'processing' }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await a.client.post('/v1/studio/projects', { title: 'x'.repeat(200), mediaId: media }))
        .status,
    ).toBe(400);

    const p = await mkProject(a, media, { title: '  My first cut  ' });
    expect(p).toMatchObject({
      title: 'My first cut',
      status: 'draft',
      mediaId: media,
      rendered: false,
      edlVersion: 1,
    });
    expect(p.edl).toEqual(edl());
    expect((await a.client.get('/v1/studio/projects')).body.items.map((x: any) => x.id)).toEqual([
      p.id,
    ]);
    expect((await b.client.get('/v1/studio/projects')).body.items).toEqual([]);
    for (const [m, url, body] of [
      ['GET', ''],
      ['PATCH', '', { title: 'hijack' }],
      ['DELETE', ''],
      ['PUT', '/edl', { edl: edl() }],
      ['GET', '/captions'],
      ['GET', '/suggestions'],
      ['GET', '/publication'],
      ['POST', '/render'],
      ['POST', '/transcribe'],
      ['POST', '/publish', { confirm: true }],
    ] as Array<[string, string, unknown?]>) {
      const r = await b.client.request(
        m as 'GET',
        `/v1/studio/projects/${p.id}${url}`,
        body === undefined ? {} : { body },
      );
      expect(r.status, `${m} ${url}`).toBe(404);
    }
    const patched = await a.client.patch(`/v1/studio/projects/${p.id}`, {
      title: 'Renamed',
      description: 'notes',
    });
    expect(patched.body).toMatchObject({ title: 'Renamed', description: 'notes' });
    expect((await a.client.patch(`/v1/studio/projects/${p.id}`, {})).status).toBe(400);
    expect((await a.client.del(`/v1/studio/projects/${p.id}`)).status).toBe(204);
    expect((await a.client.get(`/v1/studio/projects/${p.id}`)).status).toBe(404);
    expect((await mediaRow(media)).status).toBe('ready'); // the media survives its project
    expect(await auditN('studio.project_created', p.id)).toBe(1);
  });

  it('refuses risky text in titles', async () => {
    const a = await signup(t);
    const r = await a.client.post('/v1/studio/projects', {
      title: 'I will kill you tomorrow',
      mediaId: await fakeVideo(a),
    });
    expect(r.status).toBe(422);
  });

  it('reports what the server can do, honestly', async () => {
    const a = await signup(t);
    const s = await a.client.get('/v1/studio/status');
    expect(s.status).toBe(200);
    expect(s.body.render.available).toBe(hasFfmpeg);
    expect(s.body.speech.available).toBe(false);
    expect((await anon().get('/v1/studio/status')).status).toBe(401);
  });
});

// ================================================================== EDL
describe('edit decision list', () => {
  it('validates against the media, versions edits, and never touches the source', async () => {
    const a = await signup(t);
    const media = await fakeVideo(a, { durationMs: 6000 });
    const before = await mediaRow(media);
    const p = await mkProject(a, media);
    const ok = await putEdl(
      a,
      p.id,
      edl({
        segments: [
          { startMs: 500, endMs: 2000 },
          { startMs: 4000, endMs: 5500 },
        ],
        aspect: '9:16',
        cropX: 0.25,
        thumbnail: { atMs: 100 },
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.edlVersion).toBe(2);
    expect(ok.body.edl.aspect).toBe('9:16');
    for (const [bad, msg] of [
      [edl({ segments: [{ startMs: 0, endMs: 7000 }] }), /only 6000 ms/],
      [
        edl({
          segments: [
            { startMs: 3000, endMs: 4000 },
            { startMs: 1000, endMs: 2000 },
          ],
        }),
        /order/,
      ],
      [edl({ segments: [{ startMs: 0, endMs: 100 }] }), /at least 200/],
      [edl({ cropX: 0.5 }), /aspect/],
      [edl({ thumbnail: { atMs: 9000 } }), /after the end/],
    ] as Array<[unknown, RegExp]>) {
      const r = await putEdl(a, p.id, bad);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(msg);
    }
    expect((await putEdl(a, p.id, { version: 1, segments: 'nope' })).status).toBe(400);
    expect((await putEdl(a, p.id, edl({ captions: { lang: 'en', burnIn: false } }))).status).toBe(
      400,
    ); // no such track yet
    expect((await putEdl(a, p.id, edl(), 1)).status).toBe(409); // stale version
    expect(
      (await putEdl(a, p.id, edl({ segments: [{ startMs: 0, endMs: 3000 }] }), 2)).body.edlVersion,
    ).toBe(3);
    expect(await mediaRow(media)).toEqual(before); // non-destructive
    expect(await auditN('studio.edl_updated', p.id)).toBe(2);

    const v = await a.client.post('/v1/studio/edl/validate', {
      edl: edl({ segments: [{ startMs: 0, endMs: 9000 }] }),
      durationMs: 6000,
    });
    expect(v.body.valid).toBe(false);
    expect(v.body.issues[0].message).toMatch(/only 6000/);
    expect(
      (await a.client.post('/v1/studio/edl/validate', { edl: edl(), durationMs: 6000 })).body.valid,
    ).toBe(true);
    expect(
      (
        await a.client.post('/v1/studio/edl/validate', {
          edl: edl({ aspect: '1:1' }),
          durationMs: 6000,
          kind: 'audio',
        })
      ).body.valid,
    ).toBe(false);
  });

  it('audio projects reject video-only operations', async () => {
    const a = await signup(t);
    const p = await mkProject(a, await fakeVideo(a, { kind: 'audio' }));
    expect((await putEdl(a, p.id, edl({ aspect: '1:1' }))).status).toBe(400);
    expect((await putEdl(a, p.id, edl({ segments: [{ startMs: 0, endMs: 2000 }] }))).status).toBe(
      200,
    );
  });
});

// ================================================================== captions
describe('captions', () => {
  const VTT =
    'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello\n\n00:00:04.000 --> 00:00:05.500\nWorld <b>again</b>\n';
  const SRT =
    '1\n00:00:00,500 --> 00:00:02,000\nHello\n\n2\n00:00:04,000 --> 00:00:05,500\nWorld again\n';

  it('are typed, imported (WebVTT/SRT), validated with useful errors, exported and deleted', async () => {
    const a = await signup(t);
    const p = await mkProject(a, await fakeVideo(a));
    const url = `/v1/studio/projects/${p.id}/captions`;
    const manual = await a.client.put(`${url}/en`, {
      cues: [
        { startMs: 500, endMs: 2000, text: 'Hello' },
        { startMs: 4000, endMs: 5500, text: 'World again' },
      ],
    });
    expect(manual.body).toMatchObject({ lang: 'en', kind: 'captions', source: 'manual', cues: 2 });
    expect(
      (await a.client.put(`${url}/pt-BR`, { vtt: VTT, label: 'Português' })).body,
    ).toMatchObject({ lang: 'pt-br', source: 'imported', cues: 2 });
    expect((await a.client.put(`${url}/es`, { srt: SRT, kind: 'subtitles' })).body).toMatchObject({
      lang: 'es',
      kind: 'subtitles',
      cues: 2,
    });
    const vtt = await a.client.request('GET', `${url}/en`, { query: { format: 'vtt' } });
    expect(vtt.headers['content-type']).toMatch(/text\/vtt/);
    expect(vtt.body).toContain('00:00:04.000 --> 00:00:05.500');
    expect(
      String((await a.client.request('GET', `${url}/en`, { query: { format: 'srt' } })).body),
    ).toContain('00:00:04,000 --> 00:00:05,500');
    expect((await a.client.get(`${url}/en`)).body.cuesList).toHaveLength(2);
    expect((await a.client.get(url)).body.items.map((x: any) => x.lang)).toEqual([
      'en',
      'es',
      'pt-br',
    ]);

    const badVtt = await a.client.put(`${url}/en`, {
      vtt: 'WEBVTT\n\n00:00:03.000 --> 00:00:02.000\nx',
    });
    expect(badVtt.status).toBe(400);
    expect(badVtt.body.error.message).toMatch(/end after/);
    expect((await a.client.put(`${url}/en`, { vtt: 'hello' })).status).toBe(400);
    expect((await a.client.put(`${url}/en`, { vtt: VTT, srt: SRT })).status).toBe(400); // exactly one input
    expect(
      (
        await a.client.put(`${url}/en`, {
          cues: [{ startMs: 5000, endMs: 9000, text: 'after the end' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await a.client.put(`${url}/en`, { cues: [{ startMs: 0, endMs: 1000, text: '  ' }] })).status,
    ).toBe(400);
    expect(
      (await a.client.put(`${url}/bad lang!`, { cues: [{ startMs: 0, endMs: 1000, text: 'x' }] }))
        .status,
    ).toBe(400);
    expect((await a.client.get(`${url}/en`)).body.cuesList).toHaveLength(2); // failed replaces changed nothing

    const v = await a.client.post('/v1/studio/captions/validate', {
      vtt: 'WEBVTT\n\n00:00:01.000 --> nonsense\nx',
    });
    expect(v.body).toMatchObject({ valid: false });
    expect(v.body.error).toMatch(/timing/);
    expect((await a.client.post('/v1/studio/captions/validate', { srt: SRT })).body).toMatchObject({
      valid: true,
      cues: 2,
    });

    // A track used by the edit cannot be deleted from under it.
    expect((await putEdl(a, p.id, edl({ captions: { lang: 'EN', burnIn: false } }))).status).toBe(
      200,
    );
    expect((await a.client.del(`${url}/en`)).status).toBe(409);
    expect((await a.client.del(`${url}/es`)).status).toBe(204);
    expect((await a.client.get(`${url}/es`)).status).toBe(404);
  });

  it('screens caption text like any user text', async () => {
    const a = await signup(t);
    const p = await mkProject(a, await fakeVideo(a));
    const r = await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
      cues: [{ startMs: 0, endMs: 1500, text: 'I will kill you tomorrow' }],
    });
    expect(r.status).toBe(422);
  });
});

describe('transcription', () => {
  it('is 501 feature_disabled without a speech provider (after the ownership check), and never invents a transcript', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const p = await mkProject(a, await fakeVideo(a));
    const r = await a.client.post(`/v1/studio/projects/${p.id}/transcribe`, {});
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('feature_disabled');
    expect((await b.client.post(`/v1/studio/projects/${p.id}/transcribe`, {})).status).toBe(404);
    expect((await a.client.get(`/v1/studio/projects/${p.id}/captions`)).body.items).toEqual([]);
  });

  it('with a provider it needs AI consent and produces an editable track', async () => {
    const a = await signup(t);
    const media = await fakeVideo(a);
    const p = await mkProject(a, media);
    const seen: string[] = [];
    const provider: SpeechProvider = {
      name: 'test-speech',
      transcribe: async (i) => {
        seen.push(i.mediaId);
        return {
          language: 'en',
          text: 'hi there',
          provider: 'test-speech',
          segments: [
            { startMs: 200, endMs: 1800, text: 'hi there' },
            { startMs: 2500, endMs: 3500, text: '  ' },
          ],
        };
      },
      translate: async () => {
        throw new Error('unused');
      },
    };
    overrideStudioRuntime(t.ctx, { speech: provider });
    try {
      expect((await a.client.get('/v1/studio/status')).body.speech.available).toBe(true);
      const denied = await a.client.post(`/v1/studio/projects/${p.id}/transcribe`, {});
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.reason).toBe('consent_required');
      await grantAi(a);
      const ok = await a.client.post(`/v1/studio/projects/${p.id}/transcribe`, { language: 'en' });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({ lang: 'en', source: 'speech', cues: 1 });
      expect(seen).toEqual([media]);
      expect(
        (
          await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
            cues: [{ startMs: 200, endMs: 1800, text: 'hi there, edited' }],
          })
        ).body.source,
      ).toBe('manual'); // editable
    } finally {
      overrideStudioRuntime(t.ctx, { speech: undefined });
    }
  });
});

// ================================================================== suggestions
describe('suggestions', () => {
  it.skipIf(!hasFfmpeg)(
    'find silence with ffmpeg, propose cuts/clips/thumbnails, and apply nothing until the creator accepts',
    async () => {
      if (!haveClip()) return;
      const a = await signup(t);
      const p = await mkProject(a, await realVideo(a));
      const posts = await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id]);
      const r = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
        kinds: ['silence_cuts', 'highlights', 'thumbnail'],
      });
      expect(r.status).toBe(201);
      expect(r.body.skipped).toEqual([]);
      const by = Object.fromEntries(r.body.items.map((s: any) => [s.kind, s]));
      expect(by.silence_cuts).toMatchObject({
        source: 'ffmpeg',
        status: 'suggested',
        appliedAutomatically: false,
      });
      const cut = by.silence_cuts.payload.cuts[0];
      expect(cut.startMs).toBeGreaterThanOrEqual(2000);
      expect(cut.endMs).toBeLessThanOrEqual(4100);
      expect(by.highlights.payload.clips.length).toBeGreaterThan(0);
      for (const m of by.thumbnail.payload.momentsMs) expect(m < 2000 || m >= 4000).toBe(true);
      // Untouched until accepted.
      expect((await a.client.get(`/v1/studio/projects/${p.id}`)).body.edl.segments).toEqual([]);
      expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(
        posts,
      );

      const b = await signup(t);
      expect(
        (
          await b.client.post(
            `/v1/studio/projects/${p.id}/suggestions/${by.silence_cuts.id}/accept`,
            {},
          )
        ).status,
      ).toBe(404);
      const acc = await a.client.post(
        `/v1/studio/projects/${p.id}/suggestions/${by.silence_cuts.id}/accept`,
        {},
      );
      expect(acc.status).toBe(200);
      expect(acc.body.edl.segments).toHaveLength(2);
      expect(acc.body.edl.segments[0].startMs).toBe(0);
      expect(acc.body.edl.segments[1].endMs).toBe(6000);
      expect(acc.body.status).toBe('draft');
      expect(
        (
          await a.client.post(
            `/v1/studio/projects/${p.id}/suggestions/${by.silence_cuts.id}/accept`,
            {},
          )
        ).status,
      ).toBe(409); // decided once
      expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(
        posts,
      ); // accepting never publishes
      const thumb = await a.client.post(
        `/v1/studio/projects/${p.id}/suggestions/${by.thumbnail.id}/accept`,
        { index: 0 },
      );
      expect(thumb.body.edl.thumbnail.atMs).toBeGreaterThanOrEqual(0);
      const dis = await a.client.post(
        `/v1/studio/projects/${p.id}/suggestions/${by.highlights.id}/dismiss`,
      );
      expect(dis.body.status).toBe('dismissed');
      // Asking again replaces the open proposal of the same kind.
      await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, { kinds: ['highlights'] });
      await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, { kinds: ['highlights'] });
      expect(
        await n(
          `SELECT count(*)::int AS n FROM studio_suggestions WHERE project_id = $1 AND kind = 'highlights' AND status = 'suggested'`,
          [p.id],
        ),
      ).toBe(1);
    },
  );

  it('say so when the tools are missing instead of guessing', async () => {
    const a = await signup(t);
    const p = await mkProject(a, await fakeVideo(a));
    overrideStudioRuntime(t.ctx, {
      capabilities: { available: false, libx264: false, aac: false, subtitles: false },
    });
    try {
      const r = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
        kinds: ['silence_cuts', 'thumbnail'],
      });
      expect(r.status).toBe(201);
      expect(r.body.items).toEqual([]);
      expect(r.body.skipped.map((s: any) => `${s.kind}:${s.reason}`)).toEqual([
        'silence_cuts:processing_unavailable',
        'thumbnail:processing_unavailable',
      ]);
    } finally {
      overrideStudioRuntime(t.ctx, { capabilities: undefined });
    }
  });

  it('review captions with heuristics; nothing to apply', async () => {
    const a = await signup(t);
    const p = await mkProject(a, await fakeVideo(a));
    const none = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
      kinds: ['captions_review'],
    });
    expect(none.body.skipped[0]).toMatchObject({ kind: 'captions_review', reason: 'no_captions' });
    await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
      cues: [
        { startMs: 0, endMs: 900, text: 'x'.repeat(60) },
        { startMs: 1000, endMs: 3000, text: 'A perfectly fine line' },
      ],
    });
    const r = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
      kinds: ['captions_review'],
    });
    const s = r.body.items[0];
    expect(s.source).toBe('heuristic');
    expect(s.payload.findings.map((f: any) => f.code)).toEqual(
      expect.arrayContaining(['too_fast', 'too_long_line']),
    );
    expect(
      (await a.client.post(`/v1/studio/projects/${p.id}/suggestions/${s.id}/accept`, {})).status,
    ).toBe(422);
  });

  it('AI titles and descriptions need consent, come from the AI module, and are applied only by the creator (recorded as AI assistance)', async () => {
    const a = await signup(t);
    const p = await mkProject(a, await fakeVideo(a), { title: 'Sunset over the harbour' });
    const noConsent = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
      kinds: ['title', 'description'],
    });
    expect(noConsent.body.items).toEqual([]);
    expect(noConsent.body.skipped.map((s: any) => s.reason)).toEqual([
      'consent_required',
      'consent_required',
    ]);
    await grantAi(a);
    const r = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
      kinds: ['title', 'description'],
    });
    expect(r.status).toBe(201);
    expect(r.body.skipped).toEqual([]);
    const by = Object.fromEntries(r.body.items.map((s: any) => [s.kind, s]));
    expect(by.title.source).toBe('ai_module');
    expect(by.title.payload.titles.length).toBeGreaterThan(0);
    expect(by.title.provider).toBeTruthy();
    expect(by.description.payload.text.length).toBeGreaterThan(0);
    expect((await a.client.get(`/v1/studio/projects/${p.id}`)).body.title).toBe(
      'Sunset over the harbour',
    );
    const posts = await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id]);
    const acc = await a.client.post(
      `/v1/studio/projects/${p.id}/suggestions/${by.title.id}/accept`,
      { index: 0 },
    );
    expect(acc.body.title).toBe(by.title.payload.titles[0].slice(0, 160));
    expect(acc.body.aiAssisted).toEqual(['studio_title']);
    const own = await a.client.post(
      `/v1/studio/projects/${p.id}/suggestions/${by.description.id}/accept`,
      { text: 'My own words instead' },
    );
    expect(own.body.description).toBe('My own words instead');
    expect(own.body.aiAssisted).toEqual(['studio_title', 'studio_description']);
    expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(
      posts,
    );
  });

  it('AI kinds answer 501-style skips when the AI module is off or absent, while the rest keeps working', async () => {
    const a = await signup(t);
    await grantAi(a);
    const p = await mkProject(a, await fakeVideo(a));
    await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
      cues: [{ startMs: 0, endMs: 2000, text: 'hello' }],
    });
    overrideStudioRuntime(t.ctx, { assist: null });
    try {
      const r = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, {
        kinds: ['title', 'captions_review'],
      });
      expect(r.body.skipped).toEqual([
        expect.objectContaining({ kind: 'title', reason: 'assist_unavailable' }),
      ]);
      expect(r.body.items.map((s: any) => s.kind)).toEqual(['captions_review']);
    } finally {
      overrideStudioRuntime(t.ctx, { assist: undefined });
    }
  });
});

// ================================================================== render
describe.skipIf(!hasFfmpeg)('render (ffmpeg)', () => {
  it('applies trim + cut + crop into a NEW media row, leaves the source untouched, and is idempotent per recipe', async () => {
    if (!haveClip()) return;
    const a = await signup(t);
    const srcId = await realVideo(a);
    const srcBefore = await mediaRow(srcId);
    const p = await mkProject(a, srcId);
    // Keep 0.5-2.0 s and 4.0-5.5 s (a 2 s silence cut out): 3.0 s output, cropped to portrait.
    await putEdl(
      a,
      p.id,
      edl({
        segments: [
          { startMs: 500, endMs: 2000 },
          { startMs: 4000, endMs: 5500 },
        ],
        aspect: '9:16',
        thumbnail: { atMs: 1000 },
      }),
    );
    const r = await a.client.post(`/v1/studio/projects/${p.id}/render`);
    expect(r.status).toBe(201);
    expect(r.body.job.status).toBe('succeeded');
    expect(r.body.project).toMatchObject({ status: 'ready', rendered: true });
    const out = await mediaRow(r.body.outputMediaId);
    expect(out.status).toBe('ready');
    expect(out.kind).toBe('video');
    expect(out.width).toBe(134);
    expect(out.height).toBe(240); // 9:16 window of 320x240, even sizes
    expect(Math.abs(Number(out.duration_ms) - 3000)).toBeLessThan(400);
    expect(out.variants.find((v: any) => v.name === 'poster')).toBeTruthy(); // the chosen thumbnail frame
    expect(r.body.outputMediaId).not.toBe(srcId);
    expect(await mediaRow(srcId)).toEqual(srcBefore); // non-destructive
    expect(
      (await sql('SELECT owner_id FROM media WHERE id = $1', [r.body.outputMediaId])).rows[0]
        .owner_id,
    ).toBe(a.id);

    const again = await a.client.post(`/v1/studio/projects/${p.id}/render`);
    expect(again.status).toBe(200);
    expect(again.body.reused).toBe(true);
    expect(again.body.outputMediaId).toBe(r.body.outputMediaId);
    expect(
      await n('SELECT count(*)::int AS n FROM studio_render_jobs WHERE project_id = $1', [p.id]),
    ).toBe(1);

    // Editing invalidates the render; the next render makes another output.
    const edited = await putEdl(a, p.id, edl({ segments: [{ startMs: 0, endMs: 1000 }] }));
    expect(edited.body).toMatchObject({ rendered: false, status: 'draft' });
    const second = await a.client.post(`/v1/studio/projects/${p.id}/render`);
    expect(second.status).toBe(201);
    expect(second.body.outputMediaId).not.toBe(r.body.outputMediaId);
    expect((await a.client.get(`/v1/studio/projects/${p.id}/renders`)).body.items).toHaveLength(2);
    expect(await auditN('studio.render_succeeded', p.id)).toBe(2);
  });

  it('burns captions in (re-timed to the cut timeline) and refuses when nothing changes or ffmpeg is unavailable', async () => {
    if (!haveClip()) return;
    const a = await signup(t);
    const p = await mkProject(a, await realVideo(a));
    expect((await a.client.post(`/v1/studio/projects/${p.id}/render`)).status).toBe(422); // identity edit: publish the original instead
    await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
      cues: [
        { startMs: 500, endMs: 1800, text: 'Hello there' },
        { startMs: 4200, endMs: 5400, text: 'Second half' },
      ],
    });
    await putEdl(
      a,
      p.id,
      edl({
        segments: [
          { startMs: 0, endMs: 2000 },
          { startMs: 4000, endMs: 6000 },
        ],
        captions: { lang: 'en', burnIn: true },
      }),
    );
    const r = await a.client.post(`/v1/studio/projects/${p.id}/render`);
    expect(r.status).toBe(201);
    const out = await mediaRow(r.body.outputMediaId);
    expect(out.status).toBe('ready');
    expect(Math.abs(Number(out.duration_ms) - 4000)).toBeLessThan(400);

    // Editing the captions after a burn-in render invalidates it.
    await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
      cues: [{ startMs: 500, endMs: 1800, text: 'Changed text' }],
    });
    expect((await a.client.get(`/v1/studio/projects/${p.id}`)).body).toMatchObject({
      rendered: false,
      status: 'draft',
    });

    overrideStudioRuntime(t.ctx, {
      capabilities: { available: false, libx264: false, aac: false, subtitles: false },
    });
    try {
      const un = await a.client.post(`/v1/studio/projects/${p.id}/render`);
      expect(un.status).toBe(503);
      expect(un.body.error.details.reason).toBe('processing_unavailable');
    } finally {
      overrideStudioRuntime(t.ctx, { capabilities: undefined });
    }
    overrideStudioRuntime(t.ctx, {
      capabilities: { available: true, libx264: true, aac: true, subtitles: false },
    });
    try {
      expect((await a.client.post(`/v1/studio/projects/${p.id}/render`)).status).toBe(503); // burn-in needs the subtitles filter
    } finally {
      overrideStudioRuntime(t.ctx, { capabilities: undefined });
    }
  });

  it('allows one render at a time per project and records failures without leaking ffmpeg output', async () => {
    if (!haveClip()) return;
    const a = await signup(t);
    const p = await mkProject(a, await realVideo(a));
    await putEdl(a, p.id, edl({ segments: [{ startMs: 0, endMs: 2000 }] }));
    await sql(
      `INSERT INTO studio_render_jobs (project_id, requested_by, edl_hash) VALUES ($1,$2,'x')`,
      [p.id, a.id],
    );
    const busy = await a.client.post(`/v1/studio/projects/${p.id}/render`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.details.reason).toBe('render_in_progress');
    await sql(`UPDATE studio_render_jobs SET status = 'failed' WHERE project_id = $1`, [p.id]);
    // The source disappears: the render is refused before any process starts.
    await sql(`UPDATE media SET deleted_at = now() WHERE id = $1`, [p.mediaId]);
    const gone = await a.client.post(`/v1/studio/projects/${p.id}/render`);
    expect(gone.status).toBe(409);
    expect(gone.body.error.details.reason).toBe('source_missing');
  });
});

// ================================================================== publish
describe('publishing is explicit', () => {
  const publish = (u: TestUser, id: string, body: Record<string, unknown> = {}) =>
    u.client.post(`/v1/studio/projects/${id}/publish`, {
      confirm: true,
      body: 'Look at this',
      visibility: 'public',
      ...body,
    });

  it('needs confirm:true, a rendered edit (or an unchanged original) and publishes exactly what was confirmed, with rights and AI provenance', async () => {
    const a = await signup(t);
    const media = await fakeVideo(a);
    const p = await mkProject(a, media);
    expect((await a.client.post(`/v1/studio/projects/${p.id}/publish`, { body: 'x' })).status).toBe(
      422,
    );
    const noConfirm = await a.client.post(`/v1/studio/projects/${p.id}/publish`, {
      confirm: false,
      body: 'x',
    });
    expect(noConfirm.body.error.details.reason).toBe('confirmation_required');
    expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(0);
    expect(
      (await anon().post(`/v1/studio/projects/${p.id}/publish`, { confirm: true })).status,
    ).toBe(401);

    // A changed edit that has not been rendered cannot be published.
    await putEdl(a, p.id, edl({ segments: [{ startMs: 0, endMs: 3000 }] }));
    const need = await publish(a, p.id);
    expect(need.status).toBe(409);
    expect(need.body.error.details.reason).toBe('render_required');
    await putEdl(a, p.id, edl());

    await grantAi(a);
    const s = await a.client.post(`/v1/studio/projects/${p.id}/suggestions`, { kinds: ['title'] });
    await a.client.post(`/v1/studio/projects/${p.id}/suggestions/${s.body.items[0].id}/accept`, {
      index: 0,
    });
    await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
      cues: [{ startMs: 0, endMs: 2000, text: 'Hello' }],
    });
    const ok = await publish(a, p.id, { license: 'cc_by', language: 'en' });
    expect(ok.status).toBe(201);
    const post = (await a.client.get(`/v1/posts/${ok.body.postId}`)).body;
    expect(post).toMatchObject({
      kind: 'video',
      body: 'Look at this',
      visibility: 'public',
      language: 'en',
      rights: { license: 'cc_by' },
    });
    expect(post.media.map((m: any) => m.id)).toEqual([media]);
    expect(post.aiProvenance).toMatchObject({
      generated: false,
      assisted: ['studio_title'],
      disclosed: true,
    });
    expect((await mediaRow(media)).captions.map((c: any) => c.lang)).toEqual(['en']); // the caption track travels with the media
    expect((await a.client.get(`/v1/studio/projects/${p.id}`)).body).toMatchObject({
      status: 'published',
      publishedPostId: ok.body.postId,
      publication: { status: 'published', mode: 'now' },
    });
    expect(await auditN('studio.published', ok.body.postId)).toBe(1);
    expect(await auditN('studio.publish_confirmed', p.id)).toBe(1);
    // The same media cannot be posted twice.
    expect((await publish(a, p.id)).status).toBe(400);
  });

  it('applies the normal publishing rules: teens cannot post publicly, risky text is refused', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    const p = await mkProject(teen, await fakeVideo(teen));
    const pub = await publish(teen, p.id, { visibility: 'public' });
    expect(pub.status).toBe(422);
    expect(
      (await sql('SELECT status FROM studio_publications WHERE project_id = $1', [p.id])).rows[0]
        .status,
    ).toBe('failed');
    const a = await signup(t);
    const p2 = await mkProject(a, await fakeVideo(a));
    const bad = await publish(a, p2.id, { body: 'I will kill you tomorrow' });
    expect(bad.status).toBe(201); // accepted like any post, but the normal screening keeps it out of public view
    expect(
      await n(
        'SELECT count(*)::int AS n FROM posts WHERE author_id = $1 AND deleted_at IS NULL AND moderation_status = $2',
        [a.id, 'approved'],
      ),
    ).toBe(0);
  });

  it('scheduled: stores the confirmation, validates timing, allows one at a time, cancels, and publishes exactly once when due', async () => {
    const a = await signup(t);
    const media = await fakeVideo(a);
    const p = await mkProject(a, media);
    expect((await publish(a, p.id, { mode: 'scheduled' })).status).toBe(400); // publishAt missing
    expect((await publish(a, p.id, { mode: 'scheduled', publishAt: inMinutes(1) })).status).toBe(
      400,
    ); // too soon
    expect(
      (await publish(a, p.id, { mode: 'scheduled', publishAt: inMinutes(60 * 24 * 120) })).status,
    ).toBe(400); // too far
    expect((await publish(a, p.id, { mode: 'now', publishAt: inMinutes(60) })).status).toBe(400);
    const at = inMinutes(60);
    const s = await publish(a, p.id, { mode: 'scheduled', publishAt: at });
    expect(s.status).toBe(202);
    expect(s.body).toMatchObject({
      postId: null,
      publication: { status: 'confirmed', mode: 'scheduled' },
    });
    expect((await publish(a, p.id, { mode: 'scheduled', publishAt: inMinutes(90) })).status).toBe(
      409,
    ); // one open confirmation per project
    // Not due yet: nothing happens.
    expect(await publishDueStudioPosts(t.ctx, { now: new Date() })).toMatchObject({ published: 0 });
    expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(0);
    // Cancel and re-schedule.
    expect((await a.client.del(`/v1/studio/projects/${p.id}/publication`)).body.status).toBe(
      'cancelled',
    );
    expect((await a.client.del(`/v1/studio/projects/${p.id}/publication`)).status).toBe(404);
    expect(
      await publishDueStudioPosts(t.ctx, { now: new Date(Date.now() + 2 * 3_600_000) }),
    ).toMatchObject({ published: 0 });
    const s2 = await publish(a, p.id, {
      mode: 'scheduled',
      publishAt: at,
      body: 'Scheduled hello',
    });
    const due = new Date(Date.now() + 2 * 3_600_000);
    const [r1, r2] = await Promise.all([
      publishDueStudioPosts(t.ctx, { now: due }),
      publishDueStudioPosts(t.ctx, { now: due }),
    ]);
    expect(r1.published + r2.published).toBe(1);
    expect(await publishDueStudioPosts(t.ctx, { now: due })).toMatchObject({ published: 0 });
    const pub = (await a.client.get(`/v1/studio/projects/${p.id}/publication`)).body.publication;
    expect(pub).toMatchObject({ id: s2.body.publication.id, status: 'published' });
    expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(1);
    expect((await a.client.get(`/v1/posts/${pub.postId}`)).body.body).toBe('Scheduled hello');
  });

  it('scheduled publishes only what was confirmed: edits, tampering, deleted media and inactive accounts stop it', async () => {
    const a = await signup(t);
    const at = inMinutes(30);
    const due = () => new Date(Date.now() + 3_600_000);
    const setup = async () => {
      const p = await mkProject(a, await fakeVideo(a));
      await publish(a, p.id, { mode: 'scheduled', publishAt: at });
      return p;
    };

    const edited = await setup();
    await putEdl(a, edited.id, edl({ segments: [{ startMs: 0, endMs: 2000 }] })); // the project changes after confirmation
    expect(
      (await a.client.get(`/v1/studio/projects/${edited.id}/publication`)).body.publication.status,
    ).toBe('stale');

    const retitled = await setup();
    await a.client.patch(`/v1/studio/projects/${retitled.id}`, { description: 'changed my mind' });
    expect(
      (await a.client.get(`/v1/studio/projects/${retitled.id}/publication`)).body.publication
        .status,
    ).toBe('stale');

    const captioned = await setup();
    await a.client.put(`/v1/studio/projects/${captioned.id}/captions/en`, {
      cues: [{ startMs: 0, endMs: 1000, text: 'late caption' }],
    });
    expect(
      (await a.client.get(`/v1/studio/projects/${captioned.id}/publication`)).body.publication
        .status,
    ).toBe('stale');

    const tampered = await setup();
    await sql(
      `UPDATE studio_publications SET post_input = jsonb_set(post_input, '{body}', '"something else entirely"') WHERE project_id = $1`,
      [tampered.id],
    );
    const gone = await setup();
    await sql(`UPDATE media SET deleted_at = now() WHERE id = $1`, [gone.mediaId]);

    const before = await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id]);
    const r = await publishDueStudioPosts(t.ctx, { now: due() });
    expect(r.published).toBe(0);
    expect(r.stale).toBe(2);
    expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [a.id])).toBe(
      before,
    );
    expect(
      (await sql('SELECT status FROM studio_publications WHERE project_id = $1', [tampered.id]))
        .rows[0].status,
    ).toBe('stale');
    expect(
      (await sql('SELECT status FROM studio_publications WHERE project_id = $1', [gone.id])).rows[0]
        .status,
    ).toBe('stale');

    // An account that is being deleted does not publish in its sleep.
    const u = await signup(t);
    const p = await mkProject(u, await fakeVideo(u));
    await publish(u, p.id, { mode: 'scheduled', publishAt: at });
    await sql(`UPDATE users SET status = 'pending_deletion' WHERE id = $1`, [u.id]);
    expect(await publishDueStudioPosts(t.ctx, { now: due() })).toMatchObject({
      published: 0,
      failed: 1,
    });
    expect(await n('SELECT count(*)::int AS n FROM posts WHERE author_id = $1', [u.id])).toBe(0);
    // Deleting the project also drops its scheduled publication.
    const d = await setup();
    expect((await a.client.del(`/v1/studio/projects/${d.id}`)).status).toBe(204);
    expect(
      (await sql('SELECT status FROM studio_publications WHERE project_id = $1', [d.id])).rows[0]
        .status,
    ).toBe('stale');
  });

  it.skipIf(!hasFfmpeg)(
    'publishes a rendered edit with re-timed sidecar captions; the original stays unpublished',
    async () => {
      if (!haveClip()) return;
      const a = await signup(t);
      const srcId = await realVideo(a);
      const p = await mkProject(a, srcId);
      await a.client.put(`/v1/studio/projects/${p.id}/captions/en`, {
        cues: [{ startMs: 4200, endMs: 5400, text: 'Second half' }],
      });
      await putEdl(a, p.id, edl({ segments: [{ startMs: 4000, endMs: 6000 }] }));
      const rn = await a.client.post(`/v1/studio/projects/${p.id}/render`);
      const ok = await publish(a, p.id);
      expect(ok.status).toBe(201);
      const post = (await a.client.get(`/v1/posts/${ok.body.postId}`)).body;
      expect(post.media.map((m: any) => m.id)).toEqual([rn.body.outputMediaId]);
      expect(
        await n('SELECT count(*)::int AS n FROM post_media WHERE media_id = $1', [srcId]),
      ).toBe(0);
      const cap = (await mediaRow(rn.body.outputMediaId)).captions;
      expect(cap).toHaveLength(1);
      const text = (await (await getMediaRuntime(t.ctx).adapter.read(cap[0].key)).toArray())
        .map((b: Buffer) => b.toString())
        .join('');
      expect(text).toContain('00:00:00.200 --> 00:00:01.400'); // 4.2 s in the source is 0.2 s in the 4-6 s cut
      expect(sha(clip!)).toBe((await mediaRow(srcId)).checksum_sha256);
    },
  );
});
