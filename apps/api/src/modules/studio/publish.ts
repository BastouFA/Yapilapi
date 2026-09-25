import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, invalid, notFound, visibilitySchema } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { createPost, type CreatePostInput } from '../content/service.js';
import { edlHash, isIdentity, remapCues, validateEdl, type Edl } from './edl.js';
import {
  attachTracksToMedia,
  listTracks,
  loadProject,
  loadSource,
  type ProjectRow,
} from './projects.js';

const MIN_LEAD_MS = 2 * 60_000;
const MAX_LEAD_MS = 90 * 86_400_000;

export const publishBody = z.object({
  /** Must be exactly `true`: publishing is an explicit act. Checked in the service so the refusal says why (422 confirmation_required). */
  confirm: z.boolean().default(false),
  mode: z.enum(['now', 'scheduled']).default('now'),
  publishAt: z.iso.datetime().optional(),
  body: z.string().max(10_000).default(''),
  visibility: visibilitySchema.optional(),
  circleId: z.uuid().optional(),
  audience: z.array(z.uuid()).max(100).optional(),
  topics: z.array(z.string().min(1).max(50)).max(10).optional(),
  language: z.string().min(2).max(35).optional(),
  license: z.string().min(1).max(60).optional(),
});

export interface PublicationRow {
  id: string;
  project_id: string;
  confirmed_by: string;
  mode: 'now' | 'scheduled';
  publish_at: Date | null;
  post_input: CreatePostInput;
  media_id: string;
  content_hash: string;
  status: 'confirmed' | 'published' | 'cancelled' | 'stale' | 'failed';
  post_id: string | null;
  error: string | null;
  confirmed_at: Date;
  published_at: Date | null;
}
const PCOLS =
  'id, project_id, confirmed_by, mode, publish_at, post_input, media_id, content_hash, status, post_id, error, confirmed_at, published_at';
export const publicationView = (p: PublicationRow) => ({
  id: p.id,
  mode: p.mode,
  publishAt: p.publish_at?.toISOString() ?? null,
  status: p.status,
  postId: p.post_id,
  error: p.error,
  confirmedAt: p.confirmed_at.toISOString(),
  publishedAt: p.published_at?.toISOString() ?? null,
  mediaId: p.media_id,
  contentHash: p.content_hash,
});

interface Binding {
  mediaId: string;
  mediaChecksum: string | null;
  edlHash: string;
  captions: string;
}

/** The exact media that would be published for this project, or a 409 that says what is missing. */
async function resolveMedia(
  db: Queryable,
  p: ProjectRow,
): Promise<{ mediaId: string; rendered: boolean; checksum: string | null; edl: Edl }> {
  const src = await loadSource(db, p);
  const v = validateEdl(p.edl, { durationMs: src.duration_ms, kind: src.kind });
  if (!v.ok)
    throw new AppError('unprocessable', 'The edit is not valid for this media', {
      reason: 'edl_invalid',
      issues: v.issues,
    });
  const hash = edlHash(v.edl);
  let mediaId: string;
  let rendered = false;
  if (p.output_media_id && p.rendered_edl_hash === hash) {
    mediaId = p.output_media_id;
    rendered = true;
  } else if (isIdentity(v.edl, src)) mediaId = src.id;
  else
    throw new AppError(
      'conflict',
      'Render the project first: the current edit has not been rendered',
      { reason: 'render_required' },
    );
  const m = (
    await db.query<{ status: string; checksum_sha256: string | null; owner_id: string }>(
      `SELECT status, checksum_sha256, owner_id FROM media WHERE id = $1 AND deleted_at IS NULL AND purged_at IS NULL`,
      [mediaId],
    )
  ).rows[0];
  if (!m || m.owner_id !== p.owner_id)
    throw new AppError('conflict', 'The media to publish is gone', { reason: 'media_missing' });
  if (m.status !== 'ready')
    throw new AppError('conflict', `The media is ${m.status}: wait until it is ready`, {
      reason: 'media_not_ready',
      status: m.status,
    });
  return { mediaId, rendered, checksum: m.checksum_sha256, edl: v.edl };
}

