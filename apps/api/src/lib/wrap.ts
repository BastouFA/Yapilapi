import type { Pool, PoolClient } from 'pg';
import sharp, { type OverlayOptions } from 'sharp';
import {
  isEmptyWeek,
  isRtl,
  WRAP_CARD_DAYS,
  WRAP_HOUR,
  type OnThisDayCard,
  type Post,
  type PublicUser,
  type WeeklyWrap,
  type WeeklyWrapCard,
  type WeeklyWrapCounts,
  type WeeklyWrapSong,
} from '@yapilapi/shared';
// Every language, loaded up front: the card is drawn in its owner's.
import { t, tp } from '@yapilapi/shared/i18n';
import { hydratePosts } from './posts.ts';
import type { RealtimeHub } from './realtime.ts';
import { RECAP_FONTS } from './recaps.ts';
import { notify } from './services.ts';
import type { MediaStorage } from './storage.ts';
import { PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from './users.ts';
import { eventVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

export interface WrapDeps {
  db: Q;
  realtime: RealtimeHub;
}

/** What a wrap keeps: counts and the ids of what to show, read back through the usual rules each time it's opened. */
interface WrapSummary {
  counts: WeeklyWrapCounts;
  bestIds: string[];
  friendIds: string[];
  communityIds: string[];
  eventIds: string[];
  placeIds: string[];
  songs: WeeklyWrapSong[];
}

/**
 * The time zone someone's week is worked out in: the one their device last reported, else the
 * one they set for quiet hours, else UTC.
 */
export const TIMEZONE_SQL = (up: string) => `coalesce(${up}.timezone, nullif(${up}.quiet_timezone, 'UTC'), 'UTC')`;

/** Whether Postgres knows this time zone (the week is worked out in SQL). */
export async function isKnownTimeZone(db: Q, tz: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    await db.query(`SELECT now() AT TIME ZONE $1`, [tz]);
    return true;
  } catch {
    return false;
  }
}

/** Your posts' score for "best moments": what people did with it, views counting a little. */
const SCORE_SQL = `(p.like_count + 2 * p.comment_count + 2 * p.repost_count + p.view_count / 20.0)`;

/**
 * Work out one person's week (Monday `weekStart` to Sunday, in `tz`). Only their own content and
 * their own connections go in; songs are catalogue songs and sounds that are theirs or public.
 */
export async function summarizeWeek(db: Q, userId: string, weekStart: string, tz: string): Promise<WrapSummary> {
  const range = [userId, weekStart, tz];
  const FROM = `($2::date::timestamp AT TIME ZONE $3)`;
  const TO = `(($2::date + 7)::timestamp AT TIME ZONE $3)`;
  const own = `p.author_id = $1 AND p.deleted_at IS NULL AND p.status = 'published' AND p.created_at >= ${FROM} AND p.created_at < ${TO}`;
  const counts = (
    await db.query(
      `SELECT count(*) FILTER (WHERE p.format = 'post')::int AS posts, count(*) FILTER (WHERE p.format = 'reel')::int AS reels FROM posts p WHERE ${own}`,
      range,
    )
  ).rows[0];
  const best = await db.query<{ id: string }>(
    `SELECT p.id FROM posts p WHERE ${own} AND p.moderation_status = 'normal' ORDER BY ${SCORE_SQL} DESC, p.created_at DESC LIMIT 3`,
    range,
  );
  const friends = await db.query<{ id: string }>(
    `SELECT CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END AS id FROM friendships f
     WHERE (f.user_a = $1 OR f.user_b = $1) AND f.created_at >= ${FROM} AND f.created_at < ${TO} ORDER BY f.created_at DESC`,
    range,
  );
  const communities = await db.query<{ id: string }>(
    `SELECT cm.community_id AS id FROM community_members cm JOIN communities c ON c.id = cm.community_id
     WHERE cm.user_id = $1 AND cm.status = 'active' AND c.deleted_at IS NULL AND cm.joined_at >= ${FROM} AND cm.joined_at < ${TO} ORDER BY cm.joined_at DESC`,
    range,
  );
  // Events you said you'd go to that happened this week.
  const events = await db.query<{ id: string; place_id: string | null }>(
    `SELECT e.id, e.place_id FROM event_attendees ea JOIN events e ON e.id = ea.event_id
     WHERE ea.user_id = $1 AND ea.status = 'going' AND e.deleted_at IS NULL AND e.starts_at >= ${FROM} AND e.starts_at < ${TO} AND e.starts_at < now()
     ORDER BY e.starts_at`,
    range,
  );
  // Places: ones you reviewed this week, and where those events were.
  const reviewed = await db.query<{ id: string }>(
    `SELECT r.place_id AS id FROM place_reviews r WHERE r.author_id = $1 AND r.created_at >= ${FROM} AND r.created_at < ${TO} ORDER BY r.created_at`,
    range,
  );
  const placeIds = [...new Set([...reviewed.rows.map((r) => r.id), ...events.rows.map((e) => e.place_id).filter((x): x is string => !!x)])];
  const tracks = await db.query<{ id: string; title: string; artist: string; uses: number }>(
    `SELECT t.id, t.title, t.artist, count(*)::int AS uses FROM posts p JOIN music_tracks t ON t.id = p.music_track_id
     WHERE ${own} GROUP BY t.id ORDER BY uses DESC, t.title LIMIT 5`,
    range,
  );
  // Sounds borrowed from another reel (not a reel's own audio), when they're yours or public.
  const sounds = await db.query<{ id: string; title: string; uses: number }>(
    `SELECT s.id, s.title, count(*)::int AS uses FROM posts p JOIN sounds s ON s.id = p.sound_id
     WHERE ${own} AND s.source_post_id IS DISTINCT FROM p.id
       AND (s.owner_id = $1 OR EXISTS (SELECT 1 FROM posts sp JOIN profiles spr ON spr.user_id = sp.author_id
                                        WHERE sp.id = s.source_post_id AND sp.visibility = 'public' AND sp.deleted_at IS NULL AND NOT spr.is_private))
     GROUP BY s.id ORDER BY uses DESC, s.title LIMIT 5`,
    range,
  );
  const songs: WeeklyWrapSong[] = [
    ...tracks.rows.map((r) => ({ kind: 'track' as const, id: r.id, title: r.title, artist: r.artist, uses: r.uses })),
    ...sounds.rows.map((r) => ({ kind: 'sound' as const, id: r.id, title: r.title, artist: null, uses: r.uses })),
  ]
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 5);
  return {
    counts: {
      posts: counts.posts,
      reels: counts.reels,
      newFriends: friends.rows.length,
      communities: communities.rows.length,
      places: placeIds.length,
      events: events.rows.length,
      songs: songs.length,
    },
    bestIds: best.rows.map((r) => r.id),
    friendIds: friends.rows.slice(0, 12).map((r) => r.id),
    communityIds: communities.rows.slice(0, 12).map((r) => r.id),
    eventIds: events.rows.slice(0, 12).map((r) => r.id),
    placeIds: placeIds.slice(0, 12),
    songs,
  };
}

