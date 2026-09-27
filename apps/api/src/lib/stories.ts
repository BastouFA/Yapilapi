import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  detectLanguage,
  extractHashtags,
  extractMentions,
  linkDomain,
  normalizeTag,
  pollPercents,
  type PublicUser,
  type StickerResults,
  type StoryCard,
  type StoryMusic,
  type StoryMusicStyle,
  type StorySticker,
  type StoryStickerInput,
  type storyStickerInputSchema,
} from '@yapilapi/shared';
import type { z } from 'zod';
import { minorRuleSql } from './collabs.ts';
import { AppError, notFound } from './errors.ts';
import { analyzeText } from './moderation.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { soundVisibleSql } from './sounds.ts';
import { publicUserFrom, usersByIds } from './users.ts';
import { notBlockedSql } from './visibility.ts';
import { mediaSizesSql, withSmallVariants } from './data-saver.ts';

type Q = Pool | PoolClient;

/**
 * Stories (moments aliased `m`, author user aliased `au`) the viewer `v` may see: their own, and active ones from people
 * they follow or are friends with. Close friends stories reach only the people on the author's close friends list who
 * still follow them. Stories whose photo or video was blocked are gone for everyone; sensitive ones are never shown to
 * people under 18 (or people whose age isn't known).
 *
 * With `open`, public stories from accounts that aren't private can also be opened by anyone (a shared link, a tag page,
 * a story card in a chat). The stories strip doesn't use it: it only shows people you follow.
 */
export function storyVisibleSql(v: string, opts: { open?: boolean } = {}): string {
  return `m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) AND au.status = 'active'
  AND ${notBlockedSql('m.author_id', v)}
  AND (m.author_id = ${v}
    OR (m.visibility = 'close_friends'
        AND EXISTS (SELECT 1 FROM close_friends cf WHERE cf.owner_id = m.author_id AND cf.friend_id = ${v})
        AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = m.author_id))
    OR (m.visibility IN ('public','followers') AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = m.author_id))
    OR (m.visibility IN ('public','followers','friends') AND EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${v} AND fr.user_b = m.author_id) OR (fr.user_b = ${v} AND fr.user_a = m.author_id)))
    ${opts.open ? `OR (m.visibility = 'public' AND NOT EXISTS (SELECT 1 FROM profiles px WHERE px.user_id = m.author_id AND px.is_private))` : ''})
  AND NOT EXISTS (SELECT 1 FROM media x WHERE x.id = m.media_id AND (x.moderation = 'blocked'
    OR (x.moderation = 'sensitive' AND NOT coalesce((SELECT uv.birth_date <= current_date - interval '18 years' FROM users uv WHERE uv.id = ${v}), false))))`;
}

/**
 * Active public stories only, from accounts that aren't private, without a blocked or sensitive photo or video:
 * what tag pages and trending may show. Followers-only and close friends stories never qualify.
 */
export const PUBLIC_STORY = `m.visibility = 'public' AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) AND au.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM profiles px WHERE px.user_id = m.author_id AND px.is_private)
  AND NOT EXISTS (SELECT 1 FROM media x WHERE x.id = m.media_id AND x.moderation IN ('blocked', 'sensitive'))`;

/** Columns for hydrateStories; the viewer is $1. Use with STORY_FROM. */
export const STORY_SELECT = `m.id, m.author_id, m.body, m.lang, m.media_url, m.media_kind, m.location_text, m.expires_at, m.created_at, m.visibility,
  m.stickers, m.tags, m.mentions, m.reshare_of, m.allow_reshare, m.sound_id, m.music,
  md.poster_url, md.hls_url, md.variants, md.duration_ms, md.moderation, ${mediaSizesSql('md')} AS sizes,
  v.viewer_id IS NOT NULL AS seen, coalesce(v.liked, false) AS liked,
  CASE WHEN m.author_id = $1 THEN (SELECT count(*) FROM moment_views mv WHERE mv.moment_id = m.id AND mv.viewer_id <> $1) END AS views,
  pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode`;
export const STORY_FROM = `FROM moments m JOIN profiles pr ON pr.user_id = m.author_id JOIN users au ON au.id = m.author_id
  LEFT JOIN media md ON md.id = m.media_id
  LEFT JOIN moment_views v ON v.moment_id = m.id AND v.viewer_id = $1`;