async function binding(
  db: Queryable,
  p: ProjectRow,
  r: { mediaId: string; checksum: string | null; edl: Edl },
): Promise<Binding> {
  const tracks = await listTracks(db, p.id);
  const captions = createHash('sha256')
    .update(JSON.stringify(tracks.map((t) => [t.lang, t.kind, t.cues])))
    .digest('hex');
  return { mediaId: r.mediaId, mediaChecksum: r.checksum, edlHash: edlHash(r.edl), captions };
}

/** Binds the post the creator saw to the media and recipe they confirmed. Any later change makes a scheduled publish refuse itself. */
/** Key-order independent JSON: the post input travels through a jsonb column, which does not keep key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v))
    return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const contentHash = (
  postInput: CreatePostInput,
  b: Binding,
  aiAssisted: string[],
  title: string,
): string =>
  createHash('sha256')
    .update(canonicalJson({ postInput, b, ai: [...aiAssisted].sort(), title }))
    .digest('hex');

function buildPostInput(
  b: z.infer<typeof publishBody>,
  mediaId: string,
  p: ProjectRow,
): CreatePostInput {
  if (b.visibility === 'community') throw invalid('Studio posts cannot be community posts');
  return {
    body: b.body,
    mediaIds: [mediaId],
    ...(b.visibility ? { visibility: b.visibility } : {}),
    ...(b.circleId ? { circleId: b.circleId } : {}),
    ...(b.audience ? { audience: b.audience } : {}),
    ...(b.topics ? { topics: b.topics } : {}),
    ...(b.language ? { language: b.language } : {}),
    license: b.license ?? 'all_rights_reserved',
    // Provenance is derived from what the creator ACCEPTED from AI in this project; it cannot be removed at publish time.
    ...(p.ai_assisted.length ? { aiAssistance: { tools: p.ai_assisted } } : {}),
  };
}

async function attachCaptions(
  ctx: AppContext,
  p: ProjectRow,
  mediaId: string,
  rendered: boolean,
  edl: Edl,
): Promise<number> {
  const src = await loadSource(ctx.db, p);
  const burned = edl.captions?.burnIn ? edl.captions.lang.toLowerCase() : null;
  // A rendered file has its own (re-timed) timeline: sidecar cues are re-mapped; a burned-in track is not also shipped as a sidecar.
  return attachTracksToMedia(ctx, p.owner_id, p.id, mediaId, (t) =>
    rendered ? (burned === t.lang ? null : remapCues(t.cues, edl, src)) : t.cues,
  );
}

/**
 * Publish a project as a post. Explicit only: `confirm: true` in the request body is mandatory, and the confirmation stores the EXACT post content and
 * media. `mode: now` creates the post inside this request; `mode: scheduled` stores the confirmation for `publishDueStudioPosts`, which refuses to publish
 * anything that changed after it was confirmed. createPost applies every normal publishing rule (moderation screening, teen limits, audience rules).
 */
export async function publishProject(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  b: z.infer<typeof publishBody>,
  req?: FastifyRequest,
): Promise<{ publication: PublicationRow; postId: string | null }> {
  if (b.confirm !== true)
    throw new AppError(
      'unprocessable',
      'Publishing needs your explicit confirmation (confirm: true)',
      { reason: 'confirmation_required' },
    );
  const p = await loadProject(ctx.db, projectId, auth.userId);
  if (p.status === 'processing')
    throw conflict('The project is still rendering', { reason: 'render_in_progress' });
  let at: Date | null = null;
  if (b.mode === 'scheduled') {
    if (!b.publishAt) throw invalid('publishAt is required to schedule');
    at = new Date(b.publishAt);
    if (at.getTime() < Date.now() + MIN_LEAD_MS) throw invalid('Schedule at least 2 minutes ahead');
    if (at.getTime() > Date.now() + MAX_LEAD_MS)
      throw invalid('You can schedule at most 90 days ahead');
  } else if (b.publishAt) throw invalid('publishAt only applies to scheduled publishing');
  const r = await resolveMedia(ctx.db, p);
  const input = buildPostInput(b, r.mediaId, p);
  const hash = contentHash(input, await binding(ctx.db, p, r), p.ai_assisted, p.title);

  const pub = await withTransaction(ctx.db, async (tx) => {
    await loadProject(tx, projectId, auth.userId, true);
    try {
      return (
        await tx.query<PublicationRow>(
          `INSERT INTO studio_publications (project_id, confirmed_by, mode, publish_at, post_input, media_id, content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${PCOLS}`,
          [projectId, auth.userId, b.mode, at, JSON.stringify(input), r.mediaId, hash],
        )
      ).rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw conflict('This project already has a confirmed publication: cancel it first', {
          reason: 'publication_exists',
        });
      throw err;
    }
  });
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'studio.publish_confirmed',
      targetType: 'studio_project',
      targetId: projectId,
      metadata: {
        publicationId: pub.id,
        mode: b.mode,
        publishAt: at?.toISOString() ?? null,
        mediaId: r.mediaId,
        contentHash: hash,
      },
    },
    req,
  );
  if (b.mode === 'scheduled') return { publication: pub, postId: null };
  const done = await runPublication(ctx, pub.id, {
    author: { userId: auth.userId, ageBand: auth.ageBand },
    req,
    throwOnFailure: true,
  });
  return { publication: done.publication, postId: done.publication.post_id };
}

