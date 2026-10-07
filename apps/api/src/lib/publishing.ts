import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import {
  AUDIO_POST_MAX_MS,
  AUDIO_POST_MIN_MS,
  PLUS_AUDIO_POST_MAX_MS,
  SCHEDULE_MAX_DAYS,
  SCHEDULE_MIN_MINUTES,
  transcriptLanguage,
  type CreatePostInput,
  type ModerationNotice,
} from '@yapilapi/shared';
import { moderationOf } from './notices.ts';
import type { AppContext } from './context.ts';
import { AppError, badRequest, forbidden, notFound } from './errors.ts';
import { scheduledPostFailureCode, scheduledPostFailureEnglish } from './failures.ts';
import { enqueue, enqueueAt, type JobHandler } from './jobs.ts';
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
import { langOf } from './translation.ts';
import type { PreparedMusic } from './music/index.ts';
import { claimEcho, linkEcho } from './echoes.ts';

type Q = Pool | PoolClient;
type Deps = Pick<AppContext, 'db' | 'config' | 'realtime' | 'music'> & Partial<Pick<AppContext, 'transcription'>>;

/** Check the music a new post, reel or draft asks for (outside a transaction: it may ask the song's provider). */
export async function prepareMusic(deps: Pick<AppContext, 'music'>, userId: string, input: CreatePostInput): Promise<PreparedMusic | null> {
  return input.music ? deps.music.prepareUse(userId, input.music, input.format === 'reel' ? 'reels' : 'posts') : null;
}

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
 * The kind of each uploaded item as stored (what the file turned out to be), not as the app said.
 * An address from elsewhere has no stored kind and keeps the one given.
 */
async function withStoredKinds(c: PoolClient, userId: string, input: CreatePostInput): Promise<CreatePostInput> {
  const ids = input.media.flatMap((m) => (m.id ? [m.id] : []));
  if (!ids.length) return input;
  const { rows } = await c.query<{ id: string; kind: 'image' | 'video' | 'audio' }>(`SELECT id, kind FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2`, [
    ids,
    userId,
  ]);
  const kinds = new Map(rows.map((r) => [r.id, r.kind]));
  return { ...input, media: input.media.map((m) => (m.id && kinds.has(m.id) ? { ...m, kind: kinds.get(m.id)! } : m)) };
}

/**
 * Write a post's content: a new post (published, draft or scheduled), or, with
 * `id`, replace what one of your drafts or scheduled posts says and shows. Checks
 * everything the author must own or be allowed to use. Call inside a transaction.
 */
