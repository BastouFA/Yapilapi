import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { tx } from '@yapilapi/database';
import {
  CHAPTER_AUDIENCES,
  CHAPTER_CONTRIBUTORS_MAX,
  CHAPTER_DESCRIPTION_MAX,
  CHAPTER_GRADIENT_NAMES,
  CHAPTER_GUESTBOOK_MAX,
  CHAPTER_STORIES_MAX,
  CHAPTER_SYMBOLS,
  CHAPTER_TITLE_MAX,
  type ChapterGradient,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { analyzeText } from '../lib/moderation.ts';
import type { RealtimeHub } from '../lib/realtime.ts';
import { notify, track } from '../lib/services.ts';
import { ageOf, plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/*
 * SQL building blocks. `v` is the viewer placeholder (NULL when signed out).
 * Chapters are aliased `ch`, the owner's user row `ou` and profile `op`;
 * stories `m` with their author's user row `au`.
 */
const minor = (birthCol: string) => `coalesce(${birthCol} > current_date - interval '18 years', false)`;
const follows = (v: string, other: string) => `EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = ${other})`;
const friends = (v: string, other: string) =>
  `EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${v} AND fr.user_b = ${other}) OR (fr.user_b = ${v} AND fr.user_a = ${other}))`;
const contributor = (user: string) => `EXISTS (SELECT 1 FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.user_id = ${user} AND cm.status = 'accepted')`;
const invited = (user: string) => `EXISTS (SELECT 1 FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.user_id = ${user} AND cm.status = 'invited')`;

/** Before its opening date a time capsule shows only its cover, the date and how many stories are inside. */
const SEALED = `(ch.opens_at IS NOT NULL AND ch.opens_at > now())`;
/** Stories can be added until a capsule is sealed or its date comes. */
const ADDING_OPEN = `(ch.opens_at IS NULL OR (ch.sealed_at IS NULL AND ch.opens_at > now()))`;

/**
 * Whether the viewer may see the chapter at all: its owner, contributors (and
 * people invited to contribute), and the chapter's audience, measured against
 * the owner, with blocks either way. A public chapter of someone under 18 is
 * read as followers only (the API also refuses to make one).
 */
export function chapterVisibleSql(v: string): string {
  return `(ch.deleted_at IS NULL AND ou.status = 'active' AND ${notBlockedSql('ch.owner_id', v)} AND (
    ch.owner_id = ${v}
    OR ${contributor(v)}
    OR ${invited(v)}
    OR (ch.audience = 'public' AND NOT ${minor('ou.birth_date')} AND (NOT op.is_private OR ${follows(v, 'ch.owner_id')}))
    OR (ch.audience IN ('public', 'followers') AND ${follows(v, 'ch.owner_id')})
    OR (ch.audience IN ('public', 'followers', 'friends') AND ${friends(v, 'ch.owner_id')})
    OR (ch.audience = 'close_friends'
        AND EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = ch.owner_id AND cf.friend_id = ${v})
        AND ${follows(v, 'ch.owner_id')})
  ))`;
}

/**
 * Which stories of a visible chapter the viewer gets: not deleted, by the owner or a current
 * contributor, nobody either side blocked (each contributor's own blocks count), media not
 * blocked, sensitive media never for people under 18 or unknown age. In a public chapter,
 * stories by someone under 18 go only to people who follow them and to the chapter's members.
 * This does not look at the capsule seal; callers add that.
 */
function storyVisibleSql(v: string): string {
  return `(m.deleted_at IS NULL AND au.status = 'active'
    AND (m.author_id = ch.owner_id OR ${contributor('m.author_id')})
    AND ${notBlockedSql('m.author_id', v)}
    AND NOT EXISTS (SELECT 1 FROM media x WHERE x.id = m.media_id AND (x.moderation = 'blocked'
      OR (x.moderation = 'sensitive' AND NOT coalesce((SELECT uv.birth_date <= current_date - interval '18 years' FROM users uv WHERE uv.id = ${v}), false))))
    AND (ch.audience <> 'public' OR NOT ${minor('au.birth_date')} OR m.author_id = ${v} OR ch.owner_id = ${v} OR ${contributor(v)} OR ${follows(v, 'm.author_id')}))`;
}

const OWNER_COLS = `op.user_id AS o_id, op.username AS o_username, op.display_name AS o_display_name, op.avatar_url AS o_avatar_url, op.mode AS o_mode, ${plusCol('o_', 'op')}`;
const AUTHOR_COLS = `pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}`;

/** Everything a chapter card needs, for viewer $1. */
const SUMMARY_SELECT = `
  SELECT ch.id, ch.owner_id, ch.title, ch.description, ch.audience, ch.cover_moment_id, ch.cover_gradient, ch.cover_symbol,
         ch.opens_at, ch.sealed_at, ch.created_at, ch.updated_at, ${SEALED} AS sealed_now, ${ADDING_OPEN} AS adding_open, ${OWNER_COLS},
         (SELECT cm.status FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.user_id = $1) AS my_status,
         (SELECT cm.show_on_profile FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.user_id = $1) AS my_show_on_profile,
         EXISTS (SELECT 1 FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.status = 'accepted') AS shared,
         (SELECT count(*) FROM chapter_items ci JOIN moments m ON m.id = ci.moment_id JOIN users au ON au.id = m.author_id
          WHERE ci.chapter_id = ch.id AND ${storyVisibleSql('$1')})::int AS story_count,
         cov.media_url AS cov_media_url, cov.media_kind AS cov_media_kind, cov.poster_url AS cov_poster_url, cov.body AS cov_body
  FROM chapters ch JOIN users ou ON ou.id = ch.owner_id JOIN profiles op ON op.user_id = ch.owner_id
  LEFT JOIN LATERAL (
    SELECT coalesce(md.variants->>'mp4', m.media_url) AS media_url, m.media_kind, md.poster_url, m.body
    FROM chapter_items ci JOIN moments m ON m.id = ci.moment_id JOIN users au ON au.id = m.author_id LEFT JOIN media md ON md.id = m.media_id
    WHERE ci.chapter_id = ch.id AND ci.moment_id = ch.cover_moment_id AND NOT ${SEALED} AND ${storyVisibleSql('$1')}
  ) cov ON true`;

type Row = Record<string, any>;

function toSummary(r: Row, viewer: string | null) {
  const role = r.owner_id === viewer ? 'owner' : r.my_status === 'accepted' ? 'contributor' : r.my_status === 'invited' ? 'invited' : null;
  const cover =
    r.cov_media_url || r.cov_body
      ? { kind: 'story' as const, mediaUrl: r.cov_media_url ?? null, mediaKind: r.cov_media_kind ?? null, posterUrl: r.cov_poster_url ?? null, text: r.cov_body || null }
      : { kind: 'gradient' as const, gradient: r.cover_gradient as ChapterGradient, symbol: r.cover_symbol };
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    audience: r.audience,
    owner: publicUserFrom(r, 'o_'),
    cover,
    // The chosen gradient and symbol, also used behind a story cover and on a sealed capsule.
    coverGradient: r.cover_gradient as ChapterGradient,
    coverSymbol: r.cover_symbol,
    coverStoryId: role === 'owner' ? (r.cover_moment_id ?? null) : undefined,
    capsule: r.opens_at ? { opensAt: r.opens_at as Date, sealed: !!r.sealed_at || !r.sealed_now, open: !r.sealed_now } : null,
    storyCount: Number(r.story_count ?? 0),
    shared: !!r.shared,
    role,
    canAdd: (role === 'owner' || role === 'contributor') && !!r.adding_open,
    ...(role === 'contributor' ? { showOnProfile: !!r.my_show_on_profile } : {}),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

function toStory(r: Row) {
  return {
    id: r.id as string,
    body: r.body as string,
    mediaUrl: (r.variants?.mp4 ?? r.media_url ?? null) as string | null,
    mediaKind: r.media_kind ?? null,
    posterUrl: r.poster_url ?? null,
    hlsUrl: r.hls_url ?? null,
    durationMs: r.duration_ms ?? null,
    ...(r.moderation === 'sensitive' ? { sensitive: true } : {}),
    locationText: r.location_text ?? null,
    createdAt: r.created_at as Date,
  };
}

const idParam = z.object({ id: z.string().uuid() });
const title = z.string().trim().min(1, 'Add a title.').max(CHAPTER_TITLE_MAX, `Up to ${CHAPTER_TITLE_MAX} characters.`);
const description = z.string().trim().max(CHAPTER_DESCRIPTION_MAX, `Up to ${CHAPTER_DESCRIPTION_MAX} characters.`);
const audience = z.enum(CHAPTER_AUDIENCES);
const gradient = z.enum(CHAPTER_GRADIENT_NAMES as [ChapterGradient, ...ChapterGradient[]]);
const symbol = z.enum(CHAPTER_SYMBOLS);
const opensAt = z.string().datetime({ offset: true });
const createSchema = z.object({
  title,
  description: description.default(''),
  audience: audience.default('followers'),
  coverGradient: gradient.default('yapi'),
  coverSymbol: symbol.default('star'),
  opensAt: opensAt.nullish(),
  momentIds: z.array(z.string().uuid()).max(CHAPTER_STORIES_MAX).default([]),
});
const patchSchema = z.object({
  title: title.optional(),
  description: description.optional(),
  audience: audience.optional(),
  coverGradient: gradient.optional(),
  coverSymbol: symbol.optional(),
  coverStoryId: z.string().uuid().nullable().optional(),
  opensAt: opensAt.nullable().optional(),
});
const monthSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.').optional() });

const CAPSULE_MIN_MS = 60 * 60 * 1000;
const CAPSULE_MAX_MS = 25 * 365 * 24 * 60 * 60 * 1000;

function checkOpensAt(iso: string) {
  const at = new Date(iso).getTime();
  const now = Date.now();
  if (at < now + CAPSULE_MIN_MS) throw badRequest('Choose an opening date at least an hour from now.', { fields: { opensAt: 'Choose a later date.' } });
  if (at > now + CAPSULE_MAX_MS) throw badRequest('Choose an opening date within 25 years.', { fields: { opensAt: 'Choose an earlier date.' } });
}

function checkText(...texts: string[]) {
  if (texts.some((s) => analyzeText(s).risk !== 'normal')) throw new AppError(422, 'content_blocked', "This can't be shared. Try different words.");
}

/** Under-18 accounts keep chapters to followers, friends, close friends or only themselves. */
function checkAudience(birthDate: Date | null, a: string | undefined) {
  if (a !== 'public') return;
  const age = ageOf(birthDate);
  if (age !== null && age < 18) throw forbidden('Chapters of people under 18 can be for followers, friends, close friends or only you, not everyone.');
}

/**
 * Chapters: keeping stories, YAPILAPI's way.
 *
 * - Your archive: your stories after they expire, private to you, by month.
 * - Chapters: titled collections of stories on your profile with their own
 *   audience and cover. They play in order, with each story's date.
 * - Shared chapters: mutual follows you invite add their own stories,
 *   credited to them. The owner can remove any story or contributor.
 * - Time capsules: sealed until a date. Until then nobody gets the stories,
 *   only the cover, the date and the count; on the day, the owner and
 *   contributors are told it opened.
 * - Guestbook: one short line per viewer, checked by the text moderation;
 *   the owner can hide lines.
 */
export default async function chaptersModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function loadVisible(id: string, viewer: string | null) {
    const { rows } = await db.query(`${SUMMARY_SELECT} WHERE ch.id = $2 AND ${chapterVisibleSql('$1')}`, [viewer, id]);
    if (!rows[0]) throw notFound('Chapter');
    return rows[0] as Row;
  }

  async function summaries(where: string, params: unknown[], viewer: string | null, order = 'ch.updated_at DESC') {
    const { rows } = await db.query(`${SUMMARY_SELECT} WHERE ${where} AND ${chapterVisibleSql('$1')} ORDER BY ${order} LIMIT 100`, [viewer, ...params]);
    return rows.map((r) => toSummary(r, viewer));
  }

  /** Adds your own stories to a chapter you may add to. Returns how many were new. */
  async function addStories(chapterId: string, userId: string, momentIds: string[]) {
    if (!momentIds.length) return 0;
    return tx(db, async (c) => {
      // Lock the chapter so two adds can't pass the limit together.
      await c.query(`SELECT 1 FROM chapters WHERE id = $1 FOR UPDATE`, [chapterId]);
      const own = await c.query<{ id: string }>(
        `SELECT m.id FROM moments m WHERE m.id = ANY($1::uuid[]) AND m.author_id = $2 AND m.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM media x WHERE x.id = m.media_id AND x.moderation = 'blocked')`,
        [momentIds, userId],
      );
      if (own.rows.length !== new Set(momentIds).size) throw notFound('Story');
      const count = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM chapter_items WHERE chapter_id = $1`, [chapterId]);
      const fresh = await c.query<{ id: string }>(
        `SELECT id FROM unnest($1::uuid[]) AS id WHERE NOT EXISTS (SELECT 1 FROM chapter_items WHERE chapter_id = $2 AND moment_id = id)`,
        [own.rows.map((r) => r.id), chapterId],
      );
      if (count.rows[0]!.n + fresh.rows.length > CHAPTER_STORIES_MAX) throw badRequest(`A chapter holds up to ${CHAPTER_STORIES_MAX} stories.`);
      await c.query(`INSERT INTO chapter_items (chapter_id, moment_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [
        chapterId,
        fresh.rows.map((r) => r.id),
      ]);
      await c.query(`UPDATE chapters SET updated_at = now() WHERE id = $1`, [chapterId]);
      return fresh.rows.length;
    });
  }

  // ── Archive ─────────────────────────────────────────────────────────
  /** Months that have stories in your archive, newest first, with how many. */
  app.get('/v1/me/archive/months', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month, count(*)::int AS count
       FROM moments WHERE author_id = $1 AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= now()
       GROUP BY 1 ORDER BY 1 DESC LIMIT 600`,
      [u.id],
    );
    return { items: rows };
  });

  /**
   * Your archive: your stories that have expired, only ever shown to you, newest first. `month`
   * (YYYY-MM, UTC) narrows to one month; without it, the latest 300. Each story lists the
   * chapters it's in.
   */
  app.get('/v1/me/archive', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { month } = parse(monthSchema, req.query);
    const { rows } = await db.query(
      `SELECT m.id, m.body, m.media_url, m.media_kind, m.location_text, m.visibility = 'close_friends' AS close_friends, m.created_at, m.expires_at,
              md.poster_url, md.hls_url, md.variants, md.duration_ms, md.moderation,
              coalesce((SELECT json_agg(json_build_object('id', ch.id, 'title', ch.title) ORDER BY ch.created_at)
                        FROM chapter_items ci JOIN chapters ch ON ch.id = ci.chapter_id
                        WHERE ci.moment_id = m.id AND ch.deleted_at IS NULL), '[]') AS chapters
       FROM moments m LEFT JOIN media md ON md.id = m.media_id
       WHERE m.author_id = $1 AND m.deleted_at IS NULL AND m.expires_at IS NOT NULL AND m.expires_at <= now()
         AND ($2::text IS NULL OR date_trunc('month', m.created_at AT TIME ZONE 'UTC') = to_date($2, 'YYYY-MM'))
       ORDER BY m.created_at DESC LIMIT 300`,
      [u.id, month ?? null],
    );
    return {
      items: rows.map((r) => ({
        ...toStory(r),
        closeFriends: r.close_friends,
        expiresAt: r.expires_at,
        // A photo or video that failed a check stays in your archive but can't go in a chapter.
        ...(r.moderation === 'blocked' ? { blocked: true, mediaUrl: null, posterUrl: null, hlsUrl: null } : {}),
        chapters: r.chapters as { id: string; title: string }[],
      })),
    };
  });

  /** Delete a story from your archive (and from every chapter it's in). */
  app.delete('/v1/me/archive/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE moments SET deleted_at = now() WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Story');
    return { ok: true };
  });

  // ── Chapters ────────────────────────────────────────────────────────
  /**
   * Chapters on a profile: the person's own, then shared chapters they contribute to and chose
   * to show. Only the ones the viewer may see.
   */
  app.get('/v1/users/:id/chapters', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const { rows: who } = await db.query(
      `SELECT 1 FROM users u WHERE u.id = $2 AND u.status = 'active' AND ${notBlockedSql('u.id', '$1::uuid')}
         AND ($1::uuid IS NOT NULL OR NOT ${minor('u.birth_date')})`,
      [viewer, id],
    );
    if (!who[0]) throw notFound('That person');
    const items = await summaries(
      `(ch.owner_id = $2 OR EXISTS (SELECT 1 FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.user_id = $2 AND cm.status = 'accepted' AND cm.show_on_profile))`,
      [id],
      viewer,
      `(ch.owner_id = $2) DESC, ch.created_at DESC`,
    );
    return { items };
  });

  /** Your chapters: ones you own, contribute to, or are invited to. `canAdd` says where a story can go now. */
  app.get('/v1/me/chapters', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const items = await summaries(`(ch.owner_id = $1 OR EXISTS (SELECT 1 FROM chapter_members cm WHERE cm.chapter_id = ch.id AND cm.user_id = $1))`, [], u.id);
    return { items };
  });

  app.post('/v1/chapters', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createSchema, req.body);
    checkAudience(u.birthDate, input.audience);
    checkText(input.title, input.description);
    if (input.opensAt) checkOpensAt(input.opensAt);
    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chapters WHERE owner_id = $1 AND deleted_at IS NULL`, [u.id]);
    if (n.rows[0]!.n >= 100) throw badRequest('You have 100 chapters, the most you can have. Delete one to start another.');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO chapters (owner_id, title, description, audience, cover_gradient, cover_symbol, opens_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [u.id, input.title, input.description, input.audience, input.coverGradient, input.coverSymbol, input.opensAt ?? null],
    );
    const id = rows[0]!.id;
    await addStories(id, u.id, input.momentIds);
    track(db, u.id, 'chapter_created', { capsule: !!input.opensAt, stories: input.momentIds.length });
    reply.code(201);
    return { chapter: toSummary(await loadVisible(id, u.id), u.id) };
  });

  /**
   * A chapter and its stories in playing order (oldest first), each credited to its author.
   * A time capsule before its date has no stories here, except your own ones for you.
   */
  app.get('/v1/chapters/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const row = await loadVisible(id, viewer);
    const chapter = toSummary(row, viewer);
    const { rows } = await db.query(
      `SELECT m.id, m.body, m.media_url, m.media_kind, m.location_text, m.created_at, ci.added_at,
              md.poster_url, md.hls_url, md.variants, md.duration_ms, md.moderation, ${AUTHOR_COLS}
       FROM chapter_items ci JOIN chapters ch ON ch.id = ci.chapter_id JOIN moments m ON m.id = ci.moment_id
       JOIN users au ON au.id = m.author_id JOIN profiles pr ON pr.user_id = m.author_id LEFT JOIN media md ON md.id = m.media_id
       WHERE ci.chapter_id = $2 AND ${storyVisibleSql('$1')} AND (NOT ${SEALED} OR m.author_id = $1)
       ORDER BY m.created_at ASC, m.id LIMIT ${CHAPTER_STORIES_MAX}`,
      [viewer, id],
    );
    const members = await db.query(
      `SELECT cm.status, cm.show_on_profile, ${AUTHOR_COLS}
       FROM chapter_members cm JOIN profiles pr ON pr.user_id = cm.user_id JOIN users au ON au.id = cm.user_id
       WHERE cm.chapter_id = $2 AND au.status = 'active' AND ($3 OR cm.status = 'accepted') AND ${notBlockedSql('cm.user_id', '$1::uuid')}
       ORDER BY cm.joined_at NULLS LAST, cm.invited_at`,
      [viewer, id, chapter.role === 'owner'],
    );
    return {
      chapter,
      stories: rows.map((r) => ({ ...toStory(r), author: publicUserFrom(r, 'a_'), mine: r.a_id === viewer })),
      contributors: members.rows.map((r) => ({ user: publicUserFrom(r, 'a_'), status: r.status as 'invited' | 'accepted' })),
    };
  });

  app.patch('/v1/chapters/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(patchSchema, req.body);
    const row = await loadVisible(id, u.id);
    if (row.owner_id !== u.id) throw forbidden('Only the person who made this chapter can change it.');
    checkAudience(u.birthDate, input.audience);
    checkText(input.title ?? '', input.description ?? '');
    if (input.opensAt !== undefined) {
      if (row.sealed_at || (row.opens_at && !row.sealed_now)) throw badRequest('The opening date is fixed once a time capsule is sealed.');
      if (input.opensAt) checkOpensAt(input.opensAt);
    }
    if (input.coverStoryId) {
      const has = await db.query(`SELECT 1 FROM chapter_items WHERE chapter_id = $1 AND moment_id = $2`, [id, input.coverStoryId]);
      if (!has.rowCount) throw badRequest('Choose a cover from the stories in this chapter.');
    }
    const map: Record<string, string> = {
      title: 'title',
      description: 'description',
      audience: 'audience',
      coverGradient: 'cover_gradient',
      coverSymbol: 'cover_symbol',
      coverStoryId: 'cover_moment_id',
      opensAt: 'opens_at',
    };
    const sets = ['updated_at = now()'];
    const vals: unknown[] = [id];
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v === undefined) continue;
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    }
    await db.query(`UPDATE chapters SET ${sets.join(', ')} WHERE id = $1`, vals);
    return { chapter: toSummary(await loadVisible(id, u.id), u.id) };
  });

  app.delete('/v1/chapters/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE chapters SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [id, me(req).id]);
    if (!r.rowCount) throw notFound('Chapter');
    return { ok: true };
  });

  /** Seal a time capsule: nobody can add to it any more, and the opening date is fixed. */
  app.post('/v1/chapters/:id/seal', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const row = await loadVisible(id, u.id);
    if (row.owner_id !== u.id) throw forbidden('Only the person who made this chapter can seal it.');
    if (!row.opens_at) throw badRequest('Only a time capsule can be sealed. Choose an opening date first.');
    if (!row.adding_open) throw badRequest('This time capsule is already sealed.');
    if (!Number(row.story_count)) throw badRequest('Add a story before sealing.');
    await db.query(`UPDATE chapters SET sealed_at = now(), updated_at = now() WHERE id = $1`, [id]);
    return { chapter: toSummary(await loadVisible(id, u.id), u.id) };
  });

  // ── Stories in a chapter ────────────────────────────────────────────
  /** Add one of your stories (active or from your archive) to a chapter you own or contribute to. */
  app.post('/v1/chapters/:id/stories', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { momentId } = parse(z.object({ momentId: z.string().uuid() }), req.body);
    const row = await loadVisible(id, u.id);
    const summary = toSummary(row, u.id);
    if (summary.role !== 'owner' && summary.role !== 'contributor') throw forbidden('Only the owner and contributors can add stories.');
    if (!row.adding_open) throw badRequest('This time capsule is sealed, so nothing more can be added.');
    const added = await addStories(id, u.id, [momentId]);
    reply.code(added ? 201 : 200);
    return { added: added > 0 };
  });

  /** The owner can remove any story; contributors can remove their own. */
  app.delete('/v1/chapters/:id/stories/:momentId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, momentId } = parse(z.object({ id: z.string().uuid(), momentId: z.string().uuid() }), req.params);
    const row = await loadVisible(id, u.id);
    const r = await db.query(
      `DELETE FROM chapter_items ci USING moments m WHERE ci.chapter_id = $1 AND ci.moment_id = $2 AND m.id = ci.moment_id AND ($3 OR m.author_id = $4)`,
      [id, momentId, row.owner_id === u.id, u.id],
    );
    if (!r.rowCount) throw notFound('Story');
    await db.query(`UPDATE chapters SET updated_at = now(), cover_moment_id = NULLIF(cover_moment_id, $2) WHERE id = $1`, [id, momentId]);
    return { ok: true };
  });

  // ── Contributors ────────────────────────────────────────────────────
  /** Invite someone you follow who follows you back to add their stories. They get a notification. */
  app.post('/v1/chapters/:id/contributors', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    const row = await loadVisible(id, u.id);
    if (row.owner_id !== u.id) throw forbidden('Only the person who made this chapter can invite people.');
    if (userId === u.id) throw badRequest("You can't invite yourself.");
    if (!row.adding_open) throw badRequest('This time capsule is sealed, so nobody new can add to it.');
    const mutual = await db.query(
      `SELECT 1 FROM users x WHERE x.id = $2 AND x.status = 'active' AND ${notBlockedSql('x.id', '$1')}
         AND ${follows('$1', 'x.id')} AND ${follows('x.id', '$1')}`,
      [u.id, userId],
    );
    if (!mutual.rowCount) throw badRequest('You can invite people you follow who follow you back.');
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM chapter_members WHERE chapter_id = $1`, [id]);
    if (count.rows[0]!.n >= CHAPTER_CONTRIBUTORS_MAX) throw badRequest(`A chapter can have up to ${CHAPTER_CONTRIBUTORS_MAX} contributors.`);
    const ins = await db.query(`INSERT INTO chapter_members (chapter_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, userId]);
    if (ins.rowCount)
      await notify(db, ctx.realtime, {
        userId,
        category: 'friends',
        type: 'chapter_invite',
        actorId: u.id,
        entityType: 'chapter',
        entityId: id,
        data: { title: row.title },
      });
    reply.code(ins.rowCount ? 201 : 200);
    return { invited: true };
  });

  /** Accept an invitation to add to a chapter. */
  app.post('/v1/chapters/:id/join', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await loadVisible(id, u.id);
    const r = await db.query(
      `UPDATE chapter_members SET status = 'accepted', joined_at = now() WHERE chapter_id = $1 AND user_id = $2 AND status = 'invited'`,
      [id, u.id],
    );
    if (!r.rowCount) throw notFound('Invitation');
    return { chapter: toSummary(await loadVisible(id, u.id), u.id) };
  });

  /** Your choices as a contributor: whether the chapter also shows on your profile. */
  app.patch('/v1/chapters/:id/membership', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { showOnProfile } = parse(z.object({ showOnProfile: z.boolean() }), req.body);
    const r = await db.query(`UPDATE chapter_members SET show_on_profile = $3 WHERE chapter_id = $1 AND user_id = $2 AND status = 'accepted'`, [
      id,
      u.id,
      showOnProfile,
    ]);
    if (!r.rowCount) throw notFound('Chapter');
    return { showOnProfile };
  });

  /**
   * Remove a contributor (the owner), or leave or decline (yourself). Their stories leave the
   * chapter with them.
   */
  app.delete('/v1/chapters/:id/contributors/:userId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    const row = await loadVisible(id, u.id);
    if (row.owner_id !== u.id && userId !== u.id) throw forbidden();
    await tx(db, async (c) => {
      const r = await c.query(`DELETE FROM chapter_members WHERE chapter_id = $1 AND user_id = $2`, [id, userId]);
      if (!r.rowCount) throw notFound('Contributor');
      await c.query(`DELETE FROM chapter_items ci USING moments m WHERE ci.chapter_id = $1 AND m.id = ci.moment_id AND m.author_id = $2`, [id, userId]);
      await c.query(
        `UPDATE chapters SET updated_at = now(), cover_moment_id = CASE WHEN EXISTS (SELECT 1 FROM chapter_items WHERE chapter_id = $1 AND moment_id = cover_moment_id) THEN cover_moment_id END WHERE id = $1`,
        [id],
      );
    });
    return { ok: true };
  });

  // ── Guestbook ───────────────────────────────────────────────────────
  const entryParams = z.object({ id: z.string().uuid(), entryId: z.string().uuid() });

  /** Lines in a chapter's guestbook, newest first. The owner also sees hidden lines; you see your own line while it waits for a check. */
  app.get('/v1/chapters/:id/guestbook', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const row = await loadVisible(id, viewer);
    if (row.sealed_now) return { items: [], open: false };
    const isOwner = row.owner_id === viewer;
    const { rows } = await db.query(
      `SELECT g.id, g.body, g.status, g.hidden_at, g.created_at, g.updated_at, g.author_id, ${AUTHOR_COLS}
       FROM chapter_guestbook g JOIN profiles pr ON pr.user_id = g.author_id JOIN users au ON au.id = g.author_id
       WHERE g.chapter_id = $2 AND au.status = 'active' AND ${notBlockedSql('g.author_id', '$1::uuid')}
         AND (g.author_id = $1 OR (g.status = 'visible' AND (g.hidden_at IS NULL OR $3)))
       ORDER BY g.updated_at DESC LIMIT 200`,
      [viewer, id, isOwner],
    );
    return {
      open: true,
      items: rows.map((r) => ({
        id: r.id as string,
        body: r.body as string,
        author: publicUserFrom(r, 'a_'),
        mine: r.author_id === viewer,
        hidden: !!r.hidden_at,
        pending: r.status === 'review',
        createdAt: r.updated_at as Date,
      })),
    };
  });

  /**
   * Leave your line in the guestbook (one per person; writing again replaces it). Checked with the
   * text moderation: clearly harmful or spammy lines are refused, borderline ones wait for review
   * and show only to you until then.
   */
  app.post('/v1/chapters/:id/guestbook', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { body } = parse(
      z.object({ body: z.string().trim().min(1, 'Write a line.').max(CHAPTER_GUESTBOOK_MAX, `Up to ${CHAPTER_GUESTBOOK_MAX} characters.`) }),
      req.body,
    );
    const row = await loadVisible(id, u.id);
    if (row.sealed_now) throw badRequest('The guestbook opens with the time capsule.');
    const risk = analyzeText(body).risk;
    if (risk === 'restrict' || risk === 'escalate') throw new AppError(422, 'content_blocked', "This line can't be posted.");
    const status = risk === 'review' ? 'review' : 'visible';
    const { rows } = await db.query(
      `INSERT INTO chapter_guestbook (chapter_id, author_id, body, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (chapter_id, author_id) DO UPDATE SET body = EXCLUDED.body, status = EXCLUDED.status, updated_at = now()
       RETURNING id, hidden_at, updated_at`,
      [id, u.id, body, status],
    );
    reply.code(201);
    return { entry: { id: rows[0].id, body, mine: true, hidden: !!rows[0].hidden_at, pending: status === 'review', createdAt: rows[0].updated_at } };
  });

  /** The owner hides or shows a line. */
  app.put('/v1/chapters/:id/guestbook/:entryId/hidden', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, entryId } = parse(entryParams, req.params);
    const { hidden } = parse(z.object({ hidden: z.boolean() }), req.body);
    const row = await loadVisible(id, u.id);
    if (row.owner_id !== u.id) throw forbidden('Only the person who made this chapter can hide lines.');
    const r = await db.query(`UPDATE chapter_guestbook SET hidden_at = CASE WHEN $3 THEN coalesce(hidden_at, now()) END WHERE id = $1 AND chapter_id = $2`, [
      entryId,
      id,
      hidden,
    ]);
    if (!r.rowCount) throw notFound('Line');
    return { hidden };
  });

  /** Delete your own line. */
  app.delete('/v1/chapters/:id/guestbook/:entryId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, entryId } = parse(entryParams, req.params);
    const r = await db.query(`DELETE FROM chapter_guestbook WHERE id = $1 AND chapter_id = $2 AND author_id = $3`, [entryId, id, u.id]);
    if (!r.rowCount) throw notFound('Line');
    return { ok: true };
  });
}

/**
 * Time capsules whose date has come: tell the owner and contributors it opened, once. Run by
 * the background worker; tests call it directly.
 */
export async function openDueChapters(db: Pool, realtime: RealtimeHub): Promise<number> {
  const { rows } = await db.query<{ id: string; owner_id: string; title: string }>(
    `UPDATE chapters SET opened_notified_at = now()
     WHERE opens_at IS NOT NULL AND opens_at <= now() AND opened_notified_at IS NULL AND deleted_at IS NULL
     RETURNING id, owner_id, title`,
  );
  for (const ch of rows) {
    const members = await db.query<{ user_id: string }>(`SELECT user_id FROM chapter_members WHERE chapter_id = $1 AND status = 'accepted'`, [ch.id]);
    for (const userId of [ch.owner_id, ...members.rows.map((r) => r.user_id)])
      await notify(db, realtime, { userId, category: 'friends', type: 'chapter_opened', entityType: 'chapter', entityId: ch.id, data: { title: ch.title } }).catch(
        () => {},
      );
  }
  return rows.length;
}
