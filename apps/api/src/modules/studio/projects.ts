import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { classifyText } from '@yapilapi/moderation';
import { setCaptions } from '../media/service.js';
import { toVtt, importCaptions, validateCues, type Cue } from './captions.js';
import { edlHash, emptyEdl, validateEdl, type Edl } from './edl.js';

export const MAX_PROJECTS = 50;

export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  media_id: string | null;
  status: 'draft' | 'processing' | 'ready' | 'failed' | 'published';
  edl: Edl;
  edl_version: number;
  output_media_id: string | null;
  rendered_edl_hash: string | null;
  render_error: string | null;
  ai_assisted: string[];
  published_post_id: string | null;
  created_at: Date;
  updated_at: Date;
}
const COLS =
  'id, owner_id, title, description, media_id, status, edl, edl_version, output_media_id, rendered_edl_hash, render_error, ai_assisted, published_post_id, created_at, updated_at';

export interface SourceMedia {
  id: string;
  kind: 'video' | 'audio';
  duration_ms: number;
  durationMs: number;
  status: string;
  mime_type: string;
  storage_key: string;
}

export async function loadProject(
  db: Queryable,
  id: string,
  ownerId: string,
  lock = false,
): Promise<ProjectRow> {
  const { rows } = await db.query<ProjectRow>(
    `SELECT ${COLS} FROM studio_projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [id, ownerId],
  );
  if (!rows[0]) throw notFound('Project');
  return rows[0];
}

/** The project's source media, re-checked on every use: still ours, not deleted, not blocked, playable and probed. */
export async function loadSource(
  db: Queryable,
  p: Pick<ProjectRow, 'media_id' | 'owner_id'>,
): Promise<SourceMedia> {
  const { rows } = await db.query<Omit<SourceMedia, 'durationMs'>>(
    `SELECT id, kind, duration_ms, status, mime_type, storage_key FROM media WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND purged_at IS NULL AND kind IN ('video','audio')`,
    [p.media_id, p.owner_id],
  );
  const m = rows[0];
  if (!m)
    throw new AppError('conflict', 'The source media of this project is gone', {
      reason: 'source_missing',
    });
  if (m.status !== 'ready')
    throw new AppError('conflict', `The source media is ${m.status}`, {
      reason: 'source_not_ready',
      status: m.status,
    });
  if (!m.duration_ms || m.duration_ms <= 0)
    throw new AppError(
      'unprocessable',
      'The source media could not be measured, so it cannot be edited',
      { reason: 'source_not_probed' },
    );
  return { ...m, durationMs: m.duration_ms };
}

export const projectView = (p: ProjectRow, extra: Record<string, unknown> = {}) => ({
  id: p.id,
  title: p.title,
  description: p.description,
  mediaId: p.media_id,
  status: p.status,
  edl: p.edl,
  edlVersion: p.edl_version,
  edlHash: edlHash(p.edl),
  outputMediaId: p.output_media_id,
  rendered: Boolean(p.output_media_id) && p.rendered_edl_hash === edlHash(p.edl),
  renderError: p.render_error,
  aiAssisted: p.ai_assisted,
  publishedPostId: p.published_post_id,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
  ...extra,
});

export const createBody = z.object({
  title: z.string().trim().min(1).max(160),
  mediaId: z.uuid(),
  description: z.string().max(10_000).optional(),
});
export const patchBody = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(10_000).optional(),
  })
  .refine((b) => b.title !== undefined || b.description !== undefined, 'Nothing to change');

function assertText(text: string, what: string): void {
  const c = classifyText(text);
  if (c.status !== 'approved')
    throw new AppError('unprocessable', `That ${what} cannot be saved`, {
      reason: 'text_not_allowed',
    });
}

export async function createProject(
  ctx: AppContext,
  auth: AuthContext,
  b: z.infer<typeof createBody>,
  req?: FastifyRequest,
): Promise<ProjectRow> {
  assertText(b.title, 'title');
  if (b.description) assertText(b.description, 'description');
  // Only OWN media: someone else's file id is a 404, exactly like a missing one.
  const m = (
    await ctx.db.query<{ kind: string; status: string; duration_ms: number | null }>(
      `SELECT kind, status, duration_ms FROM media WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND purged_at IS NULL`,
      [b.mediaId, auth.userId],
    )
  ).rows[0];
  if (!m) throw notFound('Media');
  if (!['video', 'audio'].includes(m.kind))
    throw new AppError('unprocessable', 'Studio projects need a video or audio file', {
      reason: 'unsupported_media',
    });
  if (m.status !== 'ready')
    throw new AppError('conflict', `The media is ${m.status}: wait until it is ready`, {
      reason: 'source_not_ready',
      status: m.status,
    });
  return withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `studio:${auth.userId}`,
    ]);
    const n = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM studio_projects WHERE owner_id = $1 AND deleted_at IS NULL',
      [auth.userId],
    );
    if (n.rows[0]!.n >= MAX_PROJECTS)
      throw new AppError('unprocessable', `You can have at most ${MAX_PROJECTS} projects`, {
        reason: 'too_many_projects',
      });
    const { rows } = await tx.query<ProjectRow>(
      `INSERT INTO studio_projects (owner_id, title, description, media_id, edl) VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
      [auth.userId, b.title, b.description ?? '', b.mediaId, JSON.stringify(emptyEdl())],
    );
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.project_created',
        targetType: 'studio_project',
        targetId: rows[0]!.id,
        metadata: { mediaId: b.mediaId },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
}

