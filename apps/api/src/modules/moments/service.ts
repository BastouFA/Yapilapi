import { withTransaction } from '@yapilapi/database';
import { AppError, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { screenText } from '../../lib/moderation-hook.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { mediaUrl } from '../../lib/media-url.js';
import { momentVisibleSql } from '../../lib/visibility.js';
import { deleteMediaById } from '../media/service.js';

export const MOMENT_VISIBILITIES = [
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
] as const;
export type MomentVisibility = (typeof MOMENT_VISIBILITIES)[number];
export const CUSTOM_EXPIRY_MIN_MS = 15 * 60_000;
export const CUSTOM_EXPIRY_MAX_MS = 7 * 24 * 3600_000;
const EXPIRY_MS = { '1h': 3600_000, '24h': 24 * 3600_000 } as const;

export interface CreateMomentInput {
  kind: 'photo' | 'video' | 'text' | 'audio';
  body: string;
  mediaId?: string | undefined;
  music?:
    | {
        title: string;
        artist?: string | undefined;
        provider?: string | undefined;
        externalId?: string | undefined;
        startMs?: number | undefined;
        durationMs?: number | undefined;
      }
    | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  placeId?: string | undefined;
  visibility?: MomentVisibility | undefined;
  circleId?: string | undefined;
  audience?: string[] | undefined;
  expiry: '1h' | '24h' | 'custom' | 'permanent';
  expiresAt?: Date | undefined;
}

const MEDIA_KIND: Record<string, string> = { photo: 'image', video: 'video', audio: 'audio' };

/** Compute the expiry instant from the requested policy. Pure (unit tested). */
export function resolveExpiry(
  expiry: CreateMomentInput['expiry'],
  custom: Date | undefined,
  now = new Date(),
): Date | null {
  if (expiry === 'permanent') {
    if (custom) throw invalid('expiresAt is only valid with expiry "custom"');
    return null;
  }
  if (expiry === 'custom') {
    if (!custom) throw invalid('expiresAt is required with expiry "custom"');
    const delta = custom.getTime() - now.getTime();
    if (delta < CUSTOM_EXPIRY_MIN_MS)
      throw invalid('Custom expiry must be at least 15 minutes from now');
    if (delta > CUSTOM_EXPIRY_MAX_MS)
      throw invalid('Custom expiry cannot be more than 7 days from now');
    return custom;
  }
  if (custom) throw invalid('expiresAt is only valid with expiry "custom"');
  return new Date(now.getTime() + EXPIRY_MS[expiry]);
}

export async function createMoment(
  ctx: AppContext,
  author: { userId: string; ageBand: 'teen' | 'adult' },
  input: CreateMomentInput,
) {
  const body = input.body.trim();
  if (input.kind === 'text') {
    if (!body) throw invalid('A text moment needs text');
    if (input.mediaId) throw invalid('A text moment cannot carry media');
  } else {
    if (!input.mediaId) throw invalid(`A ${input.kind} moment needs media`);
  }
  if ((input.latitude === undefined) !== (input.longitude === undefined))
    throw invalid('Provide both latitude and longitude');

  const visibility: MomentVisibility = input.visibility ?? 'friends';
  if (author.ageBand === 'teen') {
    if (visibility === 'public')
      throw new AppError('unprocessable', 'Accounts under 18 cannot share moments publicly');
    if (input.latitude !== undefined || input.placeId)
      throw new AppError('unprocessable', 'Accounts under 18 cannot attach a location to moments');
  }
  if (visibility === 'circle' && !input.circleId)
    throw invalid('circleId is required for circle visibility');
  if (visibility !== 'circle' && input.circleId)
    throw invalid('circleId is only valid with circle visibility');
  const audience = [...new Set(input.audience ?? [])].filter((id) => id !== author.userId);
  if (visibility === 'selected' && !audience.length)
    throw invalid('Choose who can see this moment');
  if (visibility !== 'selected' && input.audience?.length)
    throw invalid('audience is only valid with selected visibility');
  const expiresAt = resolveExpiry(input.expiry, input.expiresAt);

  if (visibility === 'public') {
    const p = await ctx.db.query<{ is_private: boolean }>(
      'SELECT is_private FROM profiles WHERE user_id = $1',
      [author.userId],
    );
    if (p.rows[0]?.is_private)
      throw new AppError(
        'unprocessable',
        'Private accounts share moments with followers, friends, a circle or selected people',
      );
  }
  if (input.circleId) {
    const c = await ctx.db.query('SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2', [
      input.circleId,
      author.userId,
    ]);
    if (!c.rowCount) throw notFound('Circle');
  }
  for (const uid of audience)
    if (await isBlockedEitherWay(ctx.db, author.userId, uid))
      throw invalid('Your audience includes someone you cannot share with');
  if (audience.length) {
    const ok = await ctx.db.query(
      'SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status = $2',
      [audience, 'active'],
    );
    if (ok.rows[0]!.n !== audience.length)
      throw invalid('Your audience includes someone who is unavailable');
  }
  if (input.placeId) {
    const p = await ctx.db.query('SELECT 1 FROM places WHERE id = $1 AND deleted_at IS NULL', [
      input.placeId,
    ]);
    if (!p.rowCount) throw notFound('Place');
  }

  return withTransaction(ctx.db, async (tx) => {
    if (input.mediaId) {
      // Lock the media row so two moments cannot claim it concurrently.
      const { rows } = await tx.query<{ id: string; kind: string; purpose: string }>(
        `SELECT m.id, m.kind, m.purpose FROM media m
          WHERE m.id = $1 AND m.owner_id = $2 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')
            AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.media_id = m.id AND mo.deleted_at IS NULL)
          FOR UPDATE`,
        [input.mediaId, author.userId],
      );
      const m = rows[0];
      if (!m) throw invalid('The media is unavailable');
      if (m.kind !== MEDIA_KIND[input.kind])
        throw invalid(`A ${input.kind} moment needs ${MEDIA_KIND[input.kind]} media`);
      if (m.purpose === 'public') throw invalid('Public profile media cannot be used in moments');
    }
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO moments (author_id, kind, media_id, body, music, latitude, longitude, place_id, visibility, circle_id, expiry, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        author.userId,
        input.kind,
        input.mediaId ?? null,
        body,
        input.music ? JSON.stringify(input.music) : null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.placeId ?? null,
        visibility,
        input.circleId ?? null,
        input.expiry,
        expiresAt,
      ],
    );
    const id = ins.rows[0]!.id;
    if (audience.length)
      await tx.query(
        'INSERT INTO moment_audience (moment_id, user_id) SELECT $1, unnest($2::uuid[])',
        [id, audience],
      );
    const screen = [body, input.music?.title, input.music?.artist].filter(Boolean).join(' ');
    if (screen)
      await screenText(ctx, tx, { type: 'moment', id, authorId: author.userId, text: screen });
    return id;
  });
}

