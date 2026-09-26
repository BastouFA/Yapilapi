import type { Pool, PoolClient } from 'pg';
import type { CollabStatus, PhotoTag, Post, PublicUser } from '@yapilapi/shared';
import { AppError } from './errors.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Collab posts and photo tags.
 *
 * A collab post has one original author (posts.author_id) and up to three
 * co-authors who accepted an invite (post_collaborators, status 'accepted').
 * Its audience is always the original author's choice: every listing still
 * applies postVisibleSql, so showing it on a co-author's profile or in their
 * followers' feeds never reaches anyone who couldn't see it already.
 */

/** Posts aliased `p`: `u` co-authors it (accepted the invite). */
export function coAuthoredSql(u: string, p = 'p'): string {
  return `EXISTS (SELECT 1 FROM post_collaborators pc WHERE pc.post_id = ${p}.id AND pc.user_id = ${u} AND pc.status = 'accepted')`;
}

/** Posts aliased `p`: by `u`, as the original author or an accepted co-author. Used for profiles and stats. */
export function byOrWithSql(u: string, p = 'p'): string {
  return `(${p}.author_id = ${u} OR ${coAuthoredSql(u, p)})`;
}

/**
 * Minor protection, as for messages: an adult and someone under 18 can work
 * together on a post, or tag each other, only once they're friends. Unknown
 * ages count as adult here, like the messaging rule.
 */
export function minorRuleSql(a: string, b: string): string {
  const minor = (x: string) => `coalesce((SELECT ux.birth_date > current_date - interval '18 years' FROM users ux WHERE ux.id = ${x}), false)`;
  return `(${minor(a)} = ${minor(b)}
           OR EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${a} AND fr.user_b = ${b}) OR (fr.user_a = ${b} AND fr.user_b = ${a})))`;
}

/** `author` may invite `target` to co-author: they follow each other, neither blocked the other, and minor protection allows it. */
export function canInviteSql(author: string, target: string): string {
  return `(${target} <> ${author}
           AND EXISTS (SELECT 1 FROM follows f1 WHERE f1.follower_id = ${author} AND f1.followee_id = ${target})
           AND EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ${target} AND f2.followee_id = ${author})
           AND ${notBlockedSql(target, author)}
           AND ${minorRuleSql(author, target)})`;
}

/**
 * `tagger` may tag `target` in a photo: yourself always; anyone else when
 * their setting allows it (everyone, or only people they follow), neither
 * blocked the other and minor protection allows it.
 */
export function canTagSql(tagger: string, target: string): string {
  return `(${target} = ${tagger} OR (
           EXISTS (SELECT 1 FROM profiles tp JOIN users tu ON tu.id = tp.user_id
                   WHERE tp.user_id = ${target} AND tu.status = 'active'
                     AND (tp.tag_permission = 'everyone'
                          OR (tp.tag_permission = 'following' AND EXISTS (SELECT 1 FROM follows tf WHERE tf.follower_id = ${target} AND tf.followee_id = ${tagger}))))
           AND ${notBlockedSql(target, tagger)}
           AND ${minorRuleSql(tagger, target)}))`;
}

/** Refuse invites the author can't send, naming the first person it fails for. `postId` is set for invites on an existing post. */
export async function assertCanInvite(
  db: Q,
  authorId: string,
  userIds: string[],
  post: { id?: string; visibility: string; communityId?: string | null },
): Promise<void> {
  if (!userIds.length) return;
  if (post.communityId) throw new AppError(400, 'validation_failed', "Posts in a community can't have co-authors.");
  if (!['public', 'followers', 'friends'].includes(post.visibility))
    throw new AppError(400, 'validation_failed', 'Co-authors can be added to posts shared publicly, with followers or with friends.');
  if (userIds.includes(authorId)) throw new AppError(400, 'validation_failed', "You're already the author.");
  const { rows } = await db.query(
    `SELECT x.id, pr.display_name, ${canInviteSql('$1', 'x.id')} AS allowed,
            (${minorRuleSql('$1', 'x.id')}) AS minor_ok,
            EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = x.id) OR (fr.user_a = x.id AND fr.user_b = $1)) AS friends,
            (SELECT pc.status FROM post_collaborators pc WHERE pc.post_id = $3 AND pc.user_id = x.id) AS status
     FROM unnest($2::uuid[]) AS x(id) LEFT JOIN profiles pr ON pr.user_id = x.id LEFT JOIN users u ON u.id = x.id AND u.status = 'active'`,
    [authorId, userIds, post.id ?? null],
  );
  for (const r of rows) {
    const name = (r.display_name as string | null) ?? 'This person';
    if (r.status === 'pending' || r.status === 'accepted') throw new AppError(409, 'conflict', `${name} is already invited.`);
    if (r.status === 'declined' || r.status === 'left') throw new AppError(409, 'conflict', `${name} already answered an invite to this post.`);
    if (!r.display_name) throw new AppError(404, 'not_found', "That person couldn't be found.");
    if (!r.minor_ok) throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only invite them once you are friends.');
    if (!r.allowed) throw new AppError(403, 'collab_not_allowed', `You can invite people you follow who follow you back. ${name} can't be invited.`);
    if (post.visibility === 'friends' && !r.friends) throw new AppError(403, 'collab_not_allowed', `${name} can't see posts you share with friends only.`);
  }
  if (post.id) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM post_collaborators WHERE post_id = $1 AND status IN ('pending', 'accepted')`, [post.id])).rows[0]
      .n as number;
    if (n + userIds.length > 3) throw new AppError(400, 'validation_failed', 'A post can have up to 3 co-authors.');
  }
}

/** Refuse photo tags the tagger can't add, naming the first person it fails for. */
export async function assertCanTag(db: Q, taggerId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const { rows } = await db.query(
    `SELECT x.id, pr.display_name, ${canTagSql('$1', 'x.id')} AS allowed, (${minorRuleSql('$1', 'x.id')}) AS minor_ok
     FROM unnest($2::uuid[]) AS x(id) LEFT JOIN profiles pr ON pr.user_id = x.id`,
    [taggerId, ids],
  );
  for (const r of rows) {
    if (!r.display_name) throw new AppError(404, 'not_found', "That person couldn't be found.");
    if (!r.minor_ok) throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only tag them once you are friends.');
    if (!r.allowed) throw new AppError(403, 'tag_not_allowed', `${r.display_name} doesn't allow you to tag them.`);
  }
}

