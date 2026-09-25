import { withTransaction } from '@yapilapi/database';
import {
  AppError,
  conflict,
  forbidden,
  invalid,
  notFound,
  type Visibility,
} from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { screenText } from '../../lib/moderation-hook.js';
import { hasCommunityPermission } from '../../lib/community-access.js';
import { isBlockedEitherWay } from '../../lib/users.js';

export interface CreatePostInput {
  body: string;
  visibility?: Visibility | undefined;
  circleId?: string | undefined;
  audience?: string[] | undefined;
  communityId?: string | undefined;
  topics?: string[] | undefined;
  mediaIds?: string[] | undefined;
  poll?:
    | { question: string; options: string[]; multiple: boolean; closesInHours?: number | undefined }
    | undefined;
  linkUrl?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  placeId?: string | undefined;
  /** Set by the events module (event discussion posts) — not exposed on POST /v1/posts. */
  eventId?: string | undefined;
  /** Set by the business module (a team member posting on behalf of a business) — not exposed on POST /v1/posts. */
  businessId?: string | undefined;
  /** Set by the commerce module (a seller promoting their product) — not exposed on POST /v1/posts. */
  productId?: string | undefined;
  language?: string | undefined;
  license?: string | undefined;
  aiAssistance?: { tools: string[] } | undefined;
  /**
   * Server-side metadata set by trusted modules only (creator: `sponsored` for brand partnerships; NOT exposed on POST /v1/posts).
   * `minTier` (1-10) narrows a `subscribers` post to subscribers of at least that plan tier.
   */
  metadata?: Record<string, unknown> | undefined;
  minTier?: number | undefined;
}

export interface Author {
  userId: string;
  ageBand: 'teen' | 'adult';
}

/**
 * Create a post, enforcing every publishing rule server-side. Also used by the AI/creator modules after the
 * user explicitly confirms a draft (AI never publishes on its own).
 */