/** A sticker as stored on the story. */
export type StoredSticker = { id: string; x: number; y: number; scale: number; rotation: number } & (
  | { type: 'mention'; userId: string }
  | { type: 'hashtag'; tag: string }
  | { type: 'poll'; question: string; options: [string, string] }
  | { type: 'question'; prompt: string }
  | { type: 'slider'; prompt: string; emoji: string }
  | { type: 'countdown'; title: string; endsAt: string }
  | { type: 'link'; url: string; domain: string; label: string }
  | { type: 'place'; placeId: string }
);

type ParsedSticker = z.output<typeof storyStickerInputSchema>;

/** Link stickers are for accounts at least this old. */
export const LINK_STICKER_MIN_DAYS = 7;

/**
 * Check and store the stickers and text of a new story: mentioned people must
 * exist (and not block you either way), places must exist, links need an
 * account at least 7 days old, countdowns end in the future. Returns what to
 * store, with the people mentioned and the story's tags.
 */
export async function prepareStory(
  db: Q,
  authorId: string,
  body: string,
  input: ParsedSticker[] | StoryStickerInput[],
): Promise<{ stickers: StoredSticker[]; mentionIds: string[]; tags: string[] }> {
  const list = input as ParsedSticker[];
  const words = list.flatMap((s) =>
    s.type === 'poll'
      ? [s.question, ...s.options]
      : s.type === 'question' || s.type === 'slider'
        ? [s.prompt]
        : s.type === 'countdown'
          ? [s.title]
          : s.type === 'link'
            ? [s.label]
            : [],
  );
  if (words.length && analyzeText(words.join('\n')).risk !== 'normal') throw new AppError(422, 'content_blocked', "This story can't be shared.");

  const names = [...new Set([...list.flatMap((s) => (s.type === 'mention' ? [s.username.toLowerCase()] : [])), ...extractMentions(body)])];
  const people = names.length
    ? (
        await db.query<{ user_id: string; username: string }>(
          `SELECT pr.user_id, lower(pr.username) AS username FROM profiles pr JOIN users u ON u.id = pr.user_id
           WHERE lower(pr.username) = ANY($1::text[]) AND u.status = 'active' AND ${notBlockedSql('pr.user_id', '$2')}`,
          [names, authorId],
        )
      ).rows
    : [];
  const byName = new Map(people.map((p) => [p.username, p.user_id]));

  if (list.some((s) => s.type === 'link')) {
    const u = (
      await db.query(`SELECT created_at <= now() - make_interval(days => $2) AS old_enough FROM users WHERE id = $1`, [authorId, LINK_STICKER_MIN_DAYS])
    ).rows[0];
    if (!u?.old_enough)
      throw new AppError(403, 'link_sticker_not_allowed', `Link stickers are available once your account is ${LINK_STICKER_MIN_DAYS} days old.`);
  }
  const placeIds = list.flatMap((s) => (s.type === 'place' ? [s.placeId] : []));
  if (placeIds.length) {
    const found = await db.query(`SELECT id FROM places WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [placeIds]);
    if (found.rowCount !== new Set(placeIds).size) throw notFound('That place');
  }

  const stickers: StoredSticker[] = list.map((s) => {
    const base = { id: randomUUID().slice(0, 8), x: s.x, y: s.y, scale: s.scale ?? 1, rotation: s.rotation ?? 0 };
    switch (s.type) {
      case 'mention': {
        const userId = byName.get(s.username.toLowerCase());
        if (!userId) throw new AppError(400, 'validation_failed', `We couldn't find @${s.username}.`);
        return { ...base, type: 'mention', userId };
      }
      case 'hashtag':
        return { ...base, type: 'hashtag', tag: normalizeTag(s.tag) };
      case 'poll':
        return { ...base, type: 'poll', question: s.question ?? '', options: s.options };
      case 'question':
        return { ...base, type: 'question', prompt: s.prompt };
      case 'slider':
        return { ...base, type: 'slider', prompt: s.prompt, emoji: s.emoji };
      case 'countdown': {
        const ends = new Date(s.endsAt);
        if (!(ends.getTime() > Date.now()) || ends.getTime() > Date.now() + 366 * 86_400_000)
          throw new AppError(400, 'validation_failed', 'Choose an end time in the next year.');
        return { ...base, type: 'countdown', title: s.title, endsAt: ends.toISOString() };
      }
      case 'link':
        return { ...base, type: 'link', url: s.url, domain: linkDomain(s.url), label: s.label ?? '' };
      case 'place':
        return { ...base, type: 'place', placeId: s.placeId };
    }
  });

  const mentionIds = [...new Set([...byName.values()])].filter((id) => id !== authorId);
  const tags = [...new Set([...extractHashtags(body), ...stickers.flatMap((s) => (s.type === 'hashtag' ? [s.tag] : []))])].slice(0, 10);
  return { stickers, mentionIds, tags };
}

