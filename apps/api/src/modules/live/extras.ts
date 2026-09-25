import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { createProject, setEdl } from '../studio/projects.js';
import { StatusError } from '../../lib/status-error.js';
import { publishLive } from './events.js';
import { loadAccess, requireCan } from './access.js';
import { readRoom } from './interact.js';
import { sessionOffsetMs, validateClipRange } from './rules.js';
import { getLiveRuntime } from './runtime.js';

// ------------------------------------------------------------------ markers
export const markerBody = z.object({
  label: z.string().trim().max(100).default(''),
  atMs: z.number().int().min(0).max(86_400_000).optional(),
});
export async function addMarker(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof markerBody>,
) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'marker');
  if (a.session.status !== 'live')
    throw conflict('Markers are set while the session is on air', {
      reason: 'not_live',
      status: a.session.status,
    });
  const at = b.atMs ?? sessionOffsetMs(a.session.started_at, null, new Date());
  const { rows } = await ctx.db.query<{ id: string; created_at: Date }>(
    'INSERT INTO live_markers (live_id, created_by, at_ms, label) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
    [id, auth.userId, at, b.label],
  );
  publishLive(ctx, id, { type: 'marker', atMs: at, label: b.label });
  return {
    id: rows[0]!.id,
    atMs: at,
    label: b.label,
    createdAt: rows[0]!.created_at.toISOString(),
  };
}
export async function listMarkers(ctx: AppContext, auth: AuthContext, id: string) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'marker');
  const { rows } = await ctx.db.query<{
    id: string;
    at_ms: number;
    label: string;
    created_at: Date;
  }>('SELECT id, at_ms, label, created_at FROM live_markers WHERE live_id = $1 ORDER BY at_ms', [
    id,
  ]);
  return {
    items: rows.map((m) => ({
      id: m.id,
      atMs: m.at_ms,
      label: m.label,
      createdAt: m.created_at.toISOString(),
    })),
  };
}

// ------------------------------------------------------------------ clips
export const clipBody = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  label: z.string().trim().max(100).default(''),
});
interface ClipRow {
  id: string;
  start_ms: number;
  end_ms: number;
  label: string;
  status: string;
  media_id: string | null;
  studio_project_id: string | null;
  created_at: Date;
}
const clipView = (c: ClipRow) => ({
  id: c.id,
  startMs: c.start_ms,
  endMs: c.end_ms,
  label: c.label,
  status: c.status,
  studioProjectId: c.studio_project_id,
  createdAt: c.created_at.toISOString(),
});

/** A clip is a time range of the session (ms from its start). It becomes video only when a recording exists: see clipToStudio. */
export async function createClip(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof clipBody>,
  req?: FastifyRequest,
) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'clip');
  if (a.session.status !== 'live' && a.session.status !== 'ended')
    throw conflict('Clips come from a session that has started', {
      reason: 'invalid_state',
      status: a.session.status,
    });
  const len = a.session.started_at
    ? sessionOffsetMs(a.session.started_at, a.session.ended_at, new Date())
    : null;
  const err = validateClipRange(b.startMs, b.endMs, len);
  if (err) throw invalid(err);
  const { rows } = await ctx.db.query<ClipRow>(
    `INSERT INTO live_clips (live_id, start_ms, end_ms, created_by, label) VALUES ($1,$2,$3,$4,$5) RETURNING id, start_ms, end_ms, label, status, media_id, studio_project_id, created_at`,
    [id, b.startMs, b.endMs, auth.userId, b.label],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.clip_created',
      targetType: 'live_session',
      targetId: id,
      metadata: { clipId: rows[0]!.id },
    },
    req,
  );
  return clipView(rows[0]!);
}
export async function listClips(ctx: AppContext, auth: AuthContext, id: string) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'clip');
  const { rows } = await ctx.db.query<ClipRow>(
    'SELECT id, start_ms, end_ms, label, status, media_id, studio_project_id, created_at FROM live_clips WHERE live_id = $1 ORDER BY start_ms',
    [id],
  );
  return { items: rows.map(clipView), hasRecording: Boolean(a.session.recording_media_id) };
}

