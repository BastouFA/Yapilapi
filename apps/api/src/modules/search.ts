import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { searchQuerySchema } from '@yapilapi/shared';
import type { z } from 'zod';
import { parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { parseSearchIntent } from '../lib/ai/intent.ts';
import { hydratePosts } from '../lib/posts.ts';
import { PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { eventVisibleSql, notBlockedSql, postVisibleSql } from '../lib/visibility.ts';
import { EVENT_SELECT, toEvent } from './events.ts';

/**
 * Universal search on Postgres full-text + trigram indexes. Every query applies
 * the same visibility predicates as the feed, so results never leak content the
 * viewer can't open. The SearchBackend boundary is this module: swapping to
 * OpenSearch means replacing these queries, not the callers.
 *
 * Natural-language requests ("something to do tonight", "restaurants for six")
 * go through intent parsing first.
 */
type SearchInput = z.infer<typeof searchQuerySchema>;

/** Universal search as the given viewer. Also used by the AI agents' tools, so they only ever see what the person could find themselves. */
export async function searchAll(db: Pool, viewer: string | null, q: SearchInput) {
  const intent = parseSearchIntent(q.q);
  const terms = intent.terms || (intent.types.length ? '' : q.q);
  const wants = (t: string) => q.type === t || (q.type === 'all' && (!intent.types.length || intent.types.includes(t as never)));
  const tsq = `websearch_to_tsquery('simple', $2)`;
  const tsqEn = `websearch_to_tsquery('english', $2)`;
  const like = `%${terms.replace(/[%_]/g, '')}%`;
  const out: Record<string, unknown> = {};
  const jobs: Promise<void>[] = [];

  if (wants('people'))
    jobs.push(
      db
        .query<PublicUserRow>(
          `SELECT ${PUBLIC_USER_COLS} FROM profiles pr JOIN users u ON u.id = pr.user_id
             WHERE u.status = 'active' AND ${notBlockedSql('pr.user_id', '$1')}
               AND ($2 = '' OR pr.search @@ ${tsq} OR pr.display_name ILIKE $4 OR pr.username ILIKE $4 OR pr.bio ILIKE $4)
               ${intent.creatorsOnly ? `AND pr.mode IN ('creator','professional')` : ''}
             ORDER BY ts_rank(pr.search, ${tsq}) DESC, (SELECT count(*) FROM follows WHERE followee_id = pr.user_id) DESC LIMIT $3`,
          [viewer, terms, q.limit, like],
        )
        .then((r) => void (out.people = r.rows.map(toPublicUser))),
    );

  if (wants('posts') && terms)
    jobs.push(
      db
        .query(
          `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
             WHERE (p.search @@ ${tsqEn} OR p.topics @> ARRAY[$2]::text[]) AND ${postVisibleSql('$1')}
             ORDER BY ts_rank(p.search, ${tsqEn}) DESC, p.created_at DESC LIMIT $3`,
          [viewer, terms, q.limit],
        )
        .then(
          async (r) =>
            void (out.posts = await hydratePosts(
              db,
              r.rows.map((x) => x.id),
              viewer,
            )),
        ),
    );

  if (wants('communities'))
    jobs.push(
      db
        .query(
          `SELECT c.id, c.slug, c.name, c.description, c.member_count, c.topics, c.visibility FROM communities c
             WHERE c.deleted_at IS NULL AND ($1 = '' OR c.search @@ websearch_to_tsquery('english', $1) OR c.name ILIKE $3 OR $1 = ANY(c.topics))
             ORDER BY ts_rank(c.search, websearch_to_tsquery('english', $1)) DESC, c.member_count DESC LIMIT $2`,
          [terms, q.limit, like],
        )
        .then(
          (r) =>
            void (out.communities = r.rows.map((c) => ({
              id: c.id,
              slug: c.slug,
              name: c.name,
              description: c.description,
              memberCount: c.member_count,
              topics: c.topics,
              visibility: c.visibility,
            }))),
        ),
    );

  if (wants('events')) {
    const params: unknown[] = [viewer, terms, q.limit, like];
    let when = `coalesce(e.ends_at, e.starts_at + interval '3 hours') >= now()`;
    if (intent.when) {
      params.push(intent.when.from, intent.when.to);
      when = `e.starts_at < $6::timestamptz AND coalesce(e.ends_at, e.starts_at + interval '3 hours') >= $5::timestamptz`;
    }
    jobs.push(
      db
        .query(
          `${EVENT_SELECT} WHERE ${eventVisibleSql('$1')} AND ${when}
               AND ($2 = '' OR e.search @@ websearch_to_tsquery('english', $2) OR e.title ILIKE $4 OR e.location_text ILIKE $4)
             ORDER BY e.starts_at LIMIT $3`,
          params,
        )
        .then((r) => void (out.events = r.rows.map(toEvent))),
    );
  }

  if (wants('places'))
    jobs.push(
      db
        .query(
          `SELECT pl.id, pl.name, pl.category, pl.description, pl.address, pl.city FROM places pl
             WHERE pl.deleted_at IS NULL AND ($4::text IS NULL OR pl.category = $4)
               AND ($1 = '' OR pl.search @@ websearch_to_tsquery('simple', $1) OR pl.name ILIKE $3 OR pl.city ILIKE $3 OR pl.description ILIKE $3)
             ORDER BY ts_rank(pl.search, websearch_to_tsquery('simple', $1)) DESC LIMIT $2`,
          [terms, q.limit, like, intent.placeCategory ?? null],
        )
        .then((r) => void (out.places = r.rows)),
    );

  if (wants('businesses'))
    jobs.push(
      db
        .query(
          `SELECT b.id, b.slug, b.name, b.category, b.description FROM businesses b
             WHERE b.deleted_at IS NULL AND ($1 = '' OR b.search @@ websearch_to_tsquery('english', $1) OR b.name ILIKE $3) LIMIT $2`,
          [terms, q.limit, like],
        )
        .then((r) => void (out.businesses = r.rows)),
    );

  if (wants('products'))
    jobs.push(
      db
        .query(
          `SELECT pd.id, pd.kind, pd.title, pd.price_cents AS "priceCents", pd.currency FROM products pd
             WHERE pd.deleted_at IS NULL AND pd.status = 'active' AND ($1 = '' OR pd.search @@ websearch_to_tsquery('english', $1) OR pd.title ILIKE $3) LIMIT $2`,
          [terms, q.limit, like],
        )
        .then((r) => void (out.products = r.rows)),
    );

  if (wants('topics') && terms)
    jobs.push(
      db
        .query(`SELECT slug, name FROM topics WHERE slug ILIKE $1 OR name ILIKE $1 ORDER BY name LIMIT $2`, [like, q.limit])
        .then((r) => void (out.topics = r.rows)),
    );

  await Promise.all(jobs);
  return { query: q.q, intent, results: out };
}

export default async function searchModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  app.get('/v1/search', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) =>
    searchAll(db, req.user?.id ?? null, parse(searchQuerySchema, req.query)),
  );

  /** NOW: what is happening right now, from public or visible sources only. */
  app.get('/v1/now', async (req) => {
    const viewer = req.user?.id ?? null;
    const [events, trending, active] = await Promise.all([
      db.query(
        `${EVENT_SELECT} WHERE ${eventVisibleSql('$1')} AND e.starts_at <= now() + interval '3 hours' AND coalesce(e.ends_at, e.starts_at + interval '3 hours') >= now()
         ORDER BY e.starts_at LIMIT 10`,
        [viewer],
      ),
      db.query(
        `SELECT t AS topic, count(*) AS posts FROM posts p, unnest(p.topics) t
         WHERE p.created_at > now() - interval '24 hours' AND p.visibility = 'public' AND p.deleted_at IS NULL AND p.moderation_status = 'normal'
         GROUP BY t ORDER BY count(*) DESC LIMIT 10`,
      ),
      db.query(
        `SELECT c.slug, c.name, count(p.id) AS posts FROM communities c JOIN posts p ON p.community_id = c.id
         WHERE c.visibility = 'public' AND p.created_at > now() - interval '24 hours' AND p.deleted_at IS NULL
         GROUP BY c.id ORDER BY count(p.id) DESC LIMIT 5`,
      ),
    ]);
    return { events: events.rows.map(toEvent), trendingTopics: trending.rows, activeCommunities: active.rows };
  });
}
