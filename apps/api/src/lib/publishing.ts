import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_MINUTES, type CreatePostInput } from '@yapilapi/shared';
import type { AppContext } from './context.ts';
import { AppError, badRequest, forbidden, notFound } from './errors.ts';
import { enqueueAt, type JobHandler } from './jobs.ts';
import { analyzeText, statusForRisk, type Analysis } from './moderation.ts';
import { notifyMentions } from './mentions.ts';
import { assertCanInvite, assertCanTag, notifyCollabInvites, notifyPhotoTags } from './collabs.ts';
import { isPlus, PLUS_REEL_MAX_MS, REEL_MAX_MS } from './plus.ts';
import { notify, track } from './services.ts';
import { emitWebhook } from './webhooks.ts';
import { eventVisibleSql, postVisibleSql } from './visibility.ts';
import { isStoredMediaUrl } from './storage.ts';
import { assertRemixable, assertSoundUsable, registerOwnSound } from './sounds.ts';
import { assertRecapUse } from './recap-sharing.ts';
import { assertPostPace, assessPost, flagContent, recordSignals, type Assessment } from './spam.ts';
import { requireVerified } from './verification.ts';
import { MEDIA_BLOCKED_MESSAGE } from './media-moderation.ts';
import { topicsFor } from '../modules/tags.ts';

type Q = Pool | PoolClient;
type Deps = Pick<AppContext, 'db' | 'config' | 'realtime'>;

/**
 * Writing and publishing posts: now, as a draft, or at a scheduled time.
 *
 * Drafts and scheduled posts are rows in `posts` with status 'draft' or
 * 'scheduled'. postVisibleSql lets only published posts through, so they never
 * reach anyone but their author's own drafts list. Nothing about a draft is
 * announced (mentions, photo tags, co-author invites, webhooks, analytics) and
 * none of the publishing checks run until it's published: then it goes through
 * exactly what a new post goes through, and its time becomes the moment it went out.
 */

export const PUBLISH_JOB = 'post.publish';
/** At most this many drafts and scheduled posts per person. */
export const MAX_UNPUBLISHED = 200;

export type PostState = 'draft' | 'scheduled' | 'published';

/** The kind a post is, from what it has. */
export function postKind(input: CreatePostInput): CreatePostInput['kind'] {
  return input.poll
    ? 'poll'
    : input.media.length > 1
      ? 'carousel'
      : input.media[0]?.kind === 'video'
        ? 'video'
        : input.media[0]?.kind === 'audio'
          ? 'audio'
          : input.media[0]
            ? 'photo'
            : input.linkUrl
              ? 'link'
              : input.kind;
}

/**
 * Write a post's content: a new post (published, draft or scheduled), or, with
 * `id`, replace what one of your drafts or scheduled posts says and shows. Checks
 * everything the author must own or be allowed to use. Call inside a transaction.
 */