// ------------------------------------------------------------------------------------------------ views
const SELECT = (viewer: string) => `
  m.id, m.author_id, m.kind, m.body, m.music, m.latitude, m.longitude, m.place_id, m.visibility, m.circle_id, m.expiry, m.expires_at,
  m.moderation_status, m.created_at,
  pr.username, pr.display_name, pr.avatar_url,
  mm.id AS media_id, mm.kind AS media_kind, mm.storage_key, mm.mime_type, mm.width, mm.height, mm.duration_ms, mm.alt_text, mm.blurhash,
  mm.status AS media_status, mm.variants,
  EXISTS (SELECT 1 FROM moment_views v WHERE v.moment_id = m.id AND v.viewer_id = ${viewer}) AS seen,
  (SELECT r.kind FROM reactions r WHERE r.user_id = ${viewer} AND r.target_type = 'moment' AND r.target_id = m.id) AS my_reaction,
  (SELECT count(*) FROM reactions r WHERE r.target_type = 'moment' AND r.target_id = m.id)::int AS reaction_count,
  CASE WHEN m.author_id = ${viewer} THEN (SELECT count(*) FROM moment_views v WHERE v.moment_id = m.id)::int END AS view_count`;
const FROM = `moments m JOIN profiles pr ON pr.user_id = m.author_id LEFT JOIN media mm ON mm.id = m.media_id AND mm.deleted_at IS NULL`;
export const momentSelect = SELECT;
export const momentFrom = FROM;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- raw pg row
export function momentView(ctx: AppContext, r: Row, viewerId: string | null) {
  const own = viewerId === r.author_id;
  const round = (n: number | null) =>
    n === null || n === undefined || own ? n : Math.round(n * 1000) / 1000; // ~110 m for others
  const url = (k: string) => mediaUrl(ctx.config, k);
  return {
    id: r.id,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
    },
    kind: r.kind,
    body: r.body,
    music: r.music ?? null,
    location:
      r.latitude !== null && r.latitude !== undefined
        ? { latitude: round(r.latitude), longitude: round(r.longitude) }
        : null,
    placeId: r.place_id,
    visibility: r.visibility,
    circleId: own ? r.circle_id : null,
    expiry: r.expiry,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    media: r.media_id
      ? {
          id: r.media_id,
          kind: r.media_kind,
          url: url(r.storage_key),
          mimeType: r.mime_type,
          width: r.width,
          height: r.height,
          durationMs: r.duration_ms,
          altText: r.alt_text,
          blurhash: r.blurhash,
          status: r.media_status,
          variants: (
            (r.variants ?? []) as Array<{
              name: string;
              key: string;
              mime: string;
              width?: number;
              height?: number;
            }>
          ).map((v) => ({
            name: v.name,
            url: url(v.key),
            mimeType: v.mime,
            width: v.width ?? null,
            height: v.height ?? null,
          })),
        }
      : null,
    viewer: { seen: own ? true : Boolean(r.seen), reaction: r.my_reaction ?? null, isAuthor: own },
    counts: { reactions: r.reaction_count, ...(own ? { views: r.view_count } : {}) },
    moderationStatus: own ? r.moderation_status : undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function loadMomentView(
  ctx: AppContext,
  viewerId: string | null,
  id: string,
  opts: { ignoreVisibility?: boolean } = {},
) {
  const { rows } = await ctx.db.query(
    `SELECT ${SELECT('$1::uuid')} FROM ${FROM} WHERE m.id = $2 ${opts.ignoreVisibility ? '' : `AND ${momentVisibleSql('$1::uuid')}`}`,
    [viewerId, id],
  );
  return rows[0] ? momentView(ctx, rows[0], viewerId) : null;
}

/** The moment tray: live moments from people the viewer follows or is friends with, grouped per author. */
export async function loadTray(ctx: AppContext, viewerId: string, limitAuthors: number) {
  const { rows } = await ctx.db.query(
    `SELECT ${SELECT('$1::uuid')} FROM ${FROM}
      WHERE ${momentVisibleSql('$1::uuid')}
        AND m.author_id <> $1::uuid
        AND m.created_at > now() - interval '7 days'
        AND (
          EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1::uuid AND f.followee_id = m.author_id AND f.status = 'active')
          OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($1::uuid, m.author_id) AND fr.user_high = GREATEST($1::uuid, m.author_id) AND fr.status = 'accepted')
        )
        AND NOT EXISTS (SELECT 1 FROM user_mutes mu WHERE mu.muter_id = $1::uuid AND mu.muted_id = m.author_id)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 600`,
    [viewerId],
  );
  const groups = new Map<
    string,
    {
      author: ReturnType<typeof momentView>['author'];
      moments: Array<ReturnType<typeof momentView>>;
      latestAt: string;
      unseenCount: number;
    }
  >();
  for (const r of rows) {
    const v = momentView(ctx, r, viewerId);
    let g = groups.get(r.author_id);
    if (!g)
      groups.set(
        r.author_id,
        (g = { author: v.author, moments: [], latestAt: v.createdAt, unseenCount: 0 }),
      );
    g.moments.push(v);
    if (!v.viewer.seen) g.unseenCount++;
  }
  const all = [...groups.values()];
  for (const g of all) g.moments.reverse(); // play order inside a story: oldest first
  all.sort(
    (a, b) =>
      Number(b.unseenCount > 0) - Number(a.unseenCount > 0) ||
      (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0),
  );
  return {
    items: all.slice(0, limitAuthors).map((g) => ({
      author: g.author,
      hasUnseen: g.unseenCount > 0,
      unseenCount: g.unseenCount,
      latestAt: g.latestAt,
      moments: g.moments,
    })),
    hasMore: all.length > limitAuthors,
  };
}

// ------------------------------------------------------------------------------------------------ deletion + expiry
async function dropMomentSideData(
  tx: { query: (sql: string, p?: unknown[]) => Promise<unknown> },
  ids: string[],
): Promise<void> {
  await tx.query('DELETE FROM moment_views WHERE moment_id = ANY($1::uuid[])', [ids]);
  await tx.query('DELETE FROM moment_audience WHERE moment_id = ANY($1::uuid[])', [ids]);
  await tx.query(
    `DELETE FROM reactions WHERE target_type = 'moment' AND target_id = ANY($1::uuid[])`,
    [ids],
  );
}

/** Media of a moment goes with it, unless something else has since started using it. */
async function releaseMomentMedia(ctx: AppContext, mediaIds: string[]): Promise<number> {
  let n = 0;
  for (const id of mediaIds) {
    const { rows } = await ctx.db.query<{ used: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM post_media WHERE media_id = $1) OR EXISTS (SELECT 1 FROM message_attachments WHERE media_id = $1)
               OR EXISTS (SELECT 1 FROM moments WHERE media_id = $1 AND deleted_at IS NULL)) AS used`,
      [id],
    );
    if (rows[0]!.used) continue;
    await deleteMediaById(ctx, id);
    n++;
  }
  return n;
}

export async function deleteMomentAsAuthor(
  ctx: AppContext,
  momentId: string,
  userId: string,
): Promise<void> {
  const mediaId = await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{ media_id: string | null }>(
      `UPDATE moments SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING media_id`,
      [momentId, userId],
    );
    if (!rows[0]) throw notFound('Moment');
    await dropMomentSideData(tx, [momentId]);
    return rows[0].media_id;
  });
  if (mediaId) await releaseMomentMedia(ctx, [mediaId]);
}

export interface ExpireResult {
  moments: number;
  media: number;
}

/**
 * Cleanup for expired, non-permanent moments (run from `scripts/expire-moments.ts` on a schedule). Visibility never
 * depends on this job — `momentVisibleSql` already hides expired moments the instant they expire — this only reclaims
 * storage and minimises retained data: media is deleted from storage, text/music/location are erased, the moment is
 * soft-deleted and its views/reactions removed. Idempotent; processes in batches.
 */
export async function expireMoments(
  ctx: AppContext,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<ExpireResult> {
  const batchSize = opts.batchSize ?? 200;
  const result: ExpireResult = { moments: 0, media: 0 };
  for (let i = 0; i < (opts.maxBatches ?? 50); i++) {
    const mediaIds = await withTransaction(ctx.db, async (tx) => {
      const { rows } = await tx.query<{ id: string; media_id: string | null }>(
        `UPDATE moments SET deleted_at = now(), body = '', music = NULL, latitude = NULL, longitude = NULL, place_id = NULL
          WHERE id IN (SELECT id FROM moments WHERE expires_at IS NOT NULL AND expires_at <= now() AND deleted_at IS NULL ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING id, media_id`,
        [batchSize],
      );
      if (rows.length)
        await dropMomentSideData(
          tx,
          rows.map((r) => r.id),
        );
      return rows;
    });
    if (!mediaIds.length) break;
    result.moments += mediaIds.length;
    result.media += await releaseMomentMedia(
      ctx,
      mediaIds.map((r) => r.media_id).filter((x): x is string => Boolean(x)),
    );
    if (mediaIds.length < batchSize) break;
  }
  return result;
}
