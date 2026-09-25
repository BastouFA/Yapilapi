import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { withTransaction } from '@yapilapi/database';
import { AppError, conflict } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { runBinary } from '../media/processor.js';
import { processMedia } from '../media/pipeline.js';
import { getMediaRuntime } from '../media/runtime.js';
import { SIMPLE_UPLOAD_MAX_BYTES, sniffMedia, SNIFF_BYTES } from '../media/sniff.js';
import { hasLocalPath, newObjectKey } from '../media/storage.js';
import { toSrt } from './captions.js';
import { edlHash, isIdentity, outputDurationMs, remapCues, validateEdl } from './edl.js';
import {
  getTrack,
  loadProject,
  loadSource,
  staleOpenPublication,
  type ProjectRow,
  type SourceMedia,
} from './projects.js';
import { buildRenderArgs, thumbnailArgs, type SourceProbe } from './render-plan.js';
import { capabilities, processingUnavailable } from './runtime.js';

/** Sources longer than this are refused: rendering is synchronous inside the request (a queue/worker is the documented next step). */
export const MAX_RENDER_SOURCE_MS = 10 * 60_000;
const RENDER_TIMEOUT_MS = 4 * 60_000;
const STALE_JOB_MS = 15 * 60_000;

export const DEMUXER: Record<string, string> = {
  'video/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/quicktime': 'mov,mp4,m4a,3gp,3g2,mj2',
  'audio/mp4': 'mov,mp4,m4a,3gp,3g2,mj2',
  'video/webm': 'matroska,webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/** Make the stored source available as a local file (the local adapter serves its own path; S3 is downloaded into the job's temp dir). */
export async function materialise(
  ctx: AppContext,
  src: Pick<SourceMedia, 'storage_key'>,
  dir: string,
): Promise<string> {
  const rt = getMediaRuntime(ctx);
  if (hasLocalPath(rt.adapter)) return rt.adapter.localPath(src.storage_key);
  const p = path.join(dir, 'source');
  await pipeline(await rt.adapter.read(src.storage_key), createWriteStream(p));
  return p;
}

interface ProbeJson {
  streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  format?: { duration?: string };
}
export async function probeSource(
  ctx: AppContext,
  file: string,
  demuxer: string | undefined,
  durationMs: number,
): Promise<SourceProbe> {
  const r = await runBinary(
    ctx.config.MEDIA_FFPROBE_PATH,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-protocol_whitelist',
      'file',
      ...(demuxer ? ['-f', demuxer] : []),
      '-i',
      file,
    ],
    60_000,
  );
  if (r.code !== 0)
    throw new AppError('unprocessable', 'The source media could not be decoded', {
      reason: 'source_undecodable',
    });
  const info = JSON.parse(r.stdout.toString('utf8')) as ProbeJson;
  const v = info.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
  return {
    durationMs,
    width: v?.width ?? null,
    height: v?.height ?? null,
    hasVideo: Boolean(v),
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === 'audio')),
  };
}

export interface RenderJobRow {
  id: string;
  project_id: string;
  edl_hash: string;
  status: 'running' | 'succeeded' | 'failed';
  error_code: string | null;
  output_media_id: string | null;
  started_at: Date;
  finished_at: Date | null;
}
export const jobView = (j: RenderJobRow) => ({
  id: j.id,
  status: j.status,
  edlHash: j.edl_hash,
  errorCode: j.error_code,
  outputMediaId: j.output_media_id,
  startedAt: j.started_at.toISOString(),
  finishedAt: j.finished_at?.toISOString() ?? null,
});
const JOB_COLS =
  'id, project_id, edl_hash, status, error_code, output_media_id, started_at, finished_at';