/**
 * Tell people mentioned in a story, but only those who can see it, and not across the minor line between people
 * who aren't friends (as for photo tags). Blocks, mutes and settings apply as usual.
 */
export async function notifyStoryMentions(db: Q, realtime: RealtimeHub, m: { storyId: string; actorId: string; userIds: string[] }): Promise<number> {
  if (!m.userIds.length) return 0;
  const allowed = (
    await db.query<{ id: string }>(`SELECT x.id FROM unnest($2::uuid[]) AS x(id) WHERE ${minorRuleSql('$1::uuid', 'x.id')}`, [m.actorId, m.userIds])
  ).rows.map((r) => r.id);
  let sent = 0;
  for (const userId of allowed) {
    if (userId === m.actorId || !(await canSeeStory(db, m.storyId, userId))) continue;
    await notify(db, realtime, { userId, category: 'friends', type: 'story_mention', actorId: m.actorId, entityType: 'moment', entityId: m.storyId });
    sent++;
  }
  return sent;
}

/** Whether someone can open a story (their own, their people's, or a public one). */
export async function canSeeStory(db: Q, storyId: string, viewer: string | null): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM moments m JOIN users au ON au.id = m.author_id WHERE m.id = $2 AND ${storyVisibleSql('$1', { open: true })}`, [
    viewer,
    storyId,
  ]);
  return !!r.rowCount;
}

/** Story cards for a reader: each opens only if the reader can see that story. */
export async function storyCards(db: Q, ids: string[], viewer: string | null): Promise<Map<string, StoryCard>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, StoryCard>(unique.map((id) => [id, { id, available: false }]));
  if (!unique.length) return out;
  const { rows } = await db.query(
    `SELECT m.id, m.body, m.media_url, m.media_kind, m.expires_at, md.poster_url, md.variants,
            pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
     FROM moments m JOIN users au ON au.id = m.author_id JOIN profiles pr ON pr.user_id = m.author_id LEFT JOIN media md ON md.id = m.media_id
     WHERE m.id = ANY($2::uuid[]) AND ${storyVisibleSql('$1', { open: true })}`,
    [viewer, unique],
  );
  for (const r of rows)
    out.set(r.id, {
      id: r.id,
      available: true,
      author: publicUserFrom(r, 'a_'),
      body: r.body,
      mediaUrl: r.variants?.mp4 ?? r.media_url,
      mediaKind: r.media_kind,
      posterUrl: r.poster_url ?? null,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    });
  return out;
}

/** A story as the API returns it (see Story in the API client). */
export interface StoryOut {
  id: string;
  body: string;
  /** Detected language of the text, for "See translation" (null when unknown or there's no text). */
  lang: string | null;
  mediaUrl: string | null;
  mediaKind: string | null;
  posterUrl: string | null;
  hlsUrl: string | null;
  /** Processed sizes (thumb/medium for photos; mp4_360, hls_360, thumb for videos), for Data saver. */
  variants?: Record<string, string>;
  /** Bytes of the original and of each processed size. */
  sizes?: Record<string, number>;
  durationMs: number | null;
  sensitive?: true;
  locationText: string | null;
  closeFriends: boolean;
  public: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  seen: boolean;
  liked: boolean;
  views?: number;
  tags: string[];
  stickers: StorySticker[];
  reshareOf: StoryCard | null;
  /** You're mentioned in it. */
  mentionsYou: boolean;
  /** You can add it to your own story. */
  canReshare: boolean;
  /** Your own stories: whether others may reshare it. */
  allowReshare?: boolean;
  /** A sound playing with the story, while the viewer can see that sound. */
  music: StoryMusic | null;
}

/** A story's music as stored (the sound is moments.sound_id). */
export interface StoredMusic {
  startMs: number;
  durationMs: number;
  style: StoryMusicStyle;
  x: number;
  y: number;
}

/** The sounds on these stories that the viewer can see (the same rule as sound pages), by id. */
async function storySounds(db: Q, ids: string[], viewer: string | null): Promise<Map<string, StoryMusic['sound']>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT s.id, s.title, coalesce(s.duration_ms, sm.duration_ms) AS duration_ms, coalesce(sm.variants->>'mp4', sm.url) AS audio_url, sm.poster_url,
            pr.display_name, pr.username
     FROM sounds s JOIN profiles pr ON pr.user_id = s.owner_id LEFT JOIN media sm ON sm.id = s.media_id
     WHERE s.id = ANY($1::uuid[]) AND ${soundVisibleSql('$2::uuid')}`,
    [ids, viewer],
  );
  return new Map(
    rows.map((r) => [
      r.id as string,
      {
        id: r.id,
        title: r.title,
        artist: r.display_name,
        username: r.username,
        durationMs: r.duration_ms ?? null,
        audioUrl: r.audio_url ?? null,
        coverUrl: r.poster_url ?? null,
      },
    ]),
  );
}