export async function writePost(
  c: PoolClient,
  userId: string,
  given: CreatePostInput,
  opts: { id?: string; state: PostState; scheduledAt?: Date | null; moderationStatus?: string; music?: PreparedMusic | null },
): Promise<{ id: string; kind: string; taggedIds: string[]; remixAuthor: string | null; echo: EchoPosted | null }> {
  const input = await withStoredKinds(c, userId, given);
  const kind = postKind(input);
  // A recording is a post of its own: not a reel, and without photos, videos or a poll.
  if (input.media.some((m) => m.kind === 'audio')) {
    if (input.format === 'reel') throw badRequest('A reel is a video. Share a recording as a post.');
    if (input.media.length > 1 || input.poll) throw badRequest('A recording goes in a post on its own, without photos, videos or a poll.');
  }
  // Music was checked by prepareMusic; photo, carousel and text posts, or a reel with a catalogue song.
  if (input.music && !opts.music) throw new Error('writePost: check the music with prepareMusic first');
  const music = input.music ? opts.music! : null;
  if (music && input.format !== 'reel' && !['photo', 'carousel', 'text'].includes(kind)) throw badRequest('Music can be added to photo and text posts.');
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
    { echoId: input.echo },
  );
  if (recap) {
    if (input.format !== 'reel' || input.media.length !== 1) throw badRequest('A recap can be posted as a reel.');
    if (input.remixOf) throw badRequest("A recap can't be a duet or remix.");
    if (recap.soundId && input.soundId && input.soundId !== recap.soundId) throw badRequest('A recap is posted with the sound it was made with.');
  }
  // An echo: the video made for it, of a reel you may still echo. It keeps the sound it was made with.
  if (input.echo && (opts.id || opts.state !== 'published')) throw badRequest('An echo is posted right away.');
  const echo = input.echo ? await claimEcho(c, userId, input.echo, input.media[0]?.id) : null;
  if (echo && recap) throw badRequest("A recap can't be an echo.");
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
  } else if (input.format !== 'reel' && music?.soundId) {
    // A photo or text post playing part of a sound: counted on the sound's page like reels and stories.
    soundId = music.soundId;
  }
  if (recap && music) throw badRequest('A recap is posted with the sound it was made with.');
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
    // The text's language, for "See translation".
    langOf(input.body),
    music?.trackId ?? null,
    music ? { ...music.stored, style: 'compact' } : null,
    // Reels: who may echo it (NULL: the default for the account).
    input.format === 'reel' ? (input.allowEchoes ?? null) : null,
  ];
  let id: string;
  if (opts.id) {
    // A draft or scheduled post saved again: new content, same state and time. Its attachments are written afresh below.
    const r = await c.query(
      `UPDATE posts SET kind = $3, body = $4, visibility = $5, circle_id = $6, community_id = $7, event_id = $8, product_id = $9, link_url = $10, topics = $11,
                        ai_provenance = $12, format = $13, allow_remix = $14, remix_of_post_id = $15, remix_mode = $16, sound_id = $17, comment_policy = $18, lang = $19,
                        music_track_id = $20, music = $21, allow_echoes = $22, updated_at = now()
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
                          allow_remix, remix_of_post_id, remix_mode, sound_id, comment_policy, lang, music_track_id, music, allow_echoes, moderation_status, rights, status,
                          scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
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
  // "Hide like and view counts" for this post; left out, the account's choice applies (and a draft keeps its own).
  if (input.hideCounts !== undefined) await c.query(`UPDATE posts SET hide_counts = $2 WHERE id = $1`, [id, input.hideCounts]);
  if (echo && input.echo) await linkEcho(c, id, input.echo, echo.originalId, echo.song);
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
    if (m.kind === 'audio') {
      // Uploads have their length once stored; one from elsewhere has none and isn't checked here.
      const len = (await c.query(`SELECT duration_ms FROM media WHERE id = $1`, [mediaId])).rows[0]?.duration_ms as number | null | undefined;
      if (len && len < AUDIO_POST_MIN_MS) throw badRequest('This recording is too short.');
      if (len && len > AUDIO_POST_MAX_MS) {
        if (!(await isPlus(c, userId))) throw badRequest('Recordings can be up to 5 minutes, or 10 minutes with YAPILAPI Plus.');
        if (len > PLUS_AUDIO_POST_MAX_MS) throw badRequest('Recordings can be up to 10 minutes.');
      }
    }
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
  // Reels: the creator's highlights, each within the video (when its length is known yet).
  if (input.format === 'reel') {
    const highlights = input.highlights ?? [];
    if (highlights.length) {
      const len = (
        await c.query(`SELECT m.duration_ms FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = $1 ORDER BY pm.position LIMIT 1`, [id])
      ).rows[0]?.duration_ms as number | null | undefined;
      if (len && highlights.some((h) => h.atMs >= len)) throw badRequest('Each highlight has to be within the video.');
    }
    await c.query(`UPDATE posts SET highlights = $2 WHERE id = $1`, [id, highlights.length ? JSON.stringify(highlights) : null]);
  }
  // A reel playing a catalogue song has no sound of its own to offer others (its audio isn't heard).
  if (input.format === 'reel' && !soundId && !music && !echo) {
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
  return { id, kind, taggedIds, remixAuthor, echo: echo ? { originalId: echo.originalId, originalAuthorId: echo.originalAuthorId } : null };
}

/** An echo that was just posted: the reel it answers and who made that reel. */
export interface EchoPosted {
  originalId: string;
  originalAuthorId: string;
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
export function moderationNotice(s: Screening, limitedNow: boolean): ModerationNotice | undefined {
  if (s.status === 'normal') return undefined;
  return moderationOf(s.status, s.spam.restricted || limitedNow ? 'post_limited' : 'post_held');
}

/**
 * A post just went out: analytics, webhooks, and (when it isn't held for
 * review) mentions, photo tags, co-author invites and the duet, remix or echo notice.
 */
/**
 * An audio post gets a transcript, in its author's language, when speech-to-text is set up: the
 * apps show it under the player, for people who can't or would rather not listen. Captions the
 * author already has in that language are kept.
 */
async function transcribeRecording(deps: Deps, postId: string): Promise<void> {
  if (!deps.transcription) return;
  const { rows } = await deps.db.query<{ media_id: string; author_id: string; locale: string }>(
    `SELECT pm.media_id, p.author_id, pr.locale
     FROM post_media pm JOIN media m ON m.id = pm.media_id JOIN posts p ON p.id = pm.post_id JOIN profiles pr ON pr.user_id = p.author_id
     WHERE pm.post_id = $1 AND m.kind = 'audio' AND m.owner_id = p.author_id`,
    [postId],
  );
  for (const r of rows) {
    const { lang, label } = transcriptLanguage(r.locale);
    const made = await deps.db.query<{ id: string }>(
      `INSERT INTO caption_tracks (media_id, lang, label, source, status, created_by) VALUES ($1,$2,$3,'auto','processing',$4)
       ON CONFLICT (media_id, lang) DO NOTHING RETURNING id`,
      [r.media_id, lang, label, r.author_id],
    );
    if (made.rows[0]) await enqueue(deps.db, 'captions.transcribe', { trackId: made.rows[0].id });
  }
}

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
    echo?: EchoPosted | null;
  },
): Promise<void> {
  const { db, realtime } = deps;
  track(db, p.authorId, 'post_created', { kind: p.kind, visibility: p.visibility, community: !!p.communityId });
  await emitWebhook(db, p.authorId, 'post.created', { postId: p.postId, kind: p.kind, visibility: p.visibility });
  if (p.kind === 'audio') await transcribeRecording(deps, p.postId);
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
  // Tell the original's creator about an echo, when they can see it. Echoes of one reel are
  // batched into one notification ("Ada and 3 others echoed your reel").
  if (p.echo) {
    const seen = await db.query(
      `SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
      [p.echo.originalAuthorId, p.postId],
    );
    if (seen.rowCount)
      await notify(db, realtime, {
        userId: p.echo.originalAuthorId,
        category: 'creators',
        type: 'reel_echo',
        actorId: p.authorId,
        entityType: 'post',
        entityId: p.postId,
        data: { originalId: p.echo.originalId },
        group: p.echo.originalId,
      });
    track(db, p.authorId, 'reel_echoed');
  }
}