export async function listProjects(db: Queryable, ownerId: string): Promise<ProjectRow[]> {
  return (
    await db.query<ProjectRow>(
      `SELECT ${COLS} FROM studio_projects WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT 100`,
      [ownerId],
    )
  ).rows;
}

/** An edit changes what would be published: any confirmed-but-unpublished publication is marked stale (the creator must confirm again). */
export async function staleOpenPublication(db: Queryable, projectId: string): Promise<number> {
  const r = await db.query(
    `UPDATE studio_publications SET status = 'stale', error = 'The project changed after it was confirmed' WHERE project_id = $1 AND status = 'confirmed'`,
    [projectId],
  );
  return r.rowCount ?? 0;
}

export async function patchProject(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof patchBody>,
  req?: FastifyRequest,
): Promise<ProjectRow> {
  if (b.title) assertText(b.title, 'title');
  if (b.description) assertText(b.description, 'description');
  return withTransaction(ctx.db, async (tx) => {
    await loadProject(tx, id, auth.userId, true);
    const { rows } = await tx.query<ProjectRow>(
      `UPDATE studio_projects SET title = COALESCE($2, title), description = COALESCE($3, description) WHERE id = $1 RETURNING ${COLS}`,
      [id, b.title ?? null, b.description ?? null],
    );
    if (b.description !== undefined) await staleOpenPublication(tx, id);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.project_updated',
        targetType: 'studio_project',
        targetId: id,
        metadata: { fields: Object.keys(b) },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
}

export async function deleteProject(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  req?: FastifyRequest,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await loadProject(tx, id, auth.userId, true);
    await staleOpenPublication(tx, id);
    await tx.query('UPDATE studio_projects SET deleted_at = now() WHERE id = $1', [id]);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.project_deleted',
        targetType: 'studio_project',
        targetId: id,
      },
      req,
      tx,
    );
  });
}