export async function cancelPublication(
  ctx: AppContext,
  auth: AuthContext,
  projectId: string,
  req?: FastifyRequest,
): Promise<PublicationRow> {
  await loadProject(ctx.db, projectId, auth.userId);
  const { rows } = await ctx.db.query<PublicationRow>(
    `UPDATE studio_publications SET status = 'cancelled' WHERE project_id = $1 AND status = 'confirmed' AND confirmed_by = $2 RETURNING ${PCOLS}`,
    [projectId, auth.userId],
  );
  if (!rows[0]) throw notFound('Scheduled publication');
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'studio.publish_cancelled',
      targetType: 'studio_project',
      targetId: projectId,
      metadata: { publicationId: rows[0].id },
    },
    req,
  );
  return rows[0];
}

export async function getPublication(
  db: Queryable,
  projectId: string,
): Promise<PublicationRow | null> {
  return (
    (
      await db.query<PublicationRow>(
        `SELECT ${PCOLS} FROM studio_publications WHERE project_id = $1 ORDER BY confirmed_at DESC LIMIT 1`,
        [projectId],
      )
    ).rows[0] ?? null
  );
}

interface RunOpts {
  author?: { userId: string; ageBand: 'teen' | 'adult' };
  req?: FastifyRequest | undefined;
  throwOnFailure?: boolean;
  now?: Date;
}

class StaleError extends AppError {
  constructor(message: string) {
    super('conflict', message, { reason: 'publication_stale' });
  }
}

/**
 * Turn ONE confirmed publication into a post, exactly once and only if nothing changed since the confirmation. Claiming (status 'confirmed' -> 'published')
 * happens BEFORE the post is created, so two workers (or a retry after a crash) can never create two posts; a crash between claim and post leaves a
 * `published` row without `post_id`, which is visible and never silently repeated.
 */
