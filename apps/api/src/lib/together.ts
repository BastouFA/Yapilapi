import type { Pool, PoolClient } from 'pg';
import {
  pickBestOf,
  TOGETHER_ADDED_NOTICE_MINUTES,
  TOGETHER_CLOSING_NOTICE_MINUTES,
  TOGETHER_ITEMS_MAX,
  togetherFileName,
  type TogetherComment,
  type TogetherCover,
  type TogetherItem,
  type TogetherMember,
  type TogetherReaction,
  type TogetherRole,
  type TogetherSummary,
} from '@yapilapi/shared';
import { minorRuleSql } from './collabs.ts';
import { seesSensitiveSql } from './interactions.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { notBlockedSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Together albums (see packages/shared/src/together.ts for what they are).
 *
 * Only members ever see an album; everyone else gets "not found". Items are
 * aliased `c` (together_contributions) with their media `md` and their adder's
 * user row `au`. Blocks work both ways and at any time: people who blocked each
 * other don't see each other's items, comments or place in the member list,
 * even when the block came after they were both in it.
 */

/** The database's 'creator' is the host. */
export const roleOf = (r: string): TogetherRole => (r === 'creator' ? 'host' : r === 'cohost' ? 'cohost' : 'member');
/** Hosts and co-hosts change the album, approve requests and remove anyone's items. */
export const manages = (role: string | null | undefined) => role === 'creator' || role === 'cohost';

/** An item `c` (with `md`, `au`) viewer `v` gets: not removed, media fine for them, nobody blocked. */
export function itemVisibleSql(v: string): string {
  return `(c.deleted_at IS NULL AND au.status = 'active' AND md.deleted_at IS NULL AND md.kind IN ('image', 'video')
    AND md.status <> 'failed' AND md.moderation <> 'blocked' AND (md.moderation <> 'sensitive' OR ${seesSensitiveSql(v)})
    AND ${notBlockedSql('c.user_id', v)})`;
}

const ITEM_FROM = `together_contributions c JOIN media md ON md.id = c.media_id JOIN users au ON au.id = c.user_id JOIN profiles pr ON pr.user_id = c.user_id`;
const U_COLS = `pr.user_id AS u_id, pr.username AS u_username, pr.display_name AS u_display_name, pr.avatar_url AS u_avatar_url, pr.mode AS u_mode, ${plusCol('u_')}`;
const HOST_COLS = `hp.user_id AS h_id, hp.username AS h_username, hp.display_name AS h_display_name, hp.avatar_url AS h_avatar_url, hp.mode AS h_mode, ${plusCol('h_', 'hp')}`;

/** An album with viewer $1's role; `where` picks which. Deleted albums and non-members are left out. */
export const SUMMARY_SELECT = `
  SELECT t.*, m.role AS my_role, ${HOST_COLS},
         (SELECT count(*) FROM together_contributions c JOIN media md ON md.id = c.media_id JOIN users au ON au.id = c.user_id
          WHERE c.together_id = t.id AND ${itemVisibleSql('$1')})::int AS item_count,
         (SELECT count(*) FROM together_members m2 JOIN users u2 ON u2.id = m2.user_id WHERE m2.together_id = t.id AND u2.status = 'active')::int AS member_count,
         CASE WHEN m.role IN ('creator', 'cohost')
              THEN (SELECT count(*) FROM together_requests r WHERE r.together_id = t.id AND r.status = 'pending')::int ELSE 0 END AS request_count,
         (SELECT max(c.created_at) FROM together_contributions c WHERE c.together_id = t.id AND c.deleted_at IS NULL) AS last_added_at,
         cov.kind AS cov_kind, cov.url AS cov_url, cov.variants AS cov_variants, cov.poster_url AS cov_poster
  FROM togethers t
  JOIN together_members m ON m.together_id = t.id AND m.user_id = $1
  JOIN profiles hp ON hp.user_id = t.creator_id
  LEFT JOIN LATERAL (
    SELECT md.kind, md.url, md.variants, md.poster_url
    FROM ${ITEM_FROM}
    WHERE c.together_id = t.id AND ${itemVisibleSql('$1')} AND md.moderation <> 'sensitive'
    ORDER BY (c.id = t.cover_item_id) DESC NULLS LAST, c.captured_at DESC
    LIMIT 1
  ) cov ON true
  WHERE t.deleted_at IS NULL`;

