import type { Pool, PoolClient } from 'pg';
import type { Post } from '@yapilapi/shared';
import { publicUserFrom } from './users.ts';

type Q = Pool | PoolClient;

/** Load full Post DTOs for ids (already authorized by the caller), preserving order. */
export async function hydratePosts(db: Q, ids: string[], viewer: string | null, reasons?: Map<string, string>): Promise<Post[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT p.id, p.kind, p.body, p.visibility, p.link_url, p.topics, p.like_count, p.comment_count, p.created_at, p.ai_provenance, p.metadata->'real' AS real,
            pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode,
            c.id AS c_id, c.slug AS c_slug, c.name AS c_name,
            e.id AS e_id, e.title AS e_title, e.starts_at AS e_starts_at,
            pd.id AS pd_id, pd.title AS pd_title, pd.price_cents AS pd_price, pd.currency AS pd_currency,
            EXISTS (SELECT 1 FROM reactions r WHERE r.post_id = p.id AND r.user_id = $2) AS liked,
            EXISTS (SELECT 1 FROM saves s WHERE s.post_id = p.id AND s.user_id = $2) AS saved,
            (SELECT coalesce(json_agg(json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height, 'variants', m.variants, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash) ORDER BY pm.position), '[]')
               FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id) AS media,
            (SELECT json_agg(json_build_object('id', o.id, 'label', o.label, 'votes', (SELECT count(*) FROM poll_votes v WHERE v.option_id = o.id)) ORDER BY o.position)
               FROM poll_options o WHERE o.post_id = p.id) AS poll_options,
            (SELECT option_id FROM poll_votes v WHERE v.post_id = p.id AND v.user_id = $2) AS my_vote
     FROM posts p
     JOIN profiles pr ON pr.user_id = p.author_id
     LEFT JOIN communities c ON c.id = p.community_id
     LEFT JOIN events e ON e.id = p.event_id AND e.deleted_at IS NULL
     LEFT JOIN products pd ON pd.id = p.product_id AND pd.deleted_at IS NULL
     WHERE p.id = ANY($1)`,
    [ids, viewer],
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
        counts: { likes: r.like_count, comments: r.comment_count },
        viewer: { liked: r.liked, saved: r.saved },
        aiAssisted: !!r.ai_provenance?.assisted,
        real: r.real ?? null,
        createdAt: r.created_at.toISOString(),
        reason: reasons?.get(r.id),
      } satisfies Post,
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((p): p is Post => !!p);
}
