import type { Pool, PoolClient } from 'pg';
import { POST_MILESTONES, type MilestoneMetric } from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';

type Q = Pool | PoolClient;

/**
 * Milestones (docs/product/post-stats.md): when a post's views or likes pass 100, 1,000, 10,000 or
 * 100,000, its author is told once ("Your reel passed 1,000 views"). Checked where the counts go
 * up (a like, a view). Each milestone is written to post_milestones first, so it's told exactly
 * once even when two people push it over at the same moment, and never again after an unlike and
 * a new like. Passing several at once (a post that jumped) tells only the highest; the others are
 * still written. Drafts, scheduled and deleted posts don't count. Notifications follow the
 * author's settings (the Milestones category) and push like the others.
 */
export async function checkMilestones(db: Q, realtime: RealtimeHub, postIds: string[], metric: MilestoneMetric): Promise<number> {
  if (!postIds.length) return 0;
  const col = metric === 'views' ? 'view_count' : 'like_count';
  const { rows } = await db.query<{ post_id: string; threshold: number; author_id: string; format: string }>(
    `WITH due AS (
       SELECT p.id, p.author_id, p.format, m AS threshold
       FROM posts p, unnest($2::int[]) m
       WHERE p.id = ANY($1::uuid[]) AND p.${col} >= m AND p.status = 'published' AND p.deleted_at IS NULL
     ),
     reached AS (
       INSERT INTO post_milestones (post_id, metric, threshold)
       SELECT id, $3, threshold FROM due
       ON CONFLICT DO NOTHING
       RETURNING post_id, threshold
     )
     SELECT r.post_id, r.threshold, d.author_id, d.format FROM reached r JOIN due d ON d.id = r.post_id AND d.threshold = r.threshold`,
    [[...new Set(postIds)], [...POST_MILESTONES], metric],
  );
  const highest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if ((highest.get(r.post_id)?.threshold ?? 0) < r.threshold) highest.set(r.post_id, r);
  for (const r of highest.values())
    await notify(db, realtime, {
      userId: r.author_id,
      category: 'milestones',
      type: 'post_milestone',
      entityType: 'post',
      entityId: r.post_id,
      data: { metric, threshold: r.threshold, format: r.format === 'reel' ? 'reel' : 'post' },
    });
  return highest.size;
}
