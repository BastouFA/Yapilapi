import type { AppContext } from '../../lib/context.js';
import { mediaUrl } from '../../lib/media-url.js';
import { authenticityIndicators } from './authenticity.js';
import { ownRealSql, realVisibleSql } from './access.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw pg rows
type Row = Record<string, any>;

export interface MediaLite {
  id: string;
  kind: string;
  url: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  altText: string | null;
  blurhash: string | null;
  status: string;
}

/** Columns for one joined media alias (`a`) renamed with a prefix so several media can be selected in one query. */
export const mediaCols = (a: string, p: string) =>
  `${a}.id AS ${p}_id, ${a}.kind AS ${p}_kind, ${a}.storage_key AS ${p}_key, ${a}.mime_type AS ${p}_mime, ${a}.width AS ${p}_w, ${a}.height AS ${p}_h, ${a}.duration_ms AS ${p}_dur, ${a}.alt_text AS ${p}_alt, ${a}.blurhash AS ${p}_blur, ${a}.status AS ${p}_status`;

export function mediaLite(ctx: AppContext, r: Row, p: string): MediaLite | null {
  if (!r[`${p}_id`]) return null;
  const served = ['uploaded', 'processing', 'ready'].includes(r[`${p}_status`]);
  return {
    id: r[`${p}_id`],
    kind: r[`${p}_kind`],
    url: served ? mediaUrl(ctx.config, r[`${p}_key`]) : null,
    mimeType: r[`${p}_mime`],
    width: r[`${p}_w`],
    height: r[`${p}_h`],
    durationMs: r[`${p}_dur`],
    altText: r[`${p}_alt`],
    blurhash: r[`${p}_blur`],
    status: r[`${p}_status`],
  };
}

export const CAPTURE_SELECT = (viewer: string) => `
  r.id, r.author_id, r.caption, r.latitude, r.longitude, r.captured_at, r.received_at, r.authenticity, r.visibility, r.circle_id, r.shared_post_id,
  r.reaction_count, r.moderation_status, r.front_media_id, r.rear_media_id,
  pr.username, pr.display_name, pr.avatar_url,
  ${mediaCols('fm', 'f')}, ${mediaCols('rm', 'b')},
  (SELECT rr.kind FROM real_reactions rr WHERE rr.capture_id = r.id AND rr.user_id = ${viewer}) AS my_reaction`;
export const CAPTURE_FROM = `real_captures r JOIN profiles pr ON pr.user_id = r.author_id
  LEFT JOIN media fm ON fm.id = r.front_media_id AND fm.deleted_at IS NULL LEFT JOIN media rm ON rm.id = r.rear_media_id AND rm.deleted_at IS NULL`;

export function captureView(ctx: AppContext, r: Row, viewerId: string | null) {
  const own = viewerId === r.author_id;
  const auth = (r.authenticity ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
    },
    front: mediaLite(ctx, r, 'f'),
    rear: mediaLite(ctx, r, 'b'),
    caption: r.caption,
    location:
      r.latitude === null || r.latitude === undefined
        ? null
        : { latitude: r.latitude, longitude: r.longitude },
    capturedAt: new Date(r.captured_at).toISOString(),
    receivedAt: new Date(r.received_at).toISOString(),
    /** The authenticity receipt exactly as computed at capture time, plus human-readable indicators derived from it. */
    authenticity: auth,
    indicators: authenticityIndicators(auth),
    visibility: r.visibility,
    reactionCount: r.reaction_count,
    viewer: { reaction: r.my_reaction ?? null, isAuthor: own },
    createdAt: new Date(r.received_at).toISOString(),
    ...(own
      ? {
          circleId: r.circle_id,
          sharedPostId: r.shared_post_id,
          moderationStatus: r.moderation_status,
        }
      : {}),
  };
}

/** Load one capture the viewer may see (own captures included even while held for review), or null (callers answer 404). */
export async function loadCapture(
  ctx: AppContext,
  viewerId: string | null,
  id: string,
): Promise<ReturnType<typeof captureView> | null> {
  const { rows } = await ctx.db.query(
    `SELECT ${CAPTURE_SELECT('$1::uuid')} FROM ${CAPTURE_FROM} WHERE r.id = $2 AND (${realVisibleSql('$1::uuid')} OR ${ownRealSql('$1::uuid')})`,
    [viewerId, id],
  );
  return rows[0] ? captureView(ctx, rows[0], viewerId) : null;
}