// ------------------------------------------------------------------ EDL
export async function setEdl(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  input: unknown,
  expectedVersion: number | undefined,
  req?: FastifyRequest,
): Promise<ProjectRow> {
  return withTransaction(ctx.db, async (tx) => {
    const p = await loadProject(tx, id, auth.userId, true);
    if (expectedVersion !== undefined && expectedVersion !== p.edl_version)
      throw conflict('The project was edited elsewhere: reload it', {
        reason: 'edl_version_conflict',
        edlVersion: p.edl_version,
      });
    const src = await loadSource(tx, p);
    const v = validateEdl(input, { durationMs: src.duration_ms, kind: src.kind });
    if (!v.ok) throw invalid('The edit is not valid', { issues: v.issues });
    if (v.edl.captions) {
      const t = await tx.query(
        'SELECT 1 FROM studio_caption_tracks WHERE project_id = $1 AND lower(lang) = lower($2)',
        [id, v.edl.captions.lang],
      );
      if (!t.rowCount)
        throw invalid('That caption language has no track in this project', {
          issues: [{ path: 'captions.lang', message: 'Add the caption track first' }],
        });
    }
    const changed = edlHash(v.edl) !== edlHash(p.edl);
    const { rows } = await tx.query<ProjectRow>(
      `UPDATE studio_projects SET edl = $2, edl_version = edl_version + 1, status = CASE WHEN status IN ('ready','failed','published') AND $3 THEN 'draft' ELSE status END, render_error = NULL WHERE id = $1 RETURNING ${COLS}`,
      [id, JSON.stringify(v.edl), changed],
    );
    if (changed) await staleOpenPublication(tx, id);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.edl_updated',
        targetType: 'studio_project',
        targetId: id,
        metadata: {
          version: rows[0]!.edl_version,
          segments: v.edl.segments.length,
          aspect: v.edl.aspect,
        },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
}

// ------------------------------------------------------------------ caption tracks
export interface TrackRow {
  project_id: string;
  lang: string;
  label: string;
  kind: 'captions' | 'subtitles';
  source: 'manual' | 'imported' | 'speech' | 'ai_translation';
  cues: Cue[];
  updated_at: Date;
}
export const trackView = (t: TrackRow) => ({
  lang: t.lang,
  label: t.label,
  kind: t.kind,
  source: t.source,
  cues: t.cues.length,
  updatedAt: t.updated_at.toISOString(),
});

const langSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/, 'Use a language tag such as en or pt-BR');
export const langParam = langSchema.transform((s) => s.toLowerCase());
const cueSchema = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  text: z.string().max(600),
});
export const trackBody = z
  .object({
    label: z.string().trim().max(60).optional(),
    kind: z.enum(['captions', 'subtitles']).default('captions'),
    cues: z.array(cueSchema).max(5000).optional(),
    vtt: z.string().max(600_000).optional(),
    srt: z.string().max(600_000).optional(),
  })
  .refine(
    (b) => [b.cues, b.vtt, b.srt].filter((x) => x !== undefined).length === 1,
    'Send exactly one of cues, vtt or srt',
  );
export const validateBody = z
  .object({
    cues: z.array(cueSchema).max(5000).optional(),
    vtt: z.string().max(600_000).optional(),
    srt: z.string().max(600_000).optional(),
  })
  .refine(
    (b) => [b.cues, b.vtt, b.srt].filter((x) => x !== undefined).length === 1,
    'Send exactly one of cues, vtt or srt',
  );

/** Turn any accepted input into validated cues, or a 400 that says what is wrong and where. */
export function cuesFromInput(
  b: { cues?: Cue[] | undefined; vtt?: string | undefined; srt?: string | undefined },
  durationMs?: number,
): { cues: Cue[]; source: 'manual' | 'imported' } {
  let cues: Cue[];
  let source: 'manual' | 'imported' = 'manual';
  if (b.cues)
    cues = b.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text.trim() }));
  else {
    const r = importCaptions(b.vtt !== undefined ? 'vtt' : 'srt', (b.vtt ?? b.srt)!);
    if (!r.ok)
      throw invalid(r.error, {
        issues:
          'issues' in r
            ? r.issues
            : [{ index: null, message: r.error, ...(r.line ? { line: r.line } : {}) }],
      });
    cues = r.cues;
    source = 'imported';
  }
  const issues = validateCues(cues);
  if (issues.length) throw invalid(issues[0]!.message, { issues });
  if (durationMs !== undefined && cues[cues.length - 1]!.endMs > durationMs + 1000)
    throw invalid('Some cues end after the media does', {
      issues: [{ index: cues.length - 1, message: `The media is ${durationMs} ms long` }],
    });
  for (const c of cues) assertText(c.text, 'caption');
  return { cues, source };
}