async function runPublication(
  ctx: AppContext,
  id: string,
  o: RunOpts,
): Promise<{ publication: PublicationRow; outcome: 'published' | 'stale' | 'failed' | 'skipped' }> {
  const claimed = await ctx.db.query<PublicationRow>(
    `UPDATE studio_publications SET status = 'published', published_at = now() WHERE id = $1 AND status = 'confirmed' RETURNING ${PCOLS}`,
    [id],
  );
  const pub = claimed.rows[0];
  if (!pub)
    return {
      publication: (
        await ctx.db.query<PublicationRow>(
          `SELECT ${PCOLS} FROM studio_publications WHERE id = $1`,
          [id],
        )
      ).rows[0]!,
      outcome: 'skipped',
    };
  try {
    const p = (
      await ctx.db.query<ProjectRow>(
        `SELECT id, owner_id, title, description, media_id, status, edl, edl_version, output_media_id, rendered_edl_hash, render_error, ai_assisted, published_post_id, created_at, updated_at FROM studio_projects WHERE id = $1 AND deleted_at IS NULL`,
        [pub.project_id],
      )
    ).rows[0];
    if (!p) throw new StaleError('The project no longer exists');
    const u = (
      await ctx.db.query<{ age_band: 'teen' | 'adult'; status: string }>(
        `SELECT age_band, status FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [pub.confirmed_by],
      )
    ).rows[0];
    if (!u || u.status !== 'active')
      throw new AppError('forbidden', 'The account cannot publish right now', {
        reason: 'account_inactive',
      });
    let r: Awaited<ReturnType<typeof resolveMedia>>;
    try {
      r = await resolveMedia(ctx.db, p);
    } catch (e) {
      throw new StaleError(e instanceof AppError ? e.message : 'The media changed');
    }
    const hash = contentHash(pub.post_input, await binding(ctx.db, p, r), p.ai_assisted, p.title);
    if (hash !== pub.content_hash || r.mediaId !== pub.media_id)
      throw new StaleError('The project changed after it was confirmed: confirm it again');
    const author = o.author ?? { userId: pub.confirmed_by, ageBand: u.age_band };
    await attachCaptions(ctx, p, r.mediaId, r.rendered, r.edl);
    const postId = await createPost(ctx, author, pub.post_input);
    await ctx.db.query(`UPDATE studio_publications SET post_id = $2 WHERE id = $1`, [id, postId]);
    await ctx.db.query(
      `UPDATE studio_projects SET status = 'published', published_post_id = $2 WHERE id = $1`,
      [pub.project_id, postId],
    );
    await audit(
      ctx,
      {
        actorType: o.author ? 'user' : 'system',
        actorId: pub.confirmed_by,
        action: 'studio.published',
        targetType: 'post',
        targetId: postId,
        metadata: {
          projectId: pub.project_id,
          publicationId: id,
          mode: pub.mode,
          aiAssisted: p.ai_assisted,
        },
      },
      o.req,
    );
    ctx.metrics.events.inc({ name: 'post_created' });
    return {
      publication: (
        await ctx.db.query<PublicationRow>(
          `SELECT ${PCOLS} FROM studio_publications WHERE id = $1`,
          [id],
        )
      ).rows[0]!,
      outcome: 'published',
    };
  } catch (err) {
    const status = err instanceof StaleError ? 'stale' : 'failed';
    const message = err instanceof AppError ? err.message : 'Publishing failed';
    if (!(err instanceof AppError))
      ctx.log.error({ err, publicationId: id }, 'studio publish failed');
    const upd = await ctx.db.query<PublicationRow>(
      `UPDATE studio_publications SET status = $2, error = $3, published_at = NULL WHERE id = $1 RETURNING ${PCOLS}`,
      [id, status, message.slice(0, 300)],
    );
    await audit(
      ctx,
      {
        actorType: o.author ? 'user' : 'system',
        actorId: pub.confirmed_by,
        action: `studio.publish_${status}`,
        targetType: 'studio_project',
        targetId: pub.project_id,
        metadata: { publicationId: id, reason: message.slice(0, 200) },
      },
      o.req,
    );
    if (o.throwOnFailure) throw err instanceof AppError ? err : new AppError('internal', message);
    return { publication: upd.rows[0]!, outcome: status };
  }
}

export interface DueResult {
  published: number;
  stale: number;
  failed: number;
  skipped: number;
}

/**
 * Scheduled publishing (scripts/studio-publish.ts calls this every minute; nothing in the API process schedules it). Only publications the creator
 * explicitly confirmed are considered, and each is re-verified against the project as it is NOW.
 */
export async function publishDueStudioPosts(
  ctx: AppContext,
  opts: { now?: Date; limit?: number } = {},
): Promise<DueResult> {
  const now = opts.now ?? new Date();
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM studio_publications WHERE status = 'confirmed' AND mode = 'scheduled' AND publish_at <= $1 ORDER BY publish_at LIMIT $2`,
    [now, opts.limit ?? 100],
  );
  const out: DueResult = { published: 0, stale: 0, failed: 0, skipped: 0 };
  for (const r of rows) {
    try {
      const res = await runPublication(ctx, r.id, { now });
      out[res.outcome === 'published' ? 'published' : res.outcome] += 1;
    } catch (err) {
      ctx.log.error({ err, publicationId: r.id }, 'scheduled studio publish crashed');
      out.failed += 1;
    }
  }
  return out;
}
