import type { FastifyInstance, FastifyReply } from 'fastify';
import { usernameSchema, type PublicCommunityPreview, type PublicEventPreview, type PublicPostPreview, type PublicProfilePreview } from '@yapilapi/shared';
import { z } from 'zod';
import { notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { eventVisibleSql, postVisibleSql } from '../lib/visibility.ts';

/**
 * Public previews: what anyone can see of a shared link without an account.
 * Link previews (WhatsApp, iMessage, X, Slack…) and the signed-out view of a
 * post, reel, profile, event or community read from here.
 *
 * Every query runs as an anonymous viewer, whoever is asking, so a response
 * never depends on a session and can be cached by a CDN. On top of the usual
 * visibility rules (evaluated for a viewer who isn't signed in, including
 * regional withholding by the request's country), a preview needs:
 * - public audience (not followers, friends, circles or chosen people);
 *   subscriber-only posts get a locked preview (author and counts, never the
 *   text, image or video);
 * - an active, public account that doesn't belong to someone under 18;
 * - nothing waiting for review, restricted or removed.
 */

const EXCERPT_CHARS = 200;
const RATE = { max: 120, timeWindow: '1 minute' };
const idParam = z.object({ id: z.string().uuid() });
const slugParam = z.object({ slug: z.string().min(1).max(40) });
const usernameParam = z.object({ username: usernameSchema });

/** Accounts whose content may appear in a public preview. `pr` = profile, `u` = user. */
function publicAccountSql(pr: string, u: string): string {
  return `(${u}.status = 'active' AND ${u}.deleted_at IS NULL AND NOT ${pr}.is_private
           AND NOT coalesce(${u}.birth_date > current_date - interval '18 years', false))`;
}

/** Collapse whitespace and trim to about 200 characters, on a word boundary where there is one. */
export function excerpt(text: string | null | undefined, max = EXCERPT_CHARS): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

export default async function publicModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const countryHeader = ctx.config.TRUSTED_COUNTRY_HEADER?.toLowerCase();

  /** Cacheable by browsers and CDNs; varies by country when regional rules can apply. */
  function cacheable(reply: FastifyReply) {
    reply.header('cache-control', 'public, max-age=300');
    if (countryHeader) reply.header('vary', countryHeader);
  }

  app.get('/v1/public/posts/:id', { config: { rateLimit: RATE } }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    reply.header('cache-control', 'no-store');
    const { rows } = await db.query(
      `SELECT p.id, p.format, p.kind, p.visibility, p.like_count, p.comment_count, p.repost_count, p.created_at,
              CASE WHEN p.visibility = 'public' THEN p.body ELSE '' END AS body,
              ap.username, ap.display_name, ap.avatar_url, c.slug AS c_slug, c.name AS c_name,
              (SELECT json_build_object('kind', m.kind, 'url', m.url, 'mime', m.mime, 'posterUrl', m.poster_url, 'mp4', m.variants->>'mp4',
                                        'width', m.width, 'height', m.height, 'durationMs', m.duration_ms, 'alt', m.alt_text)
                 FROM post_media pm JOIN media m ON m.id = pm.media_id
                 WHERE pm.post_id = p.id AND p.visibility = 'public' AND m.kind IN ('image', 'video') AND m.status = 'ready'
                 ORDER BY pm.position LIMIT 1) AS media
       FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       LEFT JOIN communities c ON c.id = p.community_id
       WHERE p.id = $2 AND ${postVisibleSql('$1')}
         AND p.visibility IN ('public', 'subscribers') AND p.moderation_status = 'normal' AND p.deleted_at IS NULL
         AND (p.community_id IS NULL OR (c.visibility = 'public' AND c.deleted_at IS NULL))
         AND ${publicAccountSql('ap', 'au')}`,
      [null, id],
    );
    const r = rows[0];
    if (!r) throw notFound('That post');
    const m = r.media as {
      kind: 'image' | 'video';
      url: string;
      mime: string | null;
      posterUrl: string | null;
      mp4: string | null;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      alt: string | null;
    } | null;
    const imageUrl = m ? (m.kind === 'image' ? m.url : m.posterUrl) : null;
    const videoUrl = m?.kind === 'video' ? (m.mp4 ?? (m.mime === 'video/mp4' ? m.url : null)) : null;
    const post: PublicPostPreview = {
      id: r.id,
      format: r.format ?? 'post',
      kind: r.kind,
      excerpt: excerpt(r.body),
      author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      image: imageUrl ? { url: imageUrl, width: m!.width, height: m!.height, alt: m!.alt } : null,
      video: videoUrl ? { url: videoUrl, width: m!.width, height: m!.height, durationMs: m!.durationMs } : null,
      counts: { likes: r.like_count, comments: r.comment_count, reposts: r.repost_count ?? 0 },
      community: r.c_slug ? { slug: r.c_slug, name: r.c_name } : null,
      createdAt: r.created_at.toISOString(),
      ...(r.visibility === 'subscribers' ? { locked: true } : {}),
    };
    cacheable(reply);
    return { post };
  });

  app.get('/v1/public/users/:username', { config: { rateLimit: RATE } }, async (req, reply) => {
    const { username } = parse(usernameParam, req.params);
    reply.header('cache-control', 'no-store');
    const { rows } = await db.query(
      `SELECT pr.username, pr.display_name, pr.avatar_url, pr.cover_url, pr.mode, pr.bio,
              (SELECT count(*) FROM follows WHERE followee_id = pr.user_id)::int AS followers,
              (SELECT count(*) FROM follows WHERE follower_id = pr.user_id)::int AS following,
              (SELECT count(*) FROM posts WHERE author_id = pr.user_id AND deleted_at IS NULL AND community_id IS NULL)::int AS posts
       FROM profiles pr JOIN users u ON u.id = pr.user_id
       WHERE lower(pr.username) = lower($1) AND ${publicAccountSql('pr', 'u')}`,
      [username],
    );
    const r = rows[0];
    if (!r) throw notFound('That profile');
    const profile: PublicProfilePreview = {
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      coverUrl: r.cover_url,
      mode: r.mode,
      bio: excerpt(r.bio),
      counts: { followers: r.followers, following: r.following, posts: r.posts },
    };
    cacheable(reply);
    return { profile };
  });

  app.get('/v1/public/events/:id', { config: { rateLimit: RATE } }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    reply.header('cache-control', 'no-store');
    const { rows } = await db.query(
      `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.timezone, e.online, e.location_text,
              pr.username, pr.display_name, pr.avatar_url, pl.name AS pl_name, c.slug AS c_slug, c.name AS c_name,
              (SELECT count(*) FROM event_attendees WHERE event_id = e.id AND status = 'going')::int AS going,
              (SELECT count(*) FROM event_attendees WHERE event_id = e.id AND status = 'interested')::int AS interested
       FROM events e JOIN profiles pr ON pr.user_id = e.host_id JOIN users u ON u.id = e.host_id
       LEFT JOIN places pl ON pl.id = e.place_id AND pl.deleted_at IS NULL
       LEFT JOIN communities c ON c.id = e.community_id
       WHERE e.id = $2 AND ${eventVisibleSql('$1')} AND e.visibility = 'public' AND e.deleted_at IS NULL
         AND (e.community_id IS NULL OR (c.visibility = 'public' AND c.deleted_at IS NULL))
         AND ${publicAccountSql('pr', 'u')}`,
      [null, id],
    );
    const r = rows[0];
    if (!r) throw notFound('Event');
    const event: PublicEventPreview = {
      id: r.id,
      title: r.title,
      excerpt: excerpt(r.description),
      host: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at?.toISOString() ?? null,
      timezone: r.timezone,
      online: r.online,
      locationText: r.location_text,
      place: r.pl_name ? { name: r.pl_name } : null,
      community: r.c_slug ? { slug: r.c_slug, name: r.c_name } : null,
      counts: { going: r.going, interested: r.interested },
    };
    cacheable(reply);
    return { event };
  });

  app.get('/v1/public/communities/:slug', { config: { rateLimit: RATE } }, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);
    reply.header('cache-control', 'no-store');
    const { rows } = await db.query(
      `SELECT c.slug, c.name, c.description, c.member_count, c.topics
       FROM communities c WHERE lower(c.slug) = lower($1) AND c.visibility = 'public' AND c.deleted_at IS NULL`,
      [slug],
    );
    const r = rows[0];
    if (!r) throw notFound('Community');
    const community: PublicCommunityPreview = {
      slug: r.slug,
      name: r.name,
      excerpt: excerpt(r.description),
      memberCount: r.member_count,
      topics: r.topics,
    };
    cacheable(reply);
    return { community };
  });
}