function coverOf(r: Record<string, any>): TogetherCover | null {
  if (!r.cov_kind) return null;
  const v = (r.cov_variants ?? {}) as Record<string, string>;
  if (r.cov_kind === 'video') return { kind: 'video', thumbUrl: v.thumb ?? r.cov_poster ?? null, url: r.cov_poster ?? v.thumb ?? null };
  return { kind: 'image', thumbUrl: v.thumb ?? v.medium ?? r.cov_url, url: v.large ?? v.medium ?? r.cov_url };
}

export function toSummary(r: Record<string, any>): TogetherSummary {
  const open = r.status === 'open';
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? '',
    status: open ? 'open' : 'closed',
    closesAt: open && r.closes_at ? new Date(r.closes_at).toISOString() : null,
    closedAt: !open && r.closed_at ? new Date(r.closed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    cover: coverOf(r),
    itemCount: Number(r.item_count ?? 0),
    memberCount: Number(r.member_count ?? 0),
    myRole: roleOf(r.my_role),
    host: publicUserFrom(r, 'h_'),
    eventId: r.event_id ?? null,
    conversationId: r.conversation_id ?? null,
    requestCount: Number(r.request_count ?? 0),
    lastAddedAt: r.last_added_at ? new Date(r.last_added_at).toISOString() : null,
  };
}

/**
 * An album that has reached its closing time is closed (its members hear about it from the
 * sweep). Called before reading one, so nobody can add after the time even between sweeps.
 */
export async function closeIfDue(db: Q, id?: string): Promise<void> {
  await db.query(
    `UPDATE togethers SET status = 'closed', closed_at = closes_at, closed_by = NULL, updated_at = now()
     WHERE status = 'open' AND deleted_at IS NULL AND closes_at <= now() AND ($1::uuid IS NULL OR id = $1)`,
    [id ?? null],
  );
}