export async function createPost(
  ctx: AppContext,
  author: Author,
  input: CreatePostInput,
): Promise<string> {
  if (!input.body.trim() && !input.mediaIds?.length && !input.poll)
    throw invalid('A post needs text, media or a poll');

  // Resolve visibility.
  let visibility: Visibility = input.visibility ?? (input.communityId ? 'community' : 'public');
  if (!input.visibility && !input.communityId) {
    const { rows } = await ctx.db.query<{ default_post_visibility: Visibility }>(
      'SELECT default_post_visibility FROM user_preferences WHERE user_id = $1',
      [author.userId],
    );
    visibility = rows[0]?.default_post_visibility ?? 'public';
  }
  if (input.communityId && visibility !== 'community')
    throw invalid('Community posts must use community visibility');
  if (visibility === 'community' && !input.communityId)
    throw invalid('communityId is required for community visibility');
  if (visibility === 'circle' && !input.circleId)
    throw invalid('circleId is required for circle visibility');
  if (visibility !== 'circle' && input.circleId)
    throw invalid('circleId is only valid with circle visibility');
  if (visibility === 'selected' && !input.audience?.length)
    throw invalid('Choose who can see this post');
  if (author.ageBand === 'teen' && visibility === 'public')
    throw new AppError('unprocessable', 'Accounts under 18 cannot post publicly');
  if (input.minTier !== undefined && visibility !== 'subscribers')
    throw invalid('minTier is only valid with subscribers visibility');
  if (visibility === 'subscribers') {
    // Subscriber-only posts exist for creators who accepted the creator terms and are in good standing (not suspended/closed).
    const c = await ctx.db.query(
      'SELECT 1 FROM creators WHERE user_id = $1 AND status = $2 AND terms_accepted_at IS NOT NULL',
      [author.userId, 'active'],
    );
    if (!c.rowCount || author.ageBand === 'teen')
      throw forbidden('Only active creators can post for subscribers');
  }

  if (
    input.communityId &&
    !(await hasCommunityPermission(ctx.db, input.communityId, author.userId, 'post'))
  ) {
    throw forbidden('You cannot post in this community');
  }
  if (input.circleId) {
    const c = await ctx.db.query('SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2', [
      input.circleId,
      author.userId,
    ]);
    if (!c.rowCount) throw notFound('Circle');
  }
  const audience = [...new Set(input.audience ?? [])].filter((id) => id !== author.userId);
  for (const uid of audience)
    if (await isBlockedEitherWay(ctx.db, author.userId, uid))
      throw invalid('Your audience includes someone you cannot share with');

  let topicIds: string[] = [];
  if (input.topics?.length) {
    const slugs = [...new Set(input.topics.map((s) => s.toLowerCase()))];
    const { rows } = await ctx.db.query<{ id: string }>(
      'SELECT id FROM topics WHERE slug = ANY($1::citext[])',
      [slugs],
    );
    if (rows.length !== slugs.length) throw invalid('One or more topics do not exist');
    topicIds = rows.map((r) => r.id);
  }
  if (input.placeId) {
    const p = await ctx.db.query('SELECT 1 FROM places WHERE id = $1 AND deleted_at IS NULL', [
      input.placeId,
    ]);
    if (!p.rowCount) throw notFound('Place');
  }
  if (input.eventId) {
    const e = await ctx.db.query('SELECT 1 FROM events WHERE id = $1 AND deleted_at IS NULL', [
      input.eventId,
    ]);
    if (!e.rowCount) throw notFound('Event');
  }
  if (input.businessId) {
    const b = await ctx.db.query('SELECT 1 FROM businesses WHERE id = $1 AND deleted_at IS NULL', [
      input.businessId,
    ]);
    if (!b.rowCount) throw notFound('Business');
  }
  if (input.productId) {
    const pr = await ctx.db.query('SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL', [
      input.productId,
    ]);
    if (!pr.rowCount) throw notFound('Product');
  }
  if ((input.latitude === undefined) !== (input.longitude === undefined))
    throw invalid('Provide both latitude and longitude');

  let mediaKinds: string[] = [];
  const mediaIds = [...new Set(input.mediaIds ?? [])];
  if (mediaIds.length) {
    const { rows } = await ctx.db.query<{ id: string; kind: string }>(
      `SELECT m.id, m.kind FROM media m WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND m.deleted_at IS NULL
          AND m.status IN ('uploaded','processing','ready')
          AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)`,
      [mediaIds, author.userId],
    );
    if (rows.length !== mediaIds.length) throw invalid('One or more media files are unavailable');
    mediaKinds = mediaIds.map((id) => rows.find((r) => r.id === id)!.kind);
  }

  let kind = 'text';
  if (input.poll) kind = 'poll';
  else if (mediaKinds.length > 1) kind = 'carousel';
  else if (mediaKinds[0] === 'image') kind = 'photo';
  else if (mediaKinds[0] === 'video') kind = 'video';
  else if (mediaKinds[0] === 'audio') kind = 'audio';
  else if (input.linkUrl) kind = 'link';
  if (input.productId && kind === 'text') kind = 'product';

  const aiProvenance = input.aiAssistance
    ? { generated: false, assisted: input.aiAssistance.tools, disclosed: true }
    : { generated: false, assisted: [] };

  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.minTier !== undefined
      ? { minTier: Math.min(10, Math.max(1, Math.trunc(input.minTier))) }
      : {}),
  };

  return withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO posts (author_id, kind, body, language, visibility, circle_id, community_id, place_id, link_url, latitude, longitude, rights, ai_provenance, event_id, business_id, product_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [
        author.userId,
        kind,
        input.body.trim(),
        input.language ?? null,
        visibility,
        input.circleId ?? null,
        input.communityId ?? null,
        input.placeId ?? null,
        input.linkUrl ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        JSON.stringify({ license: input.license ?? 'all_rights_reserved' }),
        JSON.stringify(aiProvenance),
        input.eventId ?? null,
        input.businessId ?? null,
        input.productId ?? null,
        JSON.stringify(metadata),
      ],
    );
    const postId = rows[0]!.id;
    if (audience.length)
      await tx.query('INSERT INTO post_audience (post_id, user_id) SELECT $1, unnest($2::uuid[])', [
        postId,
        audience,
      ]);
    if (topicIds.length)
      await tx.query('INSERT INTO post_topics (post_id, topic_id) SELECT $1, unnest($2::uuid[])', [
        postId,
        topicIds,
      ]);
    for (const [i, mediaId] of mediaIds.entries())
      await tx.query('INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,$3)', [
        postId,
        mediaId,
        i,
      ]);
    if (input.poll) {
      await tx.query(
        `INSERT INTO polls (post_id, question, multiple, closes_at) VALUES ($1,$2,$3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + ($4::int || ' hours')::interval END)`,
        [postId, input.poll.question, input.poll.multiple, input.poll.closesInHours ?? null],
      );
      for (const [i, label] of input.poll.options.entries())
        await tx.query('INSERT INTO poll_options (post_id, label, position) VALUES ($1,$2,$3)', [
          postId,
          label,
          i,
        ]);
    }
    await screenText(ctx, tx, {
      type: 'post',
      id: postId,
      authorId: author.userId,
      text: `${input.body} ${input.poll?.question ?? ''} ${input.poll?.options.join(' ') ?? ''}`,
    });
    return postId;
  });
}

export async function deletePostAsAuthor(
  ctx: AppContext,
  postId: string,
  userId: string,
): Promise<void> {
  const r = await ctx.db.query(
    'UPDATE posts SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL',
    [postId, userId],
  );
  if (!r.rowCount) throw notFound('Post');
}

export { conflict };
