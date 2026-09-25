import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../lib/context.js';
import { AppError } from '@yapilapi/shared';
import { DEMUXER, materialise } from './render.js';
import { silenceDetectArgs } from './render-plan.js';
import { parseSilenceDetect, type Range } from './silence.js';
import type { SourceMedia } from './projects.js';
import { capabilities, processingUnavailable } from './runtime.js';

/** Like runBinary, but keeps ALL of stderr (up to 2 MB): silencedetect reports on stderr and a truncated log would invent a silence to the end. */
function runCapture(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxErr = 2 * 1024 * 1024,
): Promise<{ code: number | null; stderr: string; truncated: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let truncated = false;
    let done = false;
    const finish = (r: { code: number | null; stderr: string; truncated: boolean }) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stderr: err, truncated: true });
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < maxErr) err += d.toString();
      else truncated = true;
    });
    child.on('error', () => finish({ code: null, stderr: err, truncated }));
    child.on('close', (code) => finish({ code, stderr: err, truncated }));
  });
}

/** Silent stretches of the source audio (ffmpeg `silencedetect`). Refuses (503) when ffmpeg is missing; never guesses. */
export async function analyseSilence(
  ctx: AppContext,
  src: SourceMedia,
  o: { noiseDb?: number; minSilenceSec?: number } = {},
): Promise<Range[]> {
  const caps = await capabilities(ctx);
  if (!caps.available) throw processingUnavailable('Audio analysis');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yl-studio-a-'));
  try {
    const input = await materialise(ctx, src, dir);
    const r = await runCapture(
      ctx.config.MEDIA_FFMPEG_PATH,
      silenceDetectArgs(input, DEMUXER[src.mime_type], o.noiseDb, o.minSilenceSec),
      120_000,
    );
    if (r.code !== 0 || r.truncated)
      throw new AppError('unprocessable', 'The audio could not be analysed', {
        reason: 'analysis_failed',
      });
    return parseSilenceDetect(r.stderr, src.duration_ms);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
