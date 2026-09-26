import type { Pool, PoolClient } from 'pg';
import type { MediaItem, Post, RemixRef } from '@yapilapi/shared';
import { plusCol, publicUserFrom } from './users.ts';
import { postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/** Load full Post DTOs for ids (already authorized by the caller), preserving order. */
export async function hydratePosts(db: Q, ids: string[], viewer: string | null, reasons?: Map<string, string>): Promise<Post[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.kind, p.format, p.body, p.visibility, p.link_url, p.topics, p.like_count, p.comment_count, p.view_count, p.created_at, p.ai_provenance, p.metadata->'real' AS real,
            pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')},
            c.id AS c_id, c.slug AS c_slug, c.name AS c_name,
            e.id AS e_id, e.title AS e_title, e.starts_at AS e_starts_at,
            pd.id AS pd_id, pd.title AS pd_title, pd.price_cents AS pd_price, pd.currency AS pd_currency,
            EXISTS (SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS liked,
            EXISTS (SELECT 1 FROM saves s WHERE s.post_id = p.id AND s.user_id = $2) AS saved,
            EXISTS (SELECT 1 FROM post_reposts rp WHERE rp.post_id = p.id AND rp.user_id = $2) AS reposted, p.repost_count,
            (SELECT coalesce(json_agg(json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height, 'variants', m.variants, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash,
                                                   'captions', (SELECT coalesce(json_agg(json_build_object('lang', ct.lang, 'label', ct.label, 'url', ct.url) ORDER BY ct.lang), '[]')
                                                                FROM caption_tracks ct WHERE ct.media_id = m.id AND ct.status = 'ready')) ORDER BY pm.position), '[]')
               FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id) AS media,
            (SELECT json_agg(json_build_object('id', o.id, 'label', o.label, 'votes', (SELECT count(*) FROM poll_votes v WHERE v.option_id = o.id)) ORDER BY o.position)
               FROM poll_options o WHERE o.post_id = p.id) AS poll_options,
            (SELECT option_id FROM poll_votes v WHERE v.post_id = p.id AND v.user_id = $2) AS my_vote,
            (SELECT array_agg(DISTINCT w.country ORDER BY w.country) FROM post_withholdings w WHERE w.post_id = p.id AND p.author_id = $2) AS withheld_in,
            p.allow_remix, p.remix_mode, p.remix_of_post_id,
            CASE WHEN p.format = 'reel' THEN (SELECT count(*) FROM posts rx WHERE rx.remix_of_post_id = p.id AND rx.deleted_at IS NULL)::int END AS remix_count,
            s.id AS s_id, s.title AS s_title, s.source_post_id AS s_source, coalesce(s.duration_ms, sm.duration_ms) AS s_duration,
            coalesce(sm.variants->>'mp4', sm.url) AS s_audio
     FROM posts p
     JOIN profiles pr ON pr.user_id = p.author_id
     LEFT JOIN sounds s ON s.id = p.sound_id
     LEFT JOIN media sm ON sm.id = s.media_id
     LEFT JOIN communities c ON c.id = p.community_id
     LEFT JOIN events e ON e.id = p.event_id AND e.deleted_at IS NULL
     LEFT JOIN products pd ON pd.id = p.product_id AND pd.deleted_at IS NULL
     WHERE p.id = ANY($1)`,
    [ids, viewer],
  );
  const originals = await remixOriginals(
    db,
    rows.map((r) => r.remix_of_post_id as string | null).filter((x): x is string => !!x),
    viewer,
  );
  const byId = new Map<string, Post>(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id,
        kind: r.kind,
        body: r.body,
        visibility: r.visibility,
        author: publicUserFrom(r, 'a_'),
        media: r.media,
        linkUrl: r.link_url,
        poll: r.poll_options ? { options: r.poll_options, myVote: r.my_vote } : null,
        topics: r.topics,
        community: r.c_id ? { id: r.c_id, slug: r.c_slug, name: r.c_name } : null,
        event: r.e_id ? { id: r.e_id, title: r.e_title, startsAt: r.e_starts_at.toISOString() } : null,
        product: r.pd_id ? { id: r.pd_id, title: r.pd_title, priceCents: r.pd_price, currency: r.pd_currency } : null,
        counts: {
          likes: r.like_count,
          comments: r.comment_count,
          reposts: r.repost_count ?? 0,
          views: r.view_count ?? 0,
          ...(r.remix_count === null ? {} : { remixes: r.remix_count }),
        },
        viewer: { liked: r.liked, saved: r.saved, reposted: r.reposted },
        aiAssisted: !!r.ai_provenance?.assisted,
        real: r.real ?? null,
        createdAt: r.created_at.toISOString(),
        format: r.format ?? 'post',
        ...(r.format === 'reel'
          ? {
              allowRemix: r.allow_remix,
              remixOf: r.remix_mode ? { mode: r.remix_mode, post: (r.remix_of_post_id && originals.get(r.remix_of_post_id)) || null } : null,
              sound: r.s_id
                ? { id: r.s_id, title: r.s_title, durationMs: r.s_duration ?? null, audioUrl: r.s_audio ?? null, original: r.s_source === r.id }
                : null,
            }
          : {}),
        reason: reasons?.get(r.id),
        ...(r.withheld_in ? { withheldIn: r.withheld_in.map((c: string) => c.trim()) } : {}),
      } satisfies Post,
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((p): p is Post => !!p);
}

/** The reels that remixes and duets credit: author, text and first video, only where the viewer can still see them. */
async function remixOriginals(db: Q, ids: string[], viewer: string | null): Promise<Map<string, NonNullable<RemixRef['post']>>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.body, ap.user_id AS a_id, ap.username AS a_username, ap.display_name AS a_display_name, ap.avatar_url AS a_avatar_url, ap.mode AS a_mode,
            ${plusCol('a_', 'ap')},
            (SELECT json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height,
                                      'variants', m.variants, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash)
               FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id ORDER BY pm.position LIMIT 1) AS media
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.id = ANY($1) AND ${postVisibleSql('$2')}`,
    [[...new Set(ids)], viewer],
  );
  return new Map(rows.map((r) => [r.id as string, { id: r.id, body: r.body, author: publicUserFrom(r, 'a_'), media: (r.media as MediaItem | null) ?? null }]));
}