/** The items viewer `v` gets in an album, oldest first, with stars, reactions and comment counts. */
export async function albumItems(db: Q, albumId: string, viewer: string, title: string, only?: string[]): Promise<TogetherItem[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.caption, c.captured_at, c.created_at, c.taken_source, c.user_id,
            md.id AS m_id, md.kind AS m_kind, md.url AS m_url, md.alt_text AS m_alt, md.width AS m_width, md.height AS m_height,
            md.variants AS m_variants, md.poster_url AS m_poster, md.hls_url AS m_hls, md.blurhash AS m_blur, md.duration_ms AS m_duration,
            md.status AS m_status, md.moderation AS m_moderation, ${U_COLS},
            (SELECT count(*) FROM together_stars s WHERE s.item_id = c.id)::int AS stars,
            EXISTS (SELECT 1 FROM together_stars s WHERE s.item_id = c.id AND s.user_id = $2) AS starred,
            (SELECT coalesce(json_agg(json_build_object('kind', x.kind, 'count', x.n, 'mine', x.mine) ORDER BY x.n DESC, x.kind), '[]')
             FROM (SELECT r.kind, count(*)::int AS n, bool_or(r.user_id = $2) AS mine FROM together_reactions r WHERE r.item_id = c.id GROUP BY r.kind) x) AS reactions,
            (SELECT count(*) FROM together_comments cm JOIN users cu ON cu.id = cm.author_id
             WHERE cm.item_id = c.id AND cm.deleted_at IS NULL AND cu.status = 'active' AND ${notBlockedSql('cm.author_id', '$2')})::int AS comments
     FROM ${ITEM_FROM}
     WHERE c.together_id = $1 AND ${itemVisibleSql('$2')} AND ($3::uuid[] IS NULL OR c.id = ANY($3::uuid[]))
     ORDER BY c.captured_at, c.created_at, c.id
     LIMIT ${TOGETHER_ITEMS_MAX}`,
    [albumId, viewer, only ?? null],
  );
  const items: TogetherItem[] = rows.map((r) => {
    const reactions = (r.reactions ?? []) as { kind: TogetherReaction; count: number; mine: boolean }[];
    return {
      id: r.id,
      media: {
        id: r.m_id,
        kind: r.m_kind,
        url: r.m_kind === 'video' ? (r.m_variants?.mp4 ?? r.m_url) : r.m_url,
        altText: r.m_alt ?? null,
        width: r.m_width ?? null,
        height: r.m_height ?? null,
        variants: r.m_variants ?? {},
        posterUrl: r.m_poster ?? null,
        hlsUrl: r.m_hls ?? null,
        placeholder: r.m_blur ?? null,
        durationMs: r.m_duration ?? null,
        processing: r.m_status !== 'ready',
        ...(r.m_moderation === 'sensitive' ? { sensitive: true } : {}),
      },
      caption: r.caption ?? '',
      takenAt: new Date(r.captured_at).toISOString(),
      takenFromFile: r.taken_source === 'file',
      addedAt: new Date(r.created_at).toISOString(),
      author: publicUserFrom(r, 'u_'),
      mine: r.user_id === viewer,
      stars: r.stars,
      starred: r.starred,
      reactions,
      comments: r.comments,
      best: false,
      fileName: togetherFileName(title, r.id, r.m_kind, r.m_url),
    };
  });
  return items;
}

/** The best of from these items (marks them in place) and its ids, oldest first. */
export function markBestOf(items: TogetherItem[]): string[] {
  const best = pickBestOf(
    items.map((i) => ({
      id: i.id,
      authorId: i.author.id,
      stars: i.stars,
      reactions: i.reactions.reduce((n, r) => n + r.count, 0),
      takenAt: i.takenAt,
    })),
  );
  const set = new Set(best);
  for (const i of items) i.best = set.has(i.id);
  return best;
}

/** People in an album as viewer `v` sees them: hosts first, then by when they joined. */
export async function albumMembers(db: Q, albumId: string, viewer: string): Promise<TogetherMember[]> {
  const { rows } = await db.query(
    `SELECT m.role, ${U_COLS},
            (SELECT count(*) FROM together_contributions c WHERE c.together_id = m.together_id AND c.user_id = m.user_id AND c.deleted_at IS NULL)::int AS items
     FROM together_members m JOIN profiles pr ON pr.user_id = m.user_id JOIN users au ON au.id = m.user_id
     WHERE m.together_id = $1 AND au.status = 'active' AND (m.user_id = $2 OR ${notBlockedSql('m.user_id', '$2')})
     ORDER BY CASE m.role WHEN 'creator' THEN 0 WHEN 'cohost' THEN 1 ELSE 2 END, m.joined_at, m.user_id`,
    [albumId, viewer],
  );
  return rows.map((r) => ({ user: publicUserFrom(r, 'u_'), role: roleOf(r.role), items: r.items }));
}

/** An item's comments for viewer `v`, oldest first. */
export async function itemComments(db: Q, itemId: string, viewer: string, canManage: boolean): Promise<TogetherComment[]> {
  const { rows } = await db.query(
    `SELECT cm.id, cm.body, cm.created_at, cm.author_id, ${U_COLS}
     FROM together_comments cm JOIN profiles pr ON pr.user_id = cm.author_id JOIN users au ON au.id = cm.author_id
     WHERE cm.item_id = $1 AND cm.deleted_at IS NULL AND au.status = 'active' AND ${notBlockedSql('cm.author_id', '$2')}
     ORDER BY cm.created_at, cm.id LIMIT 500`,
    [itemId, viewer],
  );
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    author: publicUserFrom(r, 'u_'),
    createdAt: new Date(r.created_at).toISOString(),
    mine: r.author_id === viewer,
    canDelete: r.author_id === viewer || canManage,
  }));
}

export type AddCheck = 'ok' | 'missing' | 'blocked' | 'minor' | 'member';

/**
 * Whether `adder` may put each person in album `albumId` (NULL for a new one): an active account,
 * nobody blocked on either side with the adder or the host, and the minor rule (an adult and
 * someone under 18 only when they're friends). People already in it come back as 'member'.
 */
export async function addChecks(db: Q, adder: string, host: string, albumId: string | null, userIds: string[]): Promise<Map<string, AddCheck>> {
  const out = new Map<string, AddCheck>();
  if (!userIds.length) return out;
  const { rows } = await db.query(
    `SELECT x.id, u.id IS NOT NULL AS found,
            (${notBlockedSql('x.id', '$1::uuid')} AND ${notBlockedSql('x.id', '$2::uuid')}) AS unblocked,
            (${minorRuleSql('$1::uuid', 'x.id')}) AS minor_ok,
            EXISTS (SELECT 1 FROM together_members m WHERE m.together_id = $4 AND m.user_id = x.id) AS member
     FROM unnest($3::uuid[]) AS x(id) LEFT JOIN users u ON u.id = x.id AND u.status = 'active'`,
    [adder, host, [...new Set(userIds)], albumId],
  );
  for (const r of rows) out.set(r.id, !r.found ? 'missing' : r.member ? 'member' : !r.unblocked ? 'blocked' : !r.minor_ok ? 'minor' : 'ok');
  return out;
}

/** Everyone in an album (active accounts), for realtime updates and notices. */
export async function memberIds(db: Q, albumId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT m.user_id FROM together_members m JOIN users u ON u.id = m.user_id WHERE m.together_id = $1 AND u.status = 'active'`,
    [albumId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * "Ada added 12 photos to Lagos weekend": at most one notification per album, per person who
 * adds and per member every 30 minutes. More added in that time grows the count on the one
 * already sent (it isn't pushed again). Muting, blocks, paused notifications, the "friends"
 * category and quiet hours apply as for any notification (services.notify).
 */
export async function noticeAdded(
  db: Q,
  realtime: RealtimeHub,
  album: { id: string; title: string },
  actorId: string,
  added: { count: number; videos: number },
): Promise<void> {
  const others = (await memberIds(db, album.id)).filter((m) => m !== actorId);
  if (!others.length) return;
  const grown = await db.query<{ user_id: string }>(
    `UPDATE notifications SET data = data || jsonb_build_object('count', coalesce((data->>'count')::int, 0) + $4::int, 'videos', coalesce((data->>'videos')::int, 0) + $5::int, 'title', $6::text)
     WHERE type = 'together_added' AND entity_id = $1 AND actor_id = $2 AND user_id = ANY($3::uuid[])
       AND created_at > now() - make_interval(mins => ${TOGETHER_ADDED_NOTICE_MINUTES})
     RETURNING user_id`,
    [album.id, actorId, others, added.count, added.videos, album.title],
  );
  const done = new Set(grown.rows.map((r) => r.user_id));
  for (const userId of others) {
    if (done.has(userId)) continue;
    await notify(db, realtime, {
      userId,
      category: 'friends',
      type: 'together_added',
      actorId,
      entityType: 'together',
      entityId: album.id,
      data: { title: album.title, count: added.count, videos: added.videos },
    });
  }
}

/**
 * Tell an album's members it closed (once per closing): the host who closed it early is the
 * actor, so they aren't told; when its time came, nobody is. Returns how many albums.
 */
export async function announceClosed(db: Q, realtime: RealtimeHub, albumId?: string): Promise<number> {
  const { rows } = await db.query<{ id: string; title: string; closed_by: string | null }>(
    `UPDATE togethers SET closed_notified_at = now()
     WHERE id IN (SELECT id FROM togethers WHERE status = 'closed' AND closed_notified_at IS NULL AND deleted_at IS NULL AND ($1::uuid IS NULL OR id = $1)
                  ORDER BY closed_at LIMIT 100)
     RETURNING id, title, closed_by`,
    [albumId ?? null],
  );
  for (const t of rows) {
    const people = await memberIds(db, t.id);
    await realtime.publish(people, { type: 'together.updated', data: { togetherId: t.id } });
    for (const userId of people)
      await notify(db, realtime, {
        userId,
        category: 'friends',
        type: 'together_closed',
        ...(t.closed_by ? { actorId: t.closed_by } : {}),
        entityType: 'together',
        entityId: t.id,
        data: { title: t.title },
      }).catch(() => {});
  }
  return rows.length;
}

/**
 * The Together sweep (every few seconds with the job worker): albums whose time has come
 * close; members of albums closing within the hour hear it once (not for albums that were
 * only open about that long anyway); and members of albums that closed hear it once.
 */
export async function sweepTogethers(deps: { db: Pool; realtime: RealtimeHub }): Promise<void> {
  const { db, realtime } = deps;
  await closeIfDue(db);
  const soon = await db.query<{ id: string; title: string; closes_at: Date }>(
    `UPDATE togethers SET closing_notified_at = now()
     WHERE id IN (SELECT id FROM togethers
                  WHERE status = 'open' AND deleted_at IS NULL AND closing_notified_at IS NULL AND closes_at > now()
                    AND closes_at <= now() + make_interval(mins => ${TOGETHER_CLOSING_NOTICE_MINUTES})
                    AND closes_at - opened_at > make_interval(mins => ${TOGETHER_CLOSING_NOTICE_MINUTES + 30})
                  ORDER BY closes_at LIMIT 100)
     RETURNING id, title, closes_at`,
  );
  for (const t of soon.rows)
    for (const userId of await memberIds(db, t.id))
      await notify(db, realtime, {
        userId,
        category: 'friends',
        type: 'together_closing',
        entityType: 'together',
        entityId: t.id,
        data: { title: t.title, closesAt: new Date(t.closes_at).toISOString() },
      }).catch(() => {});
  await announceClosed(db, realtime);
}
