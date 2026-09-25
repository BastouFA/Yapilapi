import type { SearchDocument } from './opensearch.js';
import type { SearchType, SqlRunner } from './types.js';

/**
 * Postgres -> index document extraction for external backends (OpenSearch). Data minimisation: only content that
 * is public (or community-scoped) is indexed, and no audience data is ever included. The API re-checks every hit
 * against the real visibility predicates anyway (defence in depth).
 *
 * Keyset over `id` so a full reindex can run in bounded batches.
 */

const SOURCES: Record<SearchType, string> = {
  people: `SELECT pr.user_id AS id, pr.display_name AS title, pr.username::text || ' ' || pr.bio AS body, pr.follower_count AS popularity,
                  pr.created_at, NULL::text AS kind, NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::float8 AS lat, NULL::float8 AS lng,
                  NULL::int AS capacity, NULL::int AS price_cents, '{}'::text[] AS topics
             FROM profiles pr JOIN users u ON u.id = pr.user_id AND u.deleted_at IS NULL AND u.status = 'active' WHERE pr.user_id > $1::uuid ORDER BY pr.user_id LIMIT $2`,
  creators: `SELECT pr.user_id AS id, pr.display_name AS title, pr.username::text || ' ' || pr.bio AS body, pr.follower_count AS popularity,
                  pr.created_at, NULL::text AS kind, NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::float8 AS lat, NULL::float8 AS lng,
                  NULL::int AS capacity, NULL::int AS price_cents, '{}'::text[] AS topics
             FROM profiles pr JOIN users u ON u.id = pr.user_id AND u.deleted_at IS NULL AND u.status = 'active' WHERE pr.mode = 'creator' AND pr.user_id > $1::uuid ORDER BY pr.user_id LIMIT $2`,
  posts: `SELECT p.id, left(p.body, 80) AS title, p.body, p.like_count + 2 * p.comment_count + 3 * p.share_count AS popularity, p.created_at, p.kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, p.latitude AS lat, p.longitude AS lng, NULL::int AS capacity, NULL::int AS price_cents,
                 COALESCE((SELECT array_agg(t.slug::text) FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.post_id = p.id), '{}') AS topics
            FROM posts p WHERE p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.visibility IN ('public','community') AND p.kind <> 'video' AND p.id > $1::uuid ORDER BY p.id LIMIT $2`,
  videos: `SELECT p.id, left(p.body, 80) AS title, p.body, p.like_count + 2 * p.comment_count + 3 * p.share_count + p.view_count / 20 AS popularity, p.created_at, p.kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, p.latitude AS lat, p.longitude AS lng, NULL::int AS capacity, NULL::int AS price_cents,
                 COALESCE((SELECT array_agg(t.slug::text) FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.post_id = p.id), '{}') AS topics
            FROM posts p WHERE p.deleted_at IS NULL AND p.moderation_status = 'approved' AND p.visibility IN ('public','community') AND p.kind = 'video' AND p.id > $1::uuid ORDER BY p.id LIMIT $2`,
  communities: `SELECT c.id, c.name AS title, c.description AS body, c.member_count AS popularity, c.created_at, c.visibility AS kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::float8 AS lat, NULL::float8 AS lng, NULL::int AS capacity, NULL::int AS price_cents,
                 COALESCE((SELECT array_agg(t.slug::text) FROM community_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.community_id = c.id), '{}') AS topics
            FROM communities c WHERE c.deleted_at IS NULL AND c.visibility IN ('public','private') AND c.id > $1::uuid ORDER BY c.id LIMIT $2`,
  events: `SELECT e.id, e.title, e.description AS body, e.going_count + e.interested_count AS popularity, e.created_at, NULL::text AS kind,
                 e.starts_at, e.ends_at, COALESCE(e.latitude, pl.latitude) AS lat, COALESCE(e.longitude, pl.longitude) AS lng, e.capacity, NULL::int AS price_cents,
                 COALESCE((SELECT array_agg(t.slug::text) FROM event_topics et JOIN topics t ON t.id = et.topic_id WHERE et.event_id = e.id), '{}') AS topics
            FROM events e LEFT JOIN places pl ON pl.id = e.place_id
           WHERE e.deleted_at IS NULL AND e.status = 'published' AND e.visibility IN ('public','community') AND e.id > $1::uuid ORDER BY e.id LIMIT $2`,
  places: `SELECT pl.id, pl.name AS title, pl.description AS body, pl.rating_count AS popularity, pl.created_at, pl.kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, pl.latitude AS lat, pl.longitude AS lng, pl.capacity, NULL::int AS price_cents, '{}'::text[] AS topics
            FROM places pl WHERE pl.deleted_at IS NULL AND pl.id > $1::uuid ORDER BY pl.id LIMIT $2`,
  businesses: `SELECT b.id, b.name AS title, b.category || ' ' || b.description AS body, CASE WHEN b.verified_at IS NULL THEN 0 ELSE 20 END AS popularity, b.created_at, b.category AS kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::float8 AS lat, NULL::float8 AS lng, NULL::int AS capacity, NULL::int AS price_cents, '{}'::text[] AS topics
            FROM businesses b WHERE b.deleted_at IS NULL AND b.status = 'active' AND b.id > $1::uuid ORDER BY b.id LIMIT $2`,
  products: `SELECT pd.id, pd.title, pd.description AS body, pd.rating_count AS popularity, pd.created_at, pd.kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::float8 AS lat, NULL::float8 AS lng, NULL::int AS capacity, pd.price_cents, '{}'::text[] AS topics
            FROM products pd WHERE pd.deleted_at IS NULL AND pd.status = 'active' AND pd.id > $1::uuid ORDER BY pd.id LIMIT $2`,
  topics: `SELECT tp.id, tp.name AS title, tp.slug::text AS body, 0 AS popularity, tp.created_at, NULL::text AS kind,
                 NULL::timestamptz AS starts_at, NULL::timestamptz AS ends_at, NULL::float8 AS lat, NULL::float8 AS lng, NULL::int AS capacity, NULL::int AS price_cents, '{}'::text[] AS topics
            FROM topics tp WHERE tp.id > $1::uuid ORDER BY tp.id LIMIT $2`,
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

/** Columns selected by every entry of `SOURCES`. */
interface DocumentRow {
  id: string;
  title: unknown;
  body?: unknown;
  popularity: unknown;
  created_at?: unknown;
  kind?: SearchDocument['kind'] | null;
  starts_at?: unknown;
  ends_at?: unknown;
  lat?: number | null;
  lng?: number | null;
  capacity?: number | null;
  price_cents?: number | null;
  topics?: string[] | null;
}

/** One batch of index documents for `type` after `afterId` (pass undefined for the first batch). */
export async function fetchDocuments(
  db: SqlRunner,
  type: SearchType,
  afterId: string | undefined,
  limit = 500,
): Promise<SearchDocument[]> {
  const { rows } = await db.query<DocumentRow>(SOURCES[type], [
    afterId ?? NIL_UUID,
    Math.min(Math.max(limit, 1), 1000),
  ]);
  return rows.map((r): SearchDocument => {
    const doc: SearchDocument = {
      type,
      id: r.id,
      title: String(r.title ?? '').slice(0, 300),
      popularity: Number(r.popularity ?? 0),
    };
    if (r.body) doc.body = String(r.body).slice(0, 5000);
    if (r.topics?.length) doc.topics = r.topics;
    if (r.kind) doc.kind = r.kind;
    if (r.created_at) doc.createdAt = iso(r.created_at)!;
    if (r.starts_at) doc.startsAt = iso(r.starts_at)!;
    if (r.ends_at) doc.endsAt = iso(r.ends_at)!;
    if (r.lat !== null && r.lat !== undefined) doc.location = { lat: r.lat, lon: r.lng as number };
    if (r.capacity !== null && r.capacity !== undefined) doc.capacity = r.capacity;
    if (r.price_cents !== null && r.price_cents !== undefined) doc.priceCents = r.price_cents;
    return doc;
  });
}