/** Recording attached by the host (their own uploaded media): there is no server-side recording without an ingest provider. */
export const recordingBody = z.object({ mediaId: z.uuid() });
export async function attachRecording(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  mediaId: string,
  req?: FastifyRequest,
): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'recording');
  if (a.session.status !== 'ended')
    throw conflict('Attach the recording after the session ended', {
      reason: 'invalid_state',
      status: a.session.status,
    });
  const m = (
    await ctx.db.query<{ kind: string; status: string }>(
      `SELECT kind, status FROM media WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND purged_at IS NULL`,
      [mediaId, auth.userId],
    )
  ).rows[0];
  if (!m) throw notFound('Media');
  if (!['video', 'audio'].includes(m.kind) || m.status !== 'ready')
    throw new AppError('unprocessable', 'A recording is a ready video or audio file', {
      reason: 'unsupported_media',
    });
  await ctx.db.query('UPDATE live_sessions SET recording_media_id = $2 WHERE id = $1', [
    id,
    mediaId,
  ]);
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.recording_attached',
      targetType: 'live_session',
      targetId: id,
      metadata: { mediaId },
    },
    req,
  );
}

/** Turn a clip into a Studio project (trim of the recording). Nothing is published: the host continues in Studio and confirms there. */
export async function clipToStudio(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  clipId: string,
  req?: FastifyRequest,
) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'recording');
  const clip = (
    await ctx.db.query<ClipRow>(
      'SELECT id, start_ms, end_ms, label, status, media_id, studio_project_id, created_at FROM live_clips WHERE id = $1 AND live_id = $2',
      [clipId, id],
    )
  ).rows[0];
  if (!clip) throw notFound('Clip');
  if (clip.studio_project_id)
    throw conflict('This clip already has a Studio project', {
      reason: 'clip_exists',
      studioProjectId: clip.studio_project_id,
    });
  if (!a.session.recording_media_id)
    throw conflict('There is no recording to cut this clip from: attach one first', {
      reason: 'no_recording',
    });
  const project = await createProject(
    ctx,
    auth,
    {
      title: (clip.label || `Clip of ${a.session.title}`).slice(0, 160),
      mediaId: a.session.recording_media_id,
    },
    req,
  );
  try {
    await setEdl(
      ctx,
      auth,
      project.id,
      {
        version: 1,
        segments: [{ startMs: clip.start_ms, endMs: clip.end_ms }],
        aspect: null,
        thumbnail: null,
        captions: null,
      },
      undefined,
      req,
    );
  } catch (err) {
    await ctx.db.query(`UPDATE live_clips SET error_code = $2 WHERE id = $1`, [
      clipId,
      err instanceof AppError ? err.code : 'internal',
    ]);
    throw err;
  }
  await ctx.db.query(
    `UPDATE live_clips SET studio_project_id = $2, media_id = $3, error_code = NULL WHERE id = $1`,
    [clipId, project.id, a.session.recording_media_id],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.clip_to_studio',
      targetType: 'live_clip',
      targetId: clipId,
      metadata: { liveId: id, projectId: project.id },
    },
    req,
  );
  return { clipId, studioProjectId: project.id };
}

// ------------------------------------------------------------------ translation hook
export const translateBody = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    messageId: z.uuid().optional(),
    target: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/),
  })
  .refine((b) => Boolean(b.text) !== Boolean(b.messageId), 'Send either text or messageId');
export async function translate(
  ctx: AppContext,
  viewerId: string,
  id: string,
  b: z.infer<typeof translateBody>,
): Promise<{ text: string; target: string; provider: string }> {
  await readRoom(ctx, viewerId, id);
  const provider = getLiveRuntime(ctx).translation;
  if (!provider)
    throw new StatusError(
      501,
      'feature_disabled',
      'No translation provider is configured on this server',
      { reason: 'translation_unavailable' },
    );
  let text = b.text;
  if (b.messageId) {
    const m = (
      await ctx.db.query<{ body: string }>(
        `SELECT m.body FROM live_messages m WHERE m.id = $1 AND m.live_id = $2 AND m.hidden_at IS NULL
          AND (m.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $3 AND bl.blocked_id = m.user_id) OR (bl.blocker_id = m.user_id AND bl.blocked_id = $3)))`,
        [b.messageId, id, viewerId],
      )
    ).rows[0];
    if (!m) throw notFound('Message');
    text = m.body;
  }
  const out = await provider.translate(text!, b.target);
  return { text: out.slice(0, 2000), target: b.target, provider: provider.name };
}