/** Turn story rows (STORY_SELECT) into what a viewer sees: stickers with their state, reshare cards, mentions. */
export async function hydrateStories(db: Q, rows: Record<string, any>[], viewer: string | null): Promise<StoryOut[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as string);
  const stickersOf = (r: Record<string, any>) => (r.stickers ?? []) as StoredSticker[];
  const all = rows.flatMap(stickersOf);
  const userIds = [...new Set(all.flatMap((s) => (s.type === 'mention' ? [s.userId] : [])))];
  const placeIds = [...new Set(all.flatMap((s) => (s.type === 'place' ? [s.placeId] : [])))];
  const interactive = all.some((s) => s.type === 'poll' || s.type === 'question' || s.type === 'slider' || s.type === 'countdown');
  const soundIds = [...new Set(rows.flatMap((r) => (r.sound_id && r.music ? [r.sound_id as string] : [])))];
  const [users, places, mine, totals, cards, sounds] = await Promise.all([
    usersByIds(db, userIds),
    placeIds.length
      ? db.query<{ id: string; name: string; city: string | null }>(`SELECT id, name, city FROM places WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [
          placeIds,
        ])
      : null,
    interactive && viewer
      ? db.query(
          `SELECT moment_id, sticker_id, kind, choice, value, count(*) OVER (PARTITION BY moment_id, sticker_id, kind) AS n
           FROM story_responses WHERE moment_id = ANY($1::uuid[]) AND user_id = $2`,
          [ids, viewer],
        )
      : null,
    interactive
      ? db.query(
          `SELECT moment_id, sticker_id, kind, choice, count(*)::int AS n, avg(value) AS avg
           FROM story_responses WHERE moment_id = ANY($1::uuid[]) AND kind IN ('poll','slider') GROUP BY 1, 2, 3, 4`,
          [ids],
        )
      : null,
    storyCards(
      db,
      rows.flatMap((r) => (r.reshare_of ? [r.reshare_of as string] : [])),
      viewer,
    ),
    storySounds(db, soundIds, viewer),
  ]);
  const placeById = new Map((places?.rows ?? []).map((p) => [p.id, p]));
  const key = (m: string, s: string) => `${m}:${s}`;
  const own = new Map<string, Record<string, any>>();
  for (const r of mine?.rows ?? []) own.set(key(r.moment_id, r.sticker_id), r);
  const agg = new Map<string, { counts: [number, number]; avg: number | null; n: number }>();
  for (const r of totals?.rows ?? []) {
    const k = key(r.moment_id, r.sticker_id);
    const a = agg.get(k) ?? { counts: [0, 0] as [number, number], avg: null, n: 0 };
    if (r.kind === 'poll' && (r.choice === 0 || r.choice === 1)) a.counts[r.choice as 0 | 1] = Number(r.n);
    if (r.kind === 'slider') {
      a.avg = r.avg === null ? null : Number(r.avg);
      a.n = Number(r.n);
    }
    agg.set(k, a);
  }

  return rows.map((r) => {
    const isAuthor = !!viewer && r.author_id === viewer;
    const stickers: StorySticker[] = [];
    for (const s of stickersOf(r)) {
      const pos = { id: s.id, x: s.x, y: s.y, scale: s.scale ?? 1, rotation: s.rotation ?? 0 };
      const mineRow = own.get(key(r.id, s.id));
      const a = agg.get(key(r.id, s.id));
      switch (s.type) {
        case 'mention': {
          const user = users.get(s.userId);
          if (user) stickers.push({ ...pos, type: 'mention', user });
          break;
        }
        case 'hashtag':
          stickers.push({ ...pos, type: 'hashtag', tag: s.tag });
          break;
        case 'poll': {
          const voted = mineRow && mineRow.kind === 'poll' ? Number(mineRow.choice) : null;
          const counts = a?.counts ?? [0, 0];
          stickers.push({
            ...pos,
            type: 'poll',
            question: s.question,
            options: s.options,
            voted,
            ...(voted !== null || isAuthor ? { results: pollPercents(counts), votes: counts[0] + counts[1] } : {}),
          });
          break;
        }
        case 'question':
          stickers.push({ ...pos, type: 'question', prompt: s.prompt, answered: mineRow && mineRow.kind === 'question' ? Number(mineRow.n) : 0 });
          break;
        case 'slider':
          stickers.push({
            ...pos,
            type: 'slider',
            prompt: s.prompt,
            emoji: s.emoji,
            mine: mineRow && mineRow.kind === 'slider' ? Number(mineRow.value) : null,
            ...(isAuthor ? { average: a?.avg ?? null, count: a?.n ?? 0 } : {}),
          });
          break;
        case 'countdown':
          stickers.push({ ...pos, type: 'countdown', title: s.title, endsAt: s.endsAt, reminding: mineRow?.kind === 'reminder' });
          break;
        case 'link':
          stickers.push({ ...pos, type: 'link', url: s.url, domain: s.domain, label: s.label });
          break;
        case 'place': {
          const p = placeById.get(s.placeId);
          if (p) stickers.push({ ...pos, type: 'place', placeId: p.id, name: p.name, city: p.city });
          break;
        }
      }
    }
    const mentions = (r.mentions ?? []) as string[];
    const mentionsYou = !!viewer && mentions.includes(viewer);
    const sound = r.sound_id ? sounds.get(r.sound_id) : undefined;
    const stored = r.music as StoredMusic | null;
    return {
      id: r.id,
      body: r.body,
      lang: r.lang ?? detectLanguage(r.body),
      mediaUrl: r.variants?.mp4 ?? r.media_url,
      mediaKind: r.media_kind,
      posterUrl: r.poster_url ?? null,
      hlsUrl: r.hls_url ?? null,
      ...(r.variants && Object.keys(r.variants).length
        ? { variants: withSmallVariants({ kind: r.media_kind, hlsUrl: r.hls_url, variants: r.variants as Record<string, string> }).variants! }
        : {}),
      ...(r.sizes ? { sizes: r.sizes as Record<string, number> } : {}),
      durationMs: r.duration_ms ?? null,
      ...(r.moderation === 'sensitive' ? { sensitive: true as const } : {}),
      locationText: r.location_text,
      closeFriends: r.visibility === 'close_friends',
      public: r.visibility === 'public',
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      seen: isAuthor || !!r.seen,
      liked: !!r.liked,
      views: r.views === null || r.views === undefined ? undefined : Number(r.views),
      tags: r.tags ?? [],
      stickers,
      reshareOf: r.reshare_of ? (cards.get(r.reshare_of) ?? { id: r.reshare_of, available: false }) : null,
      mentionsYou,
      canReshare: !!viewer && !isAuthor && r.allow_reshare && !r.reshare_of && (r.visibility === 'public' || mentionsYou),
      ...(isAuthor ? { allowReshare: !!r.allow_reshare } : {}),
      music: sound && stored ? { sound, startMs: stored.startMs, durationMs: stored.durationMs, style: stored.style, x: stored.x, y: stored.y } : null,
    };
  });
}

export interface StoryGroupOut {
  author: PublicUser;
  mine: boolean;
  allSeen: boolean;
  moments: StoryOut[];
}

/** Group stories by author: yours first, then people with stories you haven't seen, newest first. */
export async function groupStories(db: Q, rows: Record<string, any>[], viewer: string | null): Promise<StoryGroupOut[]> {
  const stories = await hydrateStories(db, rows, viewer);
  const groups = new Map<string, StoryGroupOut & { latest: number }>();
  rows.forEach((r, i) => {
    const s = stories[i]!;
    const mine = !!viewer && r.a_id === viewer;
    const g = groups.get(r.a_id) ?? { author: publicUserFrom(r, 'a_'), mine, allSeen: true, latest: 0, moments: [] };
    g.moments.push(s);
    g.allSeen &&= s.seen;
    g.latest = Math.max(g.latest, new Date(r.created_at).getTime());
    groups.set(r.a_id, g);
  });
  return [...groups.values()]
    .sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.allSeen) - Number(b.allSeen) || b.latest - a.latest)
    .map(({ latest: _latest, ...g }) => g);
}

/** Results of a story's interactive stickers, for its author ("Seen by"). */
export async function stickerResults(db: Q, storyId: string, stored: StoredSticker[], viewer: string): Promise<StickerResults[]> {
  const interactive = stored.filter((s) => s.type === 'poll' || s.type === 'question' || s.type === 'slider' || s.type === 'countdown');
  if (!interactive.length) return [];
  const [totals, answers] = await Promise.all([
    db.query(
      `SELECT sticker_id, kind, choice, count(*)::int AS n, avg(value) AS avg FROM story_responses
       WHERE moment_id = $1 AND kind IN ('poll','slider','reminder') AND ${notBlockedSql('user_id', '$2')} GROUP BY 1, 2, 3`,
      [storyId, viewer],
    ),
    db.query(
      `SELECT r.id, r.sticker_id, r.answer, r.created_at,
              pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode
       FROM story_responses r JOIN profiles pr ON pr.user_id = r.user_id
       WHERE r.moment_id = $1 AND r.kind = 'question' AND ${notBlockedSql('r.user_id', '$2')}
       ORDER BY r.created_at DESC LIMIT 500`,
      [storyId, viewer],
    ),
  ]);
  return interactive.map((s): StickerResults => {
    const mine = totals.rows.filter((r) => r.sticker_id === s.id);
    if (s.type === 'poll') {
      const counts: [number, number] = [0, 0];
      for (const r of mine) if (r.kind === 'poll' && (r.choice === 0 || r.choice === 1)) counts[r.choice as 0 | 1] = Number(r.n);
      return { stickerId: s.id, type: 'poll', options: s.options, counts, percents: pollPercents(counts), votes: counts[0] + counts[1] };
    }
    if (s.type === 'slider') {
      const r = mine.find((x) => x.kind === 'slider');
      return { stickerId: s.id, type: 'slider', emoji: s.emoji, prompt: s.prompt, average: r?.avg == null ? null : Number(r.avg), count: Number(r?.n ?? 0) };
    }
    if (s.type === 'countdown') {
      const r = mine.find((x) => x.kind === 'reminder');
      return { stickerId: s.id, type: 'countdown', title: s.title, endsAt: s.endsAt, reminders: Number(r?.n ?? 0) };
    }
    const q = s as Extract<StoredSticker, { type: 'question' }>;
    return {
      stickerId: s.id,
      type: 'question',
      prompt: q.prompt,
      answers: answers.rows
        .filter((r) => r.sticker_id === s.id)
        .map((r) => ({ id: r.id, user: publicUserFrom(r, 'a_'), text: r.answer, createdAt: new Date(r.created_at).toISOString() })),
    };
  });
}

/**
 * Countdown reminders that are due: each person who tapped "Remind me" gets a
 * notification when the countdown ends (unless the story was deleted).
 */
export async function sendCountdownReminders(db: Pool, realtime: RealtimeHub, limit = 100): Promise<number> {
  const { rows } = await db.query(
    `UPDATE story_responses r SET notified_at = now()
     FROM moments m
     WHERE r.id IN (SELECT x.id FROM story_responses x WHERE x.kind = 'reminder' AND x.notified_at IS NULL AND x.remind_at <= now()
                    ORDER BY x.remind_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       AND m.id = r.moment_id
     RETURNING r.user_id, r.moment_id, r.sticker_id, m.author_id, m.deleted_at, m.stickers`,
    [limit],
  );
  let sent = 0;
  for (const r of rows) {
    if (r.deleted_at) continue;
    const s = (r.stickers as StoredSticker[]).find((x) => x.id === r.sticker_id);
    if (!s || s.type !== 'countdown') continue;
    await notify(db, realtime, {
      userId: r.user_id,
      category: 'friends',
      type: 'story_countdown',
      actorId: r.author_id === r.user_id ? undefined : r.author_id,
      entityType: 'moment',
      entityId: r.moment_id,
      data: { title: s.title },
    });
    sent++;
  }
  return sent;
}