/**
 * Publish one of your drafts or scheduled posts now. It goes through every
 * check a new post does, with what it says at this moment, and things that may
 * have changed since it was saved are checked again (community membership,
 * subscription plan, whether a reel can still be remixed, blocked media).
 */
export async function publishDraft(deps: Deps, postId: string, authorId: string): Promise<{ notice?: ModerationNotice }> {
  const { db } = deps;
  const d = (
    await db.query(
      `SELECT p.id, p.kind, p.body, p.visibility, p.community_id, p.format, p.moderation_status, p.remix_of_post_id, p.remix_mode,
              p.sound_id, p.music_track_id, p.music,
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
    if (!m.rows[0] || m.rows[0].role === 'guest') throw new AppError(403, 'forbidden', 'Join the community to post in it.', { failure: 'community' });
  }
  if (d.visibility === 'subscribers') {
    const plan = await db.query(`SELECT 1 FROM creator_plans WHERE creator_id = $1 AND active LIMIT 1`, [authorId]);
    if (!plan.rowCount) throw badRequest('Add a subscription plan in Studio before posting for subscribers.', { failure: 'no_plan' });
  }
  const remixAuthor = d.format === 'reel' && d.remix_of_post_id ? (await assertRemixable(db, d.remix_of_post_id, authorId)).authorId : null;
  // Music: the song's licence (and the author's account type and country) or the sound are checked again as it goes out.
  if (d.music && d.music_track_id) await deps.music.checkTrack(authorId, d.music_track_id, d.music.durationMs);
  else if (d.music && d.sound_id && d.format !== 'reel') await assertSoundUsable(db, d.sound_id, authorId, 'posts');
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
        // Why, as a code the apps say in the author's language (and its English for older apps).
        const code = scheduledPostFailureCode(e);
        if (back.rowCount)
          await notify(deps.db, deps.realtime, {
            userId: due.author_id,
            category: 'creators',
            type: 'scheduled_post_failed',
            entityType: 'draft',
            entityId: postId,
            data: { code, reason: scheduledPostFailureEnglish(code) },
          });
      }
    },
  };
}