export async function writePost(
  c: PoolClient,
  userId: string,
  input: CreatePostInput,
  opts: { id?: string; state: PostState; scheduledAt?: Date | null; moderationStatus?: string },
): Promise<{ id: string; kind: string; taggedIds: string[]; remixAuthor: string | null }> {
  const kind = postKind(input);
  if (input.visibility === 'subscribers') {
    if (input.communityId) throw badRequest('Posts in a community are for its members, not for subscribers.');
    const plan = await c.query(`SELECT 1 FROM creator_plans WHERE creator_id = $1 AND active LIMIT 1`, [userId]);
    if (!plan.rowCount) throw badRequest('Add a subscription plan in Studio before posting for subscribers.');
  }
  // A recap video goes out only as a reel, only when everything in it is the author's own, and with the sound it was made with.
  const recap = await assertRecapUse(
    c,
    userId,
    input.media.map((m) => m.id),
    'post',
  );
  if (recap) {
    if (input.format !== 'reel' || input.media.length !== 1) throw badRequest('A recap can be posted as a reel.');
    if (input.remixOf) throw badRequest("A recap can't be a duet or remix.");
    if (recap.soundId && input.soundId && input.soundId !== recap.soundId) throw badRequest('A recap is posted with the sound it was made with.');
  }
  const chosenSound = input.soundId ?? recap?.soundId ?? undefined;
  // Reels: a duet or remix borrows the original's sound; otherwise a chosen sound, or the reel's own audio.
  let soundId: string | null = null;
  let remixAuthor: string | null = null;
  if (input.format === 'reel' && input.remixOf) {
    const o = await assertRemixable(c, input.remixOf, userId);
    remixAuthor = o.authorId;
    soundId = o.soundId;
  } else if (input.format === 'reel' && chosenSound) {
    await assertSoundUsable(c, chosenSound, userId);
    soundId = chosenSound;
  }
  if (input.communityId) {
    const m = await c.query(`SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [input.communityId, userId]);
    if (!m.rows[0] || m.rows[0].role === 'guest') throw forbidden('Join the community to post in it.');
  }
  if (input.circleId) {
    const owns = await c.query(`SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2`, [input.circleId, userId]);
    if (!owns.rowCount) throw notFound('Circle');
  }
  if (input.productId) {
    const own = await c.query(`SELECT 1 FROM products WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL`, [input.productId, userId]);
    if (!own.rowCount) throw forbidden('You can only link products you sell.');
  }
  // A post shows its event's title and time to everyone who sees it: only an event the author can see.
  if (input.eventId) {
    const seen = await c.query(`SELECT 1 FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1')}`, [userId, input.eventId]);
    if (!seen.rowCount) throw notFound('That event');
  }
  // What the post says and where it goes; the same for a new post and a draft saved again.
  const content = [
    kind,
    input.body,
    input.communityId ? 'public' : input.visibility,
    input.circleId ?? null,
    input.communityId ?? null,
    input.eventId ?? null,
    input.productId ?? null,
    input.linkUrl ?? null,
    topicsFor(input.topics, input.body),
    input.aiAssisted ? { assisted: true, at: new Date().toISOString() } : {},
    input.format,
    input.allowRemix,
    input.format === 'reel' ? (input.remixOf ?? null) : null,
    input.format === 'reel' && input.remixOf ? input.remixMode : null,
    soundId,
    input.commentPolicy ?? 'everyone',
  ];
  let id: string;
  if (opts.id) {
    // A draft or scheduled post saved again: new content, same state and time. Its attachments are written afresh below.
    const r = await c.query(
      `UPDATE posts SET kind = $3, body = $4, visibility = $5, circle_id = $6, community_id = $7, event_id = $8, product_id = $9, link_url = $10, topics = $11,
                        ai_provenance = $12, format = $13, allow_remix = $14, remix_of_post_id = $15, remix_mode = $16, sound_id = $17, comment_policy = $18, updated_at = now()
       WHERE id = $1 AND author_id = $2 AND status <> 'published' AND deleted_at IS NULL`,
      [opts.id, userId, ...content],
    );
    if (!r.rowCount) throw notFound('That draft');
    id = opts.id;
    for (const table of ['post_media', 'poll_options', 'post_audience', 'photo_tags', 'post_collaborators'])
      await c.query(`DELETE FROM ${table} WHERE post_id = $1`, [id]);
    // Its own sound is registered again from the video it has now.
    await c.query(`DELETE FROM sounds WHERE source_post_id = $1`, [id]);
  } else {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO posts (author_id, kind, body, visibility, circle_id, community_id, event_id, product_id, link_url, topics, ai_provenance, format,
                          allow_remix, remix_of_post_id, remix_mode, sound_id, comment_policy, moderation_status, rights, status, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [
        userId,
        ...content,
        opts.moderationStatus ?? 'normal',
        { owner: userId, license: 'all_rights_reserved' },
        opts.state,
        opts.state === 'scheduled' ? (opts.scheduledAt ?? null) : null,
      ],
    );
    id = rows[0]!.id;
  }
  const mediaIds: string[] = [];
  for (const [i, m] of input.media.entries()) {
    let mediaId = m.id;
    if (mediaId) {
      // Reuse the uploaded item (only your own), updating its alt text.
      const own = await c.query(`UPDATE media SET alt_text = coalesce($3, alt_text) WHERE id = $1 AND owner_id = $2 AND NOT private RETURNING id, moderation`, [
        mediaId,
        userId,
        m.altText ?? null,
      ]);
      if (!own.rowCount) throw notFound('One of the photos or videos');
      if (own.rows[0].moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
    } else {
      // An address alone is for files elsewhere: one stored here goes by its id, so the checks above apply to it.
      if (isStoredMediaUrl(m.url)) throw new AppError(400, 'validation_failed', 'Attach photos and videos uploaded here by their id.');
      const media = await c.query<{ id: string }>(`INSERT INTO media (owner_id, kind, url, alt_text, width, height) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
        userId,
        m.kind,
        m.url,
        m.altText ?? null,
        m.width ?? null,
        m.height ?? null,
      ]);
      mediaId = media.rows[0]!.id;
    }
    await c.query(`INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,$3)`, [id, mediaId, i]);
    mediaIds.push(mediaId);
    if (input.format === 'reel') {
      // Reels are short. Uploads still processing have no length yet; those are checked by the player, not refused here.
      const len = (await c.query(`SELECT duration_ms FROM media WHERE id = $1`, [mediaId])).rows[0]?.duration_ms;
      if (len && len > REEL_MAX_MS) {
        // Plus members can post reels up to 10 minutes.
        const plus = await isPlus(c, userId);
        if (!plus) throw new AppError(400, 'validation_failed', 'Reels can be up to 3 minutes, or 10 minutes with YAPILAPI Plus. Trim it in Studio first.');
        if (len > PLUS_REEL_MAX_MS) throw new AppError(400, 'validation_failed', 'Reels can be up to 10 minutes. Trim it in Studio first.');
      }
    }
  }
  if (input.format === 'reel' && !soundId) {
    const mediaId = (await c.query(`SELECT media_id FROM post_media WHERE post_id = $1 ORDER BY position LIMIT 1`, [id])).rows[0]?.media_id;
    if (mediaId) await registerOwnSound(c, { postId: id, ownerId: userId, mediaId, title: input.soundTitle });
  }
  if (input.poll)
    for (const [i, label] of input.poll.options.entries())
      await c.query(`INSERT INTO poll_options (post_id, label, position) VALUES ($1,$2,$3)`, [id, label, i]);
  if (input.visibility === 'selected' && input.audience)
    await c.query(`INSERT INTO post_audience (post_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, input.audience]);
  // People tagged in the photos: each must allow tags from you (their setting, blocks, minor protection).
  let taggedIds: string[] = [];
  const tags = input.media.flatMap((m, i) => (m.tags ?? []).map((t) => ({ ...t, mediaId: mediaIds[i]! })));
  if (tags.length) {
    await assertCanTag(
      c,
      userId,
      tags.map((t) => t.userId),
    );
    for (const t of tags)
      await c.query(
        `INSERT INTO photo_tags (post_id, media_id, user_id, tagged_by, x, y) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (post_id, media_id, user_id) DO NOTHING`,
        [id, t.mediaId, t.userId, userId, t.x, t.y],
      );
    taggedIds = [...new Set(tags.map((t) => t.userId))];
  }
  // Co-authors: invited now, each accepts or declines (a draft's invites go out when it's published).
  if (input.collaborators.length) {
    await assertCanInvite(c, userId, input.collaborators, { visibility: input.communityId ? 'public' : input.visibility, communityId: input.communityId });
    await c.query(`INSERT INTO post_collaborators (post_id, user_id, invited_by) SELECT $1, unnest($2::uuid[]), $3`, [id, input.collaborators, userId]);
  }
  return { id, kind, taggedIds, remixAuthor };
}

export interface Screening {
  analysis: Analysis;
  spam: Assessment;
  heldForAccount: boolean;
  status: 'normal' | 'review' | 'restricted';
}

/**
 * The checks a post goes through as it's published: harmful content is refused,
 * reaching everyone needs a confirmed email or phone (when REQUIRE_VERIFICATION
 * is on), new accounts post at a limited pace, and spam signals or a risky
 * account hold it for review.
 */
export async function screenPost(
  db: Q,
  config: Deps['config'],
  userId: string,
  p: { body: string; pollText: string; visibility: string; communityId: string | null | undefined },
): Promise<Screening> {
  const analysis = analyzeText(`${p.body} ${p.pollText}`);
  if (analysis.risk === 'escalate')
    throw new AppError(
      422,
      'content_blocked',
      "This post can't be published because it may put someone at risk. If you or someone else is in danger, contact local emergency services.",
    );
  const reachesEveryone = p.visibility === 'public' || !!p.communityId;
  if (reachesEveryone) await requireVerified(db, config, userId, 'post');
  await assertPostPace(db, config, userId);
  const spam = await assessPost(db, config, userId, p.body);
  const heldForAccount = spam.risky && reachesEveryone;
  const status = spam.restricted
    ? 'restricted'
    : analysis.risk !== 'normal'
      ? statusForRisk(analysis.risk)
      : spam.flags.length || heldForAccount
        ? 'review'
        : 'normal';
  return { analysis, spam, heldForAccount, status };
}

/** Flagged posts go to a moderator with the signals that flagged them. Returns whether the account was limited just now. Call inside the publishing transaction. */
export async function recordFlags(c: PoolClient, realtime: Deps['realtime'], userId: string, postId: string, s: Screening): Promise<boolean> {
  if (s.analysis.risk !== 'normal' || s.spam.flags.length || s.heldForAccount)
    await c.query(
      `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('post', $1, $2, 'automated', $3, $4)`,
      [
        postId,
        userId,
        s.analysis.risk !== 'normal' ? s.analysis.risk : 'review',
        {
          signals: [...s.analysis.signals, ...s.spam.flags.map((f) => f.kind), ...(s.heldForAccount ? ['risky_account'] : [])],
          ...(s.spam.flags.length ? { spam: s.spam.flags } : {}),
        },
      ],
    );
  const limitedNow = await flagContent(c, realtime, userId, { type: 'post', id: postId }, s.spam.flags);
  // Posts from a limited account wait with the account's review; clearing it publishes them.
  if (s.spam.restricted) await recordSignals(c, userId, [{ kind: 'held_while_limited', weight: 0 }], { type: 'post', id: postId });
  return limitedNow;
}

/** What to tell the author when their post isn't out for everyone yet. */
export function moderationNotice(s: Screening, limitedNow: boolean): { status: string; message: string } | undefined {
  if (s.status === 'normal') return undefined;
  return s.spam.restricted || limitedNow
    ? { status: s.status, message: 'Your account is limited while our team reviews some recent activity, so new posts are visible only to you for now.' }
    : { status: s.status, message: 'Your post is published to you only until it has been reviewed.' };
}

/**
 * A post just went out: analytics, webhooks, and (when it isn't held for
 * review) mentions, photo tags, co-author invites and the duet or remix notice.
 */
export async function announcePost(
  deps: Deps,
  p: {
    postId: string;
    authorId: string;
    kind: string;
    visibility: string;
    communityId: string | null | undefined;
    body: string;
    status: string;
    taggedIds: string[];
    collaborators: string[];
    remixAuthor: string | null;
    remixOf: string | null | undefined;
    remixMode: string | null | undefined;
  },
): Promise<void> {
  const { db, realtime } = deps;
  track(db, p.authorId, 'post_created', { kind: p.kind, visibility: p.visibility, community: !!p.communityId });
  await emitWebhook(db, p.authorId, 'post.created', { postId: p.postId, kind: p.kind, visibility: p.visibility });
  if (p.status !== 'normal') return;
  // Mentions in the text (posts and reel captions alike), photo tags and co-author invites.
  await notifyMentions(db, realtime, { text: p.body, actorId: p.authorId, postId: p.postId, skip: [...p.taggedIds, ...p.collaborators] });
  await notifyPhotoTags(db, realtime, { postId: p.postId, actorId: p.authorId, userIds: p.taggedIds });
  await notifyCollabInvites(db, realtime, { postId: p.postId, actorId: p.authorId, userIds: p.collaborators });
  // Tell the original's creator about a duet or remix, when they can see it.
  if (p.remixAuthor) {
    const seen = await db.query(
      `SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
      [p.remixAuthor, p.postId],
    );
    if (seen.rowCount)
      await notify(db, realtime, {
        userId: p.remixAuthor,
        category: 'creators',
        type: p.remixMode === 'duet' ? 'reel_duet' : 'reel_remix',
        actorId: p.authorId,
        entityType: 'post',
        entityId: p.postId,
        data: { originalId: p.remixOf },
      });
    track(db, p.authorId, 'reel_remixed', { mode: p.remixMode });
  }
}

/**
 * Publish one of your drafts or scheduled posts now. It goes through every
 * check a new post does, with what it says at this moment, and things that may
 * have changed since it was saved are checked again (community membership,
 * subscription plan, whether a reel can still be remixed, blocked media).
 */
export async function publishDraft(deps: Deps, postId: string, authorId: string): Promise<{ notice?: { status: string; message: string } }> {
  const { db } = deps;
  const d = (
    await db.query(
      `SELECT p.id, p.kind, p.body, p.visibility, p.community_id, p.format, p.moderation_status, p.remix_of_post_id, p.remix_mode,
              (SELECT string_agg(o.label, ' ' ORDER BY o.position) FROM poll_options o WHERE o.post_id = p.id) AS poll_text,
              EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation = 'blocked') AS blocked_media
       FROM posts p WHERE p.id = $1 AND p.author_id = $2 AND p.status <> 'published' AND p.deleted_at IS NULL`,
      [postId, authorId],
    )
  ).rows[0];
  if (!d) throw notFound('That draft');
  if (d.blocked_media || d.moderation_status === 'removed') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
  if (d.community_id) {
    const m = await db.query(`SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [d.community_id, authorId]);
    if (!m.rows[0] || m.rows[0].role === 'guest') throw forbidden('Join the community to post in it.');
  }
  if (d.visibility === 'subscribers') {
    const plan = await db.query(`SELECT 1 FROM creator_plans WHERE creator_id = $1 AND active LIMIT 1`, [authorId]);
    if (!plan.rowCount) throw badRequest('Add a subscription plan in Studio before posting for subscribers.');
  }
  const remixAuthor = d.format === 'reel' && d.remix_of_post_id ? (await assertRemixable(db, d.remix_of_post_id, authorId)).authorId : null;
  // A recap in it: everything in the recap must still be the author's own.
  const mediaIds = (await db.query<{ media_id: string }>(`SELECT media_id FROM post_media WHERE post_id = $1`, [postId])).rows.map((r) => r.media_id);
  await assertRecapUse(db, authorId, mediaIds, 'post');
  // People tagged and invited to co-author when it was saved: checked again as for a new post, since tag settings,
  // follows, friendships and ages may have changed while it waited.
  const [tagged, invited] = await Promise.all([
    db.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM photo_tags WHERE post_id = $1`, [postId]),
    db.query<{ user_id: string }>(`SELECT user_id FROM post_collaborators WHERE post_id = $1 AND status = 'pending'`, [postId]),
  ]);
  const taggedIds = tagged.rows.map((r) => r.user_id);
  const invitedIds = invited.rows.map((r) => r.user_id);
  await assertCanTag(db, authorId, taggedIds);
  await assertCanInvite(db, authorId, invitedIds, { visibility: d.visibility, communityId: d.community_id });
  const s = await screenPost(db, deps.config, authorId, { body: d.body, pollText: d.poll_text ?? '', visibility: d.visibility, communityId: d.community_id });
  let limitedNow = false;
  const published = await tx(db, async (c) => {
    // Only once: publishing now and the scheduled job can't both put it out.
    const r = await c.query(
      `UPDATE posts SET status = 'published', scheduled_at = NULL, created_at = now(), updated_at = now(), moderation_status = $3
       WHERE id = $1 AND author_id = $2 AND status <> 'published' AND deleted_at IS NULL`,
      [postId, authorId, s.status],
    );
    if (!r.rowCount) return false;
    limitedNow = await recordFlags(c, deps.realtime, authorId, postId, s);
    return true;
  });
  if (!published) throw notFound('That draft');
  await announcePost(deps, {
    postId,
    authorId,
    kind: d.kind,
    visibility: d.visibility,
    communityId: d.community_id,
    body: d.body,
    status: s.status,
    taggedIds,
    collaborators: invitedIds,
    remixAuthor,
    remixOf: d.remix_of_post_id,
    remixMode: d.remix_mode,
  });
  return { notice: moderationNotice(s, limitedNow) };
}

/** A time to publish at: at least SCHEDULE_MIN_MINUTES and at most SCHEDULE_MAX_DAYS from now. */
export function scheduleTime(iso: string): Date {
  const at = new Date(iso);
  const ahead = at.getTime() - Date.now();
  const refuse = (message: string) => new AppError(400, 'validation_failed', message, { fields: { scheduledAt: message } });
  if (!(ahead >= SCHEDULE_MIN_MINUTES * 60_000)) throw refuse(`Choose a time at least ${SCHEDULE_MIN_MINUTES} minutes from now.`);
  if (ahead > SCHEDULE_MAX_DAYS * 86_400_000) throw refuse(`Choose a time in the next ${SCHEDULE_MAX_DAYS} days.`);
  return at;
}

/** Refuse a new draft when the author already has as many as they can keep. */
export async function assertDraftRoom(db: Q, userId: string): Promise<void> {
  const n = (await db.query(`SELECT count(*)::int AS n FROM posts WHERE author_id = $1 AND status <> 'published' AND deleted_at IS NULL`, [userId])).rows[0]
    .n as number;
  if (n >= MAX_UNPUBLISHED)
    throw new AppError(400, 'validation_failed', `You can keep up to ${MAX_UNPUBLISHED} drafts and scheduled posts. Publish or delete some first.`);
}

/**
 * Set a draft (or a scheduled post) to go out at `at`, and queue the job that
 * publishes it. Earlier jobs for the same post find it moved and do nothing.
 * Call inside a transaction.
 */
export async function schedulePost(c: PoolClient, postId: string, authorId: string, at: Date): Promise<void> {
  const r = await c.query(
    `UPDATE posts SET status = 'scheduled', scheduled_at = $3, updated_at = now() WHERE id = $1 AND author_id = $2 AND status <> 'published' AND deleted_at IS NULL`,
    [postId, authorId, at],
  );
  if (!r.rowCount) throw notFound('That draft');
  await enqueueAt(c, PUBLISH_JOB, { postId }, at);
}

/**
 * The job that publishes a scheduled post at its time. A post that was
 * published already, moved back to drafts, rescheduled later or deleted is left
 * alone. One that can't go out as it is (it breaks a rule, the author left the
 * community, a new account's pace limit) goes back to drafts and the author is
 * told why; other errors are retried by the jobs runner.
 */
export function scheduledPostJobHandlers(deps: Deps): Record<string, JobHandler> {
  return {
    [PUBLISH_JOB]: async ({ postId }: { postId: string }) => {
      const due = (
        await deps.db.query(`SELECT author_id FROM posts WHERE id = $1 AND status = 'scheduled' AND scheduled_at <= now() AND deleted_at IS NULL`, [postId])
      ).rows[0];
      if (!due) return;
      try {
        await publishDraft(deps, postId, due.author_id);
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        const back = await deps.db.query(
          `UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = now() WHERE id = $1 AND status = 'scheduled' AND deleted_at IS NULL`,
          [postId],
        );
        if (back.rowCount)
          await notify(deps.db, deps.realtime, {
            userId: due.author_id,
            category: 'creators',
            type: 'scheduled_post_failed',
            entityType: 'draft',
            entityId: postId,
            data: { reason: e.message },
          });
      }
    },
  };
}