export async function putTrack(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  lang: string,
  b: z.infer<typeof trackBody>,
  source: 'manual' | 'imported' | 'speech' | 'ai_translation' | undefined,
  req?: FastifyRequest,
): Promise<TrackRow> {
  return withTransaction(ctx.db, async (tx) => {
    const p = await loadProject(tx, id, auth.userId, true);
    const src = await loadSource(tx, p);
    const parsed = cuesFromInput(b, src.duration_ms);
    const { rows } = await tx.query<TrackRow>(
      `INSERT INTO studio_caption_tracks (project_id, lang, label, kind, source, cues) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, lang) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind, source = EXCLUDED.source, cues = EXCLUDED.cues, updated_at = now()
       RETURNING project_id, lang, label, kind, source, cues, updated_at`,
      [id, lang, b.label ?? '', b.kind, source ?? parsed.source, JSON.stringify(parsed.cues)],
    );
    // The captions changed: a burned-in render (or anything scheduled) no longer matches. The EDL hash does not include track text, so bump the version.
    await tx.query(
      `UPDATE studio_projects SET edl_version = edl_version + 1, status = CASE WHEN status IN ('ready','published') AND edl->'captions'->>'burnIn' = 'true' AND lower(edl->'captions'->>'lang') = $2 THEN 'draft' ELSE status END,
                    rendered_edl_hash = CASE WHEN edl->'captions'->>'burnIn' = 'true' AND lower(edl->'captions'->>'lang') = $2 THEN NULL ELSE rendered_edl_hash END WHERE id = $1`,
      [id, lang],
    );
    await staleOpenPublication(tx, id);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.captions_saved',
        targetType: 'studio_project',
        targetId: id,
        metadata: { lang, cues: parsed.cues.length, source: rows[0]!.source },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
}

export async function listTracks(db: Queryable, projectId: string): Promise<TrackRow[]> {
  return (
    await db.query<TrackRow>(
      'SELECT project_id, lang, label, kind, source, cues, updated_at FROM studio_caption_tracks WHERE project_id = $1 ORDER BY lang',
      [projectId],
    )
  ).rows;
}
export async function getTrack(db: Queryable, projectId: string, lang: string): Promise<TrackRow> {
  const t = (
    await db.query<TrackRow>(
      'SELECT project_id, lang, label, kind, source, cues, updated_at FROM studio_caption_tracks WHERE project_id = $1 AND lang = $2',
      [projectId, lang],
    )
  ).rows[0];
  if (!t) throw notFound('Caption track');
  return t;
}

export async function deleteTrack(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  lang: string,
  req?: FastifyRequest,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const p = await loadProject(tx, id, auth.userId, true);
    if (p.edl.captions && p.edl.captions.lang.toLowerCase() === lang)
      throw conflict('The edit uses this caption track: remove it from the edit first', {
        reason: 'track_in_use',
      });
    const r = await tx.query(
      'DELETE FROM studio_caption_tracks WHERE project_id = $1 AND lang = $2',
      [id, lang],
    );
    if (!r.rowCount) throw notFound('Caption track');
    await staleOpenPublication(tx, id);
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'studio.captions_deleted',
        targetType: 'studio_project',
        targetId: id,
        metadata: { lang },
      },
      req,
      tx,
    );
  });
}

/** Attach caption tracks to a media row (as the WebVTT sidecars the media module serves). `pick` returns the cues to ship for a track, or null to skip it. Only explicit publish paths call this. */
export async function attachTracksToMedia(
  ctx: AppContext,
  ownerId: string,
  projectId: string,
  mediaId: string,
  pick: (t: TrackRow) => Cue[] | null,
): Promise<number> {
  let n = 0;
  for (const t of await listTracks(ctx.db, projectId)) {
    const cues = pick(t);
    if (!cues || !cues.length) continue;
    await setCaptions(ctx, mediaId, ownerId, t.lang, toVtt(cues), t.label || undefined, t.kind);
    n++;
  }
  return n;
}