export async function listRenders(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
): Promise<RenderJobRow[]> {
  await loadProject(ctx.db, projectId, auth.userId);
  return (
    await ctx.db.query<RenderJobRow>(
      `SELECT ${JOB_COLS} FROM studio_render_jobs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [projectId],
    )
  ).rows;
}

/** Register a rendered file as a NEW media row of the owner (quota, sniffing and processing exactly like an upload), processed synchronously. */
async function registerOutput(
  ctx: AppContext,
  ownerId: string,
  file: string,
  poster: string | null,
): Promise<string> {
  const size = (await stat(file)).size;
  if (size <= 0)
    throw new AppError('unprocessable', 'The render produced no output', {
      reason: 'render_empty',
    });
  if (size > SIMPLE_UPLOAD_MAX_BYTES)
    throw new AppError(
      'unprocessable',
      'The rendered file is too large (32 MB limit): shorten or crop the edit',
      { reason: 'render_too_large' },
    );
  const bytes = await readFile(file);
  const sniffed = sniffMedia(bytes.subarray(0, SNIFF_BYTES));
  if (!sniffed || (sniffed.kind !== 'video' && sniffed.kind !== 'audio'))
    throw new AppError('internal', 'The render output was not recognised', {
      reason: 'render_unrecognised',
    });
  const used = await ctx.db.query<{ used: string }>(
    'SELECT COALESCE(SUM(size_bytes),0)::text AS used FROM media WHERE owner_id = $1 AND deleted_at IS NULL',
    [ownerId],
  );
  const { USER_STORAGE_QUOTA_BYTES } = await import('../media/service.js');
  if (Number(used.rows[0]!.used) + bytes.length > USER_STORAGE_QUOTA_BYTES)
    throw new AppError('unprocessable', 'Storage quota exceeded', { reason: 'quota_exceeded' });
  const rt = getMediaRuntime(ctx);
  const key = newObjectKey('m', sniffed.ext);
  await rt.adapter.put(key, bytes, { contentType: sniffed.mime, size: bytes.length });
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, checksum_sha256, status, purpose, upload_state) VALUES ($1,$2,$3,$4,$5,$6,'uploaded','attachment',$7) RETURNING id`,
    [
      ownerId,
      sniffed.kind,
      key,
      sniffed.mime,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      JSON.stringify({ sanitized: 'not_applicable', source: 'studio_render' }),
    ],
  );
  const id = rows[0]!.id;
  await processMedia(ctx, rt, id);
  if (poster) {
    // The creator chose the thumbnail moment: it replaces the automatic poster frame.
    const pbytes = await readFile(poster);
    const pkey = newObjectKey('v', 'jpg');
    await rt.adapter.put(pkey, pbytes, { contentType: 'image/jpeg', size: pbytes.length });
    await ctx.db.query(
      `UPDATE media SET variants = COALESCE((SELECT jsonb_agg(v) FROM jsonb_array_elements(variants) v WHERE v->>'name' <> 'poster'), '[]'::jsonb) || $2::jsonb WHERE id = $1 AND deleted_at IS NULL`,
      [
        id,
        JSON.stringify([
          { name: 'poster', key: pkey, mime: 'image/jpeg', sizeBytes: pbytes.length },
        ]),
      ],
    );
  }
  return id;
}

export interface RenderResult {
  job: RenderJobRow;
  project: ProjectRow;
  reused: boolean;
}

/**
 * Render the project: ffmpeg applies the EDL to the unchanged source and writes a NEW media row (status ready once processed).
 * Idempotent per recipe: an identical, already rendered recipe returns the existing output. One render at a time per project (unique index).
 * Honest failures: `processing_unavailable` (503) when ffmpeg or an encoder is missing; the job row records what went wrong (never stderr).
 */
export async function renderProject(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  req?: FastifyRequest,
): Promise<RenderResult> {
  const p0 = await loadProject(ctx.db, projectId, auth.userId);
  const src = await loadSource(ctx.db, p0);
  const v = validateEdl(p0.edl, { durationMs: src.duration_ms, kind: src.kind });
  if (!v.ok)
    throw new AppError('unprocessable', 'The edit is no longer valid for this media', {
      reason: 'edl_invalid',
      issues: v.issues,
    });
  const edl = v.edl;
  const hash = edlHash(edl);
  if (p0.output_media_id && p0.rendered_edl_hash === hash) {
    const existing = (
      await ctx.db.query('SELECT 1 FROM media WHERE id = $1 AND deleted_at IS NULL', [
        p0.output_media_id,
      ])
    ).rowCount;
    if (existing) {
      const j = (
        await ctx.db.query<RenderJobRow>(
          `SELECT ${JOB_COLS} FROM studio_render_jobs WHERE project_id = $1 AND status = 'succeeded' AND output_media_id = $2 ORDER BY started_at DESC LIMIT 1`,
          [projectId, p0.output_media_id],
        )
      ).rows[0];
      if (j) return { job: j, project: p0, reused: true };
    }
  }
  if (src.duration_ms > MAX_RENDER_SOURCE_MS)
    throw new AppError(
      'unprocessable',
      'This source is too long to render on this server (10 minutes maximum)',
      { reason: 'source_too_long' },
    );
  if (isIdentity(edl, src) && !edl.thumbnail)
    throw new AppError(
      'unprocessable',
      'Nothing to render: this edit does not change the media. Publish the original instead.',
      { reason: 'nothing_to_render' },
    );
  const caps = await capabilities(ctx);
  if (!caps.available || !caps.libx264 || !caps.aac) throw processingUnavailable('Rendering');
  if (edl.captions?.burnIn && !caps.subtitles) throw processingUnavailable('Burning in captions');
  let track = null as Awaited<ReturnType<typeof getTrack>> | null;
  if (edl.captions)
    track = await getTrack(ctx.db, projectId, edl.captions.lang.toLowerCase()).catch(() => {
      throw new AppError('unprocessable', 'The edit uses a caption track that does not exist', {
        reason: 'captions_missing',
      });
    });

  // Claim the (single) running slot; an abandoned job (crashed process) older than 15 minutes is failed first.
  await ctx.db.query(
    `UPDATE studio_render_jobs SET status = 'failed', error_code = 'timeout', finished_at = now() WHERE project_id = $1 AND status = 'running' AND started_at < now() - ($2 || ' milliseconds')::interval`,
    [projectId, String(STALE_JOB_MS)],
  );
  let job: RenderJobRow;
  try {
    job = await withTransaction(ctx.db, async (tx) => {
      await loadProject(tx, projectId, auth.userId, true);
      const ins = await tx.query<RenderJobRow>(
        `INSERT INTO studio_render_jobs (project_id, requested_by, edl_hash, options) VALUES ($1,$2,$3,'{}') RETURNING ${JOB_COLS}`,
        [projectId, auth.userId, hash],
      );
      await tx.query(
        `UPDATE studio_projects SET status = 'processing', render_error = NULL WHERE id = $1`,
        [projectId],
      );
      return ins.rows[0]!;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505')
      throw conflict('This project is already rendering', { reason: 'render_in_progress' });
    throw err;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'yl-studio-'));
  let outputMediaId: string | null = null;
  let errorCode: string | null = null;
  try {
    const input = await materialise(ctx, src, dir);
    const demuxer = DEMUXER[src.mime_type];
    const probe = await probeSource(ctx, input, demuxer, src.duration_ms);
    if (src.kind === 'video' && !probe.hasVideo)
      throw new AppError('unprocessable', 'No video stream found', {
        reason: 'source_undecodable',
      });
    const out = path.join(
      dir,
      `out-${randomBytes(4).toString('hex')}.${src.kind === 'audio' ? 'm4a' : 'mp4'}`,
    );
    let subtitlesPath: string | undefined;
    if (edl.captions?.burnIn && track) {
      const cues = remapCues(track.cues, edl, src);
      if (!cues.length)
        throw new AppError('unprocessable', 'No caption falls inside the kept parts of the video', {
          reason: 'captions_empty',
        });
      subtitlesPath = path.join(dir, 'captions.srt');
      await writeFile(subtitlesPath, toSrt(cues), 'utf8');
    }
    const plan = buildRenderArgs({
      edl,
      source: probe,
      inputPath: input,
      outputPath: out,
      demuxer,
      subtitlesPath,
    });
    const run = await runBinary(ctx.config.MEDIA_FFMPEG_PATH, plan.args, RENDER_TIMEOUT_MS);
    if (run.code !== 0) {
      ctx.log.warn({ jobId: job.id, stderr: run.stderr.slice(0, 500) }, 'studio render failed');
      throw new AppError(
        'unprocessable',
        run.stderr.includes('timeout') ? 'The render took too long' : 'The render failed',
        { reason: run.stderr.includes('timeout') ? 'render_timeout' : 'render_failed' },
      );
    }
    let poster: string | null = null;
    if (src.kind === 'video' && edl.thumbnail) {
      poster = path.join(dir, 'poster.jpg');
      const t = await runBinary(
        ctx.config.MEDIA_FFMPEG_PATH,
        thumbnailArgs(
          out,
          Math.min(edl.thumbnail.atMs, Math.max(0, outputDurationMs(edl, src) - 100)),
          poster,
        ),
        60_000,
      );
      if (t.code !== 0 || !(await stat(poster).catch(() => null))?.size) poster = null;
    }
    outputMediaId = await registerOutput(ctx, auth.userId, out, poster);
  } catch (err) {
    errorCode =
      err instanceof AppError
        ? String((err.details as { reason?: string } | undefined)?.reason ?? err.code)
        : 'render_failed';
    if (!(err instanceof AppError)) ctx.log.error({ err, jobId: job.id }, 'studio render crashed');
    await ctx.db.query(
      `UPDATE studio_render_jobs SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1`,
      [job.id, errorCode],
    );
    await ctx.db.query(
      `UPDATE studio_projects SET status = 'failed', render_error = $2 WHERE id = $1`,
      [projectId, errorCode],
    );
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.render_failed',
        targetType: 'studio_project',
        targetId: projectId,
        metadata: { jobId: job.id, code: errorCode },
      },
      req,
    );
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const project = await withTransaction(ctx.db, async (tx) => {
    const cur = await loadProject(tx, projectId, auth.userId, true);
    // The recipe may have been edited while ffmpeg ran: the output then belongs to an older recipe and is recorded as such (not "rendered").
    const same = edlHash(cur.edl) === hash;
    await tx.query(
      `UPDATE studio_render_jobs SET status = 'succeeded', output_media_id = $2, finished_at = now() WHERE id = $1`,
      [job.id, outputMediaId],
    );
    const { rows } = await tx.query<ProjectRow>(
      `UPDATE studio_projects SET status = $2, output_media_id = $3, rendered_edl_hash = $4, render_error = NULL WHERE id = $1
       RETURNING id, owner_id, title, description, media_id, status, edl, edl_version, output_media_id, rendered_edl_hash, render_error, ai_assisted, published_post_id, created_at, updated_at`,
      [projectId, same ? 'ready' : 'draft', outputMediaId, hash],
    );
    await staleOpenPublication(tx, projectId);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.render_succeeded',
        targetType: 'studio_project',
        targetId: projectId,
        metadata: { jobId: job.id, outputMediaId, edlHash: hash },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
  const done = (
    await ctx.db.query<RenderJobRow>(`SELECT ${JOB_COLS} FROM studio_render_jobs WHERE id = $1`, [
      job.id,
    ])
  ).rows[0]!;
  return { job: done, project, reused: false };
}