/**
 * Add co-authors and photo tags to hydrated posts, in place. Accepted co-authors
 * are shown to everyone; open invites only to the original author; the viewer's
 * own invite as `viewer.collab`. Tags on people the viewer blocked (or who
 * blocked them) are left out.
 */
export async function attachCollabsAndTags(db: Q, posts: Post[], viewer: string | null): Promise<void> {
  if (!posts.length) return;
  const ids = posts.map((p) => p.id);
  const unlocked = posts.filter((p) => !p.locked && p.media.some((m) => m.kind === 'image')).map((p) => p.id);
  const [collabs, tags] = await Promise.all([
    db.query(
      `SELECT pc.post_id, pc.status, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url,
              pr.mode AS a_mode, ${plusCol('a_')}
       FROM post_collaborators pc JOIN profiles pr ON pr.user_id = pc.user_id JOIN users u ON u.id = pc.user_id
       WHERE pc.post_id = ANY($1) AND pc.status IN ('pending', 'accepted') AND u.status = 'active'
       ORDER BY pc.created_at, pc.user_id`,
      [ids],
    ),
    unlocked.length
      ? db.query(
          `SELECT t.id, t.post_id, t.media_id, t.x, t.y, pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name,
                  pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}
           FROM photo_tags t JOIN profiles pr ON pr.user_id = t.user_id JOIN users u ON u.id = t.user_id
           WHERE t.post_id = ANY($1) AND u.status = 'active' AND ${notBlockedSql('t.user_id', '$2')}
           ORDER BY t.created_at, t.x, t.id`,
          [unlocked, viewer],
        )
      : null,
  ]);
  const byPost = new Map(posts.map((p) => [p.id, p]));
  const accepted = new Map<string, PublicUser[]>();
  const pending = new Map<string, PublicUser[]>();
  for (const r of collabs.rows) {
    const post = byPost.get(r.post_id);
    if (!post) continue;
    const user = publicUserFrom(r, 'a_');
    if (user.id === viewer) post.viewer.collab = r.status as CollabStatus;
    const into = r.status === 'accepted' ? accepted : post.author.id === viewer ? pending : null;
    if (into) into.set(r.post_id, [...(into.get(r.post_id) ?? []), user]);
  }
  for (const [id, users] of accepted) byPost.get(id)!.collaborators = users;
  for (const [id, users] of pending) byPost.get(id)!.pendingCollaborators = users;
  if (!tags) return;
  const byMedia = new Map<string, PhotoTag[]>();
  for (const r of tags.rows) {
    const key = `${r.post_id}:${r.media_id}`;
    byMedia.set(key, [...(byMedia.get(key) ?? []), { id: r.id, user: publicUserFrom(r, 'a_'), x: Number(r.x), y: Number(r.y) }]);
  }
  for (const post of posts)
    for (const m of post.media) {
      const t = byMedia.get(`${post.id}:${m.id}`);
      if (t) m.tags = t;
    }
}

/**
 * Tell people they were tagged in a photo of a post, only when they can see
 * that post and it isn't waiting for review. Blocks, mutes and notification
 * settings apply as usual (see notify).
 */
export async function notifyPhotoTags(db: Q, realtime: RealtimeHub, m: { postId: string; actorId: string; userIds: string[] }): Promise<number> {
  const ids = [...new Set(m.userIds)].filter((id) => id !== m.actorId);
  if (!ids.length) return 0;
  const { rows } = await db.query(
    `SELECT x.id FROM unnest($2::uuid[]) AS x(id)
     WHERE EXISTS (SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
                   WHERE p.id = $1 AND p.moderation_status = 'normal' AND ${postVisibleSql('x.id')} AND ${postUnlockedSql('x.id')})`,
    [m.postId, ids],
  );
  for (const r of rows)
    await notify(db, realtime, { userId: r.id, category: 'friends', type: 'photo_tag', actorId: m.actorId, entityType: 'post', entityId: m.postId });
  return rows.length;
}

/** Invite notifications for co-authors, sent once the post is out of review. */
export async function notifyCollabInvites(db: Q, realtime: RealtimeHub, m: { postId: string; actorId: string; userIds: string[] }): Promise<void> {
  for (const userId of m.userIds)
    await notify(db, realtime, { userId, category: 'friends', type: 'collab_invite', actorId: m.actorId, entityType: 'post', entityId: m.postId });
}
