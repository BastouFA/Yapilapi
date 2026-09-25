import type { AppContext } from './context.js';
import { mediaUrl } from './media-url.js';
import type { DbRow } from './db-row.js';

/** Columns + joins shared by every endpoint that returns posts. `viewer` is a SQL expr like '$1::uuid'. */
export const postSelect = (viewer: string) => `
  p.id, p.author_id, p.kind, p.body, p.language, p.visibility, p.circle_id, p.community_id, p.event_id, p.product_id,
  p.place_id, p.business_id, p.link_url, p.link_preview, p.latitude, p.longitude, p.rights, p.ai_provenance, p.moderation_status,
  p.like_count, p.comment_count, p.share_count, p.save_count, p.view_count, p.edited_at, p.created_at, p.metadata->'sponsored' AS sponsored,
  pr.username AS author_username, pr.display_name AS author_display_name, pr.avatar_url AS author_avatar_url, pr.mode AS author_mode,
  (SELECT r.kind FROM reactions r WHERE r.user_id = ${viewer} AND r.target_type = 'post' AND r.target_id = p.id) AS my_reaction,
  EXISTS (SELECT 1 FROM saves s WHERE s.user_id = ${viewer} AND s.target_type = 'post' AND s.target_id = p.id) AS saved`;
export const postFrom = `posts p JOIN profiles pr ON pr.user_id = p.author_id`;

export interface PostView {
  id: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    mode: string;
  };
  kind: string;
  body: string;
  language: string | null;
  visibility: string;
  communityId: string | null;
  eventId: string | null;
  productId: string | null;
  placeId: string | null;
  businessId: string | null;
  circleId: string | null;
  link: { url: string; preview: unknown } | null;
  location: { latitude: number; longitude: number } | null;
  media: Array<{
    id: string;
    kind: string;
    url: string;
    mimeType: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    altText: string | null;
    blurhash: string | null;
    status: string;
  }>;
  topics: string[];
  poll: null | {
    question: string;
    multiple: boolean;
    closesAt: string | null;
    options: Array<{ id: string; label: string; votes: number }>;
    myVotes: string[];
    totalVotes: number;
  };
  counts: { likes: number; comments: number; shares: number; saves: number; views: number };
  viewer: { reaction: string | null; saved: boolean; isAuthor: boolean };
  aiProvenance: unknown;
  /** Paid-partnership disclosure ({partnershipId, businessId, label}) when the post is sponsored, else null. Clients MUST show the label. */
  sponsored: { partnershipId: string; businessId: string; label: string } | null;
  rights: unknown;
  moderationStatus: string;
  editedAt: string | null;
  createdAt: string;
  reasons?: string[];
}

type Row = DbRow;

/** Turn post rows (from `postSelect`) into API views, batch-loading media, topics and polls. */
export async function hydratePosts(
  ctx: AppContext,
  viewerId: string | null,
  rows: Row[],
): Promise<PostView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as string);

  const [media, topics, polls] = await Promise.all([
    ctx.db.query(
      `SELECT pm.post_id, m.id, m.kind, m.storage_key, m.mime_type, m.width, m.height, m.duration_ms, m.alt_text, m.blurhash, m.status
         FROM post_media pm JOIN media m ON m.id = pm.media_id
        WHERE pm.post_id = ANY($1::uuid[]) AND m.deleted_at IS NULL ORDER BY pm.post_id, pm.position`,
      [ids],
    ),
    ctx.db.query(
      `SELECT pt.post_id, t.name FROM post_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.post_id = ANY($1::uuid[]) ORDER BY t.name`,
      [ids],
    ),
    ctx.db.query(
      `SELECT po.post_id, po.question, po.multiple, po.closes_at,
              (SELECT json_agg(json_build_object('id', o.id, 'label', o.label, 'votes', o.vote_count) ORDER BY o.position) FROM poll_options o WHERE o.post_id = po.post_id) AS options,
              COALESCE((SELECT array_agg(v.option_id) FROM poll_votes v WHERE v.post_id = po.post_id AND v.user_id = $2::uuid), '{}') AS my_votes
         FROM polls po WHERE po.post_id = ANY($1::uuid[])`,
      [ids, viewerId],
    ),
  ]);

  const mediaBy = new Map<string, PostView['media']>();
  for (const m of media.rows) {
    const list = mediaBy.get(m.post_id) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      url: mediaUrl(ctx.config, m.storage_key),
      mimeType: m.mime_type,
      width: m.width,
      height: m.height,
      durationMs: m.duration_ms,
      altText: m.alt_text,
      blurhash: m.blurhash,
      status: m.status,
    });
    mediaBy.set(m.post_id, list);
  }
  const topicsBy = new Map<string, string[]>();
  for (const t of topics.rows)
    topicsBy.set(t.post_id, [...(topicsBy.get(t.post_id) ?? []), t.name]);
  const pollBy = new Map<string, PostView['poll']>();
  for (const p of polls.rows) {
    const options = (p.options ?? []) as Array<{ id: string; label: string; votes: number }>;
    pollBy.set(p.post_id, {
      question: p.question,
      multiple: p.multiple,
      closesAt: p.closes_at ? new Date(p.closes_at).toISOString() : null,
      options,
      myVotes: p.my_votes ?? [],
      totalVotes: options.reduce((n, o) => n + o.votes, 0),
    });
  }

  return rows.map((r) => ({
    id: r.id,
    author: {
      id: r.author_id,
      username: r.author_username,
      displayName: r.author_display_name,
      avatarUrl: r.author_avatar_url,
      mode: r.author_mode,
    },
    kind: r.kind,
    body: r.body,
    language: r.language,
    visibility: r.visibility,
    communityId: r.community_id,
    eventId: r.event_id,
    productId: r.product_id,
    placeId: r.place_id,
    businessId: r.business_id ?? null,
    circleId: r.circle_id,
    link: r.link_url ? { url: r.link_url, preview: r.link_preview } : null,
    location:
      r.latitude !== null && r.latitude !== undefined
        ? { latitude: r.latitude, longitude: r.longitude }
        : null,
    media: mediaBy.get(r.id) ?? [],
    topics: topicsBy.get(r.id) ?? [],
    poll: pollBy.get(r.id) ?? null,
    counts: {
      likes: r.like_count,
      comments: r.comment_count,
      shares: r.share_count,
      saves: r.save_count,
      views: Number(r.view_count),
    },
    viewer: {
      reaction: r.my_reaction ?? null,
      saved: Boolean(r.saved),
      isAuthor: viewerId === r.author_id,
    },
    aiProvenance: r.ai_provenance,
    sponsored: r.sponsored ?? null,
    rights: r.rights,
    moderationStatus: r.moderation_status,
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}