/**
 * The moment of the week: one of your own posts from the week, with a photo or video when you
 * shared one (nothing flagged as sensitive), the one people did the most with.
 */
export async function momentOfWeek(db: Q, userId: string, weekStart: string, tz: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id FROM posts p
     WHERE p.author_id = $1 AND p.deleted_at IS NULL AND p.status = 'published' AND p.moderation_status = 'normal'
       AND p.created_at >= ($2::date::timestamp AT TIME ZONE $3) AND p.created_at < (($2::date + 7)::timestamp AT TIME ZONE $3)
       AND NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation IN ('sensitive', 'blocked'))
     ORDER BY EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.kind IN ('image', 'video')) DESC,
              ${SCORE_SQL} DESC, p.created_at DESC
     LIMIT 1`,
    [userId, weekStart, tz],
  );
  return rows[0]?.id ?? null;
}

/**
 * Make the wraps that are due: for everyone with the wrap on whose Sunday evening (from 18:00 in
 * their time zone) has come and who has no wrap for this week yet. A week without activity is
 * noted (so it isn't looked at again) and nothing is shown or sent. The notification goes out
 * when they want it. `now` is for tests. Returns how many wraps with something in them were made.
 */
export async function sweepWeeklyWraps(deps: WrapDeps, opts: { now?: Date; limit?: number; userIds?: string[] } = {}): Promise<number> {
  const { now = new Date(), limit = 200, userIds = null } = opts;
  const { rows } = await deps.db.query<{ id: string; tz: string; week_start: string; notify: boolean }>(
    `WITH cand AS (
       SELECT u.id, ${TIMEZONE_SQL('up')} AS tz, coalesce(up.weekly_wrap_notify, true) AS notify
       FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
       WHERE u.status = 'active' AND coalesce(up.weekly_wrap, true) AND ($4::uuid[] IS NULL OR u.id = ANY($4::uuid[]))
     ), local AS (
       SELECT id, tz, notify, ($1::timestamptz AT TIME ZONE tz) AS at FROM cand
     )
     SELECT id, tz, notify, to_char(at::date - 6, 'YYYY-MM-DD') AS week_start FROM local
     WHERE extract(isodow FROM at) = 7 AND extract(hour FROM at) >= $2
       AND NOT EXISTS (SELECT 1 FROM weekly_wraps w WHERE w.user_id = local.id AND w.week_start = at::date - 6)
     LIMIT $3`,
    [now, WRAP_HOUR, limit, userIds],
  );
  let made = 0;
  for (const r of rows) {
    const summary = await summarizeWeek(deps.db, r.id, r.week_start, r.tz);
    const empty = isEmptyWeek(summary.counts);
    const moment = empty ? null : await momentOfWeek(deps.db, r.id, r.week_start, r.tz);
    const ins = await deps.db.query<{ id: string }>(
      `INSERT INTO weekly_wraps (user_id, week_start, timezone, empty, summary, moment_post_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, week_start) DO NOTHING RETURNING id`,
      [r.id, r.week_start, r.tz, empty, empty ? {} : summary, moment],
    );
    const id = ins.rows[0]?.id;
    if (!id || empty) continue;
    made++;
    if (r.notify) {
      await notify(deps.db, deps.realtime, {
        userId: r.id,
        category: 'system',
        type: 'weekly_wrap',
        entityType: 'wrap',
        entityId: id,
        data: { weekStart: r.week_start },
      });
      await deps.db.query(`UPDATE weekly_wraps SET notified_at = now() WHERE id = $1`, [id]);
    }
  }
  return made;
}

const WRAP_COLS = `w.id, w.user_id, to_char(w.week_start, 'YYYY-MM-DD') AS week_start, to_char(w.week_start + 6, 'YYYY-MM-DD') AS week_end, w.timezone, w.summary, w.moment_post_id, w.created_at`;

/** One of your wraps, read back now: posts, friends, communities and events you can still see. */
export async function wrapFor(db: Q, wrapId: string, owner: string): Promise<WeeklyWrap | null> {
  const { rows } = await db.query(`SELECT ${WRAP_COLS} FROM weekly_wraps w WHERE w.id = $1 AND w.user_id = $2 AND NOT w.empty`, [wrapId, owner]);
  const w = rows[0];
  if (!w) return null;
  const s = w.summary as WrapSummary;
  const [best, moment] = await Promise.all([
    hydratePosts(db, s.bestIds ?? [], owner),
    w.moment_post_id ? hydratePosts(db, [w.moment_post_id], owner) : Promise.resolve([]),
  ]);
  // Friends you still have and can see (a block since, or a deleted account, takes them out).
  const friends = s.friendIds?.length
    ? (
        await db.query<PublicUserRow>(
          `SELECT ${PUBLIC_USER_COLS} FROM profiles pr JOIN users u ON u.id = pr.user_id
           WHERE pr.user_id = ANY($2::uuid[]) AND u.status = 'active'
             AND EXISTS (SELECT 1 FROM friendships f WHERE f.user_a = LEAST($1::uuid, pr.user_id) AND f.user_b = GREATEST($1::uuid, pr.user_id))
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = pr.user_id) OR (b.blocker_id = pr.user_id AND b.blocked_id = $1))`,
          [owner, s.friendIds],
        )
      ).rows
    : [];
  const friendOrder = new Map((s.friendIds ?? []).map((id, i) => [id, i]));
  const communities = s.communityIds?.length
    ? (
        await db.query<{ id: string; slug: string; name: string }>(
          `SELECT c.id, c.slug, c.name FROM communities c WHERE c.id = ANY($2::uuid[]) AND c.deleted_at IS NULL
             AND (c.visibility = 'public' OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = $1 AND cm.status = 'active'))`,
          [owner, s.communityIds],
        )
      ).rows
    : [];
  const events = s.eventIds?.length
    ? (
        await db.query<{ id: string; title: string; starts_at: Date }>(
          `SELECT e.id, e.title, e.starts_at FROM events e WHERE e.id = ANY($2::uuid[]) AND ${eventVisibleSql('$1')} ORDER BY e.starts_at`,
          [owner, s.eventIds],
        )
      ).rows
    : [];
  const places = s.placeIds?.length
    ? (await db.query<{ id: string; name: string }>(`SELECT id, name FROM places WHERE id = ANY($1::uuid[]) ORDER BY name`, [s.placeIds])).rows
    : [];
  const bestOrder = new Map((s.bestIds ?? []).map((id, i) => [id, i]));
  return {
    id: w.id,
    weekStart: w.week_start,
    weekEnd: w.week_end,
    timezone: w.timezone,
    counts: s.counts,
    best: best.sort((a, b) => (bestOrder.get(a.id) ?? 0) - (bestOrder.get(b.id) ?? 0)),
    moment: moment[0] ?? null,
    newFriends: friends
      .sort((a, b) => (friendOrder.get(a.id) ?? 0) - (friendOrder.get(b.id) ?? 0))
      .slice(0, 6)
      .map(toPublicUser) as PublicUser[],
    communities,
    events: events.map((e) => ({ id: e.id, title: e.title, startsAt: e.starts_at.toISOString() })),
    places,
    songs: s.songs ?? [],
    cardPath: `/v1/wraps/${w.id}/card.png`,
    createdAt: w.created_at.toISOString(),
  };
}

/** Your wraps, newest first (weeks with something in them). */
export async function listWraps(db: Q, owner: string, limit = 12): Promise<WeeklyWrapCard[]> {
  const { rows } = await db.query(`SELECT ${WRAP_COLS} FROM weekly_wraps w WHERE w.user_id = $1 AND NOT w.empty ORDER BY w.week_start DESC LIMIT $2`, [
    owner,
    limit,
  ]);
  return cardsOf(db, rows, owner);
}

/** Cards for these wraps, with every wrap's moment loaded in one hydratePosts call. */
async function cardsOf(db: Q, rows: Record<string, any>[], owner: string): Promise<WeeklyWrapCard[]> {
  const ids = [...new Set(rows.map((w) => w.moment_post_id as string | null).filter((id): id is string => !!id))];
  const moments = new Map((ids.length ? await hydratePosts(db, ids, owner) : []).map((p) => [p.id, p]));
  return rows.map((w) => cardOf(w, w.moment_post_id ? moments.get(w.moment_post_id) : undefined));
}

function cardOf(w: Record<string, any>, moment: Post | undefined): WeeklyWrapCard {
  const m = moment?.media.find((x) => x.kind === 'image' || x.kind === 'video');
  return {
    id: w.id,
    weekStart: w.week_start,
    weekEnd: w.week_end,
    counts: (w.summary as WrapSummary).counts,
    thumbUrl: m && !m.sensitive ? (m.kind === 'video' ? (m.posterUrl ?? m.variants?.thumb ?? null) : (m.variants?.thumb ?? m.url)) : null,
  };
}

/** The wrap card for Pulse: this week's, for a few days after it was made, unless you put it away. */
export async function currentWrapCard(db: Q, owner: string): Promise<WeeklyWrapCard | null> {
  const { rows } = await db.query(
    `SELECT ${WRAP_COLS} FROM weekly_wraps w
     WHERE w.user_id = $1 AND NOT w.empty AND w.dismissed_at IS NULL AND w.created_at > now() - make_interval(days => $2)
       AND coalesce((SELECT up.weekly_wrap FROM user_preferences up WHERE up.user_id = $1), true)
     ORDER BY w.week_start DESC LIMIT 1`,
    [owner, WRAP_CARD_DAYS],
  );
  return rows[0] ? ((await cardsOf(db, rows, owner))[0] ?? null) : null;
}

/** "On this day": your own posts from this day in earlier years, in your time zone. */
export async function onThisDay(db: Q, owner: string, tz: string): Promise<OnThisDayCard | null> {
  const { rows } = await db.query<{ id: string; year: number; total: number }>(
    `WITH today AS (SELECT (now() AT TIME ZONE $2)::date AS d)
     SELECT p.id, extract(year FROM (p.created_at AT TIME ZONE $2))::int AS year, count(*) OVER ()::int AS total
     FROM posts p, today
     WHERE p.author_id = $1 AND p.deleted_at IS NULL AND p.status = 'published'
       AND extract(month FROM (p.created_at AT TIME ZONE $2)) = extract(month FROM today.d)
       AND extract(day FROM (p.created_at AT TIME ZONE $2)) = extract(day FROM today.d)
       AND (p.created_at AT TIME ZONE $2)::date < date_trunc('year', today.d)::date
     ORDER BY p.created_at DESC LIMIT 20`,
    [owner, tz],
  );
  if (!rows.length) return null;
  const posts = await hydratePosts(
    db,
    rows.slice(0, 3).map((r) => r.id),
    owner,
  );
  return { count: rows[0]!.total, years: [...new Set(rows.map((r) => r.year))], posts };
}

// ─── The card image ─────────────────────────────────────────────────────

const W = 1080;
const H = 1350;
const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A picture of your moment of the week: your own photo, or your video's poster, when stored here. */
async function momentPicture(db: Q, storage: MediaStorage, postId: string | null, owner: string): Promise<Buffer | null> {
  if (!postId) return null;
  const { rows } = await db.query<{ kind: string; storage_key: string | null }>(
    `SELECT m.kind, m.storage_key FROM post_media pm JOIN media m ON m.id = pm.media_id JOIN posts p ON p.id = pm.post_id
     WHERE pm.post_id = $1 AND p.author_id = $2 AND p.deleted_at IS NULL AND m.owner_id = $2 AND m.kind IN ('image', 'video')
       AND m.status = 'ready' AND m.deleted_at IS NULL AND NOT m.private AND m.moderation NOT IN ('sensitive', 'blocked')
     ORDER BY pm.position LIMIT 1`,
    [postId, owner],
  );
  const m = rows[0];
  if (!m?.storage_key || !/^[\w/.-]+$/.test(m.storage_key) || m.storage_key.includes('..')) return null;
  const base = m.storage_key.replace(/\.[^.]+$/, '');
  const keys = m.kind === 'video' ? [`${base}_poster.jpg`] : [`${base}_large.webp`, m.storage_key];
  for (const key of keys) {
    try {
      return await storage.read(key);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * The shareable card: your week in numbers, your moment of the week and your most used song, in
 * your language. Only your own content; nothing about anyone else. PNG, 1080 × 1350.
 */
export async function renderWrapCard(db: Q, storage: MediaStorage, wrapId: string, owner: string): Promise<Buffer | null> {
  const { rows } = await db.query(
    `SELECT ${WRAP_COLS}, pr.locale, pr.display_name FROM weekly_wraps w JOIN profiles pr ON pr.user_id = w.user_id WHERE w.id = $1 AND w.user_id = $2 AND NOT w.empty`,
    [wrapId, owner],
  );
  const w = rows[0];
  if (!w) return null;
  const locale: string = w.locale ?? 'en';
  const s = w.summary as WrapSummary;
  const fmt = (d: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  // Arabic and other right-to-left languages read from the right: lines start there and the numbers' columns swap.
  const rtl = isRtl(locale);
  const layers: OverlayOptions[] = [];
  const text = async (markup: string, bold: boolean, size: number, width = W - 160) =>
    sharp({
      text: {
        text: markup,
        fontfile: bold ? RECAP_FONTS.title : RECAP_FONTS.subtitle,
        font: `${bold ? 'Inter Bold' : 'Inter'} ${size}`,
        width,
        align: rtl ? 'right' : 'left',
        dpi: 72,
        rgba: true,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
  /** Where a block of text goes in a column: its start edge, which is the right one in right-to-left languages. */
  const startOf = (block: { info: { width: number } }, colLeft = 80, colWidth = W - 160) =>
    Math.round(rtl ? colLeft + colWidth - block.info.width : colLeft);
  let y = 96;
  try {
    const brand = await text(`<span foreground="#FFFFFFB3">YAPILAPI</span>`, true, 30);
    layers.push({ input: brand.data, left: startOf(brand), top: y });
    y += brand.info.height + 28;
    const title = await text(`<span foreground="white">${escapeMarkup(t('wrap.card.title', locale))}</span>`, true, 76);
    layers.push({ input: title.data, left: startOf(title), top: y });
    y += title.info.height + 12;
    const dates = await text(
      `<span foreground="#FFFFFFCC">${escapeMarkup(t('wrap.card.dates', locale, { start: fmt(w.week_start), end: fmt(w.week_end) }))}</span>`,
      false,
      36,
    );
    layers.push({ input: dates.data, left: startOf(dates), top: y });
    y += dates.info.height + 48;
  } catch {
    // No text rendering on this server: the card still has its picture and colours.
  }
  const picture = await momentPicture(db, storage, w.moment_post_id, owner);
  if (picture) {
    try {
      const pw = W - 160;
      const ph = 560;
      const mask = Buffer.from(`<svg width="${pw}" height="${ph}"><rect width="${pw}" height="${ph}" rx="36" ry="36"/></svg>`);
      const img = await sharp(picture)
        .rotate()
        .resize(pw, ph, { fit: 'cover' })
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
      layers.push({ input: img, left: 80, top: y });
      y += ph + 24;
      const label = await text(`<span foreground="#FFFFFFB3">${escapeMarkup(t('wrap.card.moment', locale))}</span>`, false, 30);
      layers.push({ input: label.data, left: startOf(label), top: y });
      y += label.info.height + 40;
    } catch {
      /* an unreadable picture is left out */
    }
  }
  // The numbers: only the ones that aren't zero, two to a row.
  const c = s.counts;
  const stats: [number, string][] = (
    [
      [c.posts, 'wrap.stat.posts'],
      [c.reels, 'wrap.stat.reels'],
      [c.newFriends, 'wrap.stat.friends'],
      [c.communities, 'wrap.stat.communities'],
      [c.places, 'wrap.stat.places'],
      [c.events, 'wrap.stat.events'],
      [c.songs, 'wrap.stat.songs'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, key]) => [n, tp(key, n, locale)]);
  try {
    const colW = (W - 160) / 2;
    // Without a picture the numbers get the room.
    const scale = picture ? 1 : 1.6;
    const rowH = Math.round(130 * scale);
    if (!picture) y += 40;
    for (let i = 0; i < Math.min(stats.length, 6); i++) {
      const [n, label] = stats[i]!;
      // The first of each pair goes on the start side.
      const left = 80 + (rtl ? 1 - (i % 2) : i % 2) * colW + (rtl ? 20 : 0);
      const top = y + Math.floor(i / 2) * rowH;
      if (top + rowH - 10 > H - 140) break;
      const num = await text(`<span foreground="white">${new Intl.NumberFormat(locale).format(n)}</span>`, true, Math.round(64 * scale), colW - 20);
      const lab = await text(`<span foreground="#FFFFFFCC">${escapeMarkup(label)}</span>`, false, Math.round(28 * Math.min(scale, 1.3)), colW - 20);
      layers.push({ input: num.data, left: startOf(num, left, colW - 20), top });
      layers.push({ input: lab.data, left: startOf(lab, left, colW - 20), top: top + num.info.height + 10 });
    }
    y += Math.ceil(Math.min(stats.length, 6) / 2) * rowH;
    const song = s.songs?.[0];
    if (song && y < H - 200) {
      const line = await text(
        `<span foreground="#FFFFFFCC">${escapeMarkup(
          song.artist ? t('wrap.card.songBy', locale, { title: song.title, artist: song.artist }) : t('wrap.card.song', locale, { title: song.title }),
        )}</span>`,
        false,
        30,
      );
      layers.push({ input: line.data, left: startOf(line), top: Math.max(y + 10, H - 150 - line.info.height) });
    }
  } catch {
    /* numbers without text rendering are left out */
  }
  const bg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0E1020"/><stop offset=".65" stop-color="#3A1030"/><stop offset="1" stop-color="#7A1830"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${W - 120}" cy="120" r="220" fill="#FF5C4A" opacity=".18"/><circle cx="120" cy="${H - 80}" r="260" fill="#FFB020" opacity=".10"/></svg>`,
  );
  return sharp(bg).composite(layers).png({ compressionLevel: 8 }).toBuffer();
}
