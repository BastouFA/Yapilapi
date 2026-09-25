import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJobs } from '../src/lib/jobs.ts';
import { liveRecordingJobHandlers, pickHighlights, recordingSegments } from '../src/lib/live-recording.ts';
import { mediaJobHandlers } from '../src/lib/media-processing.ts';
import { studioJobHandlers } from '../src/lib/studio.ts';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
  await t.ctx.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM feature_flags WHERE key = 'LIVE'`);
  await t.close();
});

describe('highlight picking', () => {
  it('picks the busiest windows, weights gifts and never overlaps', () => {
    const start = new Date('2026-09-25T20:00:00Z');
    const at = (s: number) => new Date(start.getTime() + s * 1000);
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ({ at: at(95 + i), weight: 1 })), // busy at 1:30
      { at: at(200), weight: 5 }, // one gift at 3:20
      { at: at(400), weight: 1 }, // too quiet
      { at: at(-5), weight: 5 }, // before the recording
    ];
    const h = pickHighlights(events, start, 600_000);
    expect(h).toEqual([
      { startMs: 80_000, endMs: 120_000, score: 6 },
      { startMs: 170_000, endMs: 210_000, score: 5 },
    ]);
  });

  it('reads MediaMTX segment names in order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ypl-rec-'));
    const folder = path.join(dir, 'live', '00000000-0000-0000-0000-000000000001');
    mkdirSync(folder, { recursive: true });
    for (const n of ['2026-09-25_20-10-00-000000.mp4', '2026-09-25_20-00-00-500000.mp4', 'notes.txt']) spawnSync('touch', [path.join(folder, n)]);
    const segs = await recordingSegments(dir, '00000000-0000-0000-0000-000000000001');
    expect(segs.map((s) => s.startedAt.toISOString())).toEqual(['2026-09-25T20:00:00.500Z', '2026-09-25T20:10:00.000Z']);
  });
});

describe('live recording and auto-clips', () => {
  it('stores the recording for the host and cuts the busiest moment into a clip', async () => {
    const host = await signUp(t.app, { birthDate: '1990-01-01' });
    const fan = await signUp(t.app, { birthDate: '1990-01-01' });
    const live = (await as(t.app, host).post('/v1/live', { title: 'Studio session' })).body.live;
    await as(t.app, host).post(`/v1/live/${live.id}/start`);
    await as(t.app, fan).post(`/v1/live/${live.id}/join`);

    // A 50-second recording that "started" 60 seconds ago, as MediaMTX would name it.
    const dir = mkdtempSync(path.join(tmpdir(), 'ypl-rec-'));
    const folder = path.join(dir, 'live', live.id);
    mkdirSync(folder, { recursive: true });
    const started = new Date(Date.now() - 60_000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const name = `${started.getUTCFullYear()}-${p2(started.getUTCMonth() + 1)}-${p2(started.getUTCDate())}_${p2(started.getUTCHours())}-${p2(started.getUTCMinutes())}-${p2(started.getUTCSeconds())}-000000.mp4`;
    const r = spawnSync(ffmpegPath as unknown as string, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=15:duration=50',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=50',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path.join(folder, name),
    ]);
    expect(r.status).toBe(0);

    // Four messages about 35 seconds into the recording.
    for (let i = 0; i < 4; i++) {
      const m = await as(t.app, fan).post(`/v1/live/${live.id}/chat`, { body: `wow ${i}` });
      await t.ctx.db.query(`UPDATE live_chat SET created_at = $2 WHERE id = $1`, [m.body.message.id, new Date(started.getTime() + 35_000 + i * 1000)]);
    }
    await as(t.app, host).post(`/v1/live/${live.id}/end`);
    await t.ctx.db.query(`INSERT INTO jobs (kind, payload) VALUES ('live.recording', $1)`, [{ sessionId: live.id }]);

    const deps = { db: t.ctx.db, storage: t.ctx.storage };
    const handlers = {
      ...mediaJobHandlers(deps),
      ...studioJobHandlers({ ...deps, transcription: null }),
      ...liveRecordingJobHandlers({ ...deps, recordingsDir: dir }),
    };
    for (let i = 0; i < 6; i++) await processJobs(t.ctx.db, handlers);

    const clips = await as(t.app, host).get(`/v1/live/${live.id}/clips`);
    expect(clips.status).toBe(200);
    expect(clips.body.recording.status).toBe('ready');
    expect(clips.body.clips).toHaveLength(1);
    expect(clips.body.clips[0]).toMatchObject({ startMs: 20_000, status: 'ready' });
    expect(Math.abs(clips.body.clips[0].endMs - 50_000)).toBeLessThan(500); // end of the recording (audio padding adds a few ms)
    const media = await t.ctx.db.query(`SELECT owner_id, duration_ms FROM media WHERE id = $1`, [clips.body.clips[0].media.id]);
    expect(media.rows[0].owner_id).toBe(host.id);
    expect(Math.abs(media.rows[0].duration_ms - 30_000)).toBeLessThan(1500);
    expect((await as(t.app, fan).get(`/v1/live/${live.id}/clips`)).status).toBe(403);
  }, 120_000);
});
