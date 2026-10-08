import type { Pool, PoolClient } from 'pg';
import {
  ASK_FEED_EVERY,
  ASK_NOTIFY_PER_DAY,
  ASK_OPEN_DAYS,
  ASK_PER_DAY,
  ASK_TOPICS,
  askAreaLabel,
  askAreaPoint,
  cityKey,
  type AskAreaInput,
  type AskExpiry,
  type AskHelperSettings,
  type AskTopic,
  type LocalHelper,
  type MapBox,
  type MapItem,
  type Post,
} from '@yapilapi/shared';
import type { AppContext } from './context.ts';
import { AppError, badRequest, forbidden, notFound } from './errors.ts';
import { activeControls } from './family.ts';
import { inQuietHours } from './interactions.ts';
import { enqueue } from './jobs.ts';
import type { FeedReason } from './posts.ts';
import { isEnabled, notify } from './services.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { notBlockedSql, postVisibleSql } from './visibility.ts';
import { yapDistributableSql } from './voice.ts';
import { commentVisibleSql } from './comments.ts';

type Q = Pool | PoolClient;
type Deps = Pick<AppContext, 'db' | 'realtime'>;

/**
 * Ask the city (docs/product/ask-the-city.md): questions to people nearby, answered by voice or
 * text. A question is a post shared with everyone (a Yap or a text post) with a row in
 * ask_city_questions: its topic, its area (a city, and a place page or the middle of the part of
 * the map it was asked from, on a 2 km grid; never where the asker is) and when it closes.
 * Answers are its comments, so they're moderated, reported, blocked and translated like any.
 *
 * Who finds a question (in Ask the city, on the map, in For you and through notifications) goes
 * through postVisibleSql, and beyond its author only once it's cleared by moderation and, when
 * spoken, its words passed (askListedSql). Notifications and feed slots go only to people of the
 * same age group as the asker (adults and people under 18 never reach each other this way, unless
 * family-linked), never to people blocked either way, at most ASK_NOTIFY_PER_DAY a day, and never
 * during quiet hours.
 */

export const ASK_NOTIFY_JOB = 'ask.city.notify';

/** Questions aliased `aq` that are still open: before their end, or under ASK_OPEN_DAYS old without one. */
export const askOpenSql = (aq = 'aq') =>
  `(CASE WHEN ${aq}.expires_at IS NULL THEN ${aq}.created_at > now() - make_interval(days => ${ASK_OPEN_DAYS}) ELSE ${aq}.expires_at > now() END)`;

/**
 * Question posts `p` (with `ap`, `au`) viewer `v` may find in Ask the city, on the map and in their
 * feed: visible to them and, unless they asked it, cleared by moderation with words that passed
 * (or none to check).
 */
export function askListedSql(v: string): string {
  return `(${postVisibleSql(v)} AND (p.author_id IS NOT DISTINCT FROM ${v} OR (p.moderation_status = 'normal' AND ${yapDistributableSql('p')})))`;
}

/** Whether `a` and `b` are both under 18 or both adults (unknown ages count as adults), or family-linked. */
const sameAgeSql = (a: string, b: string) => {
  const minor = (x: string) => `coalesce((SELECT ux.birth_date > current_date - interval '18 years' FROM users ux WHERE ux.id = ${x}), false)`;
  return `(${minor(a)} = ${minor(b)} OR EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
            AND ((fl.guardian_id = ${a} AND fl.teen_id = ${b}) OR (fl.guardian_id = ${b} AND fl.teen_id = ${a}))))`;
};

const QUESTION_FROM = `FROM ask_city_questions aq JOIN posts p ON p.id = aq.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

// ─── Asking ─────────────────────────────────────────────────────────────

/** At most ASK_PER_DAY questions a day each. */
export async function assertAskPace(db: Q, userId: string): Promise<void> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ask_city_questions WHERE author_id = $1 AND created_at > now() - interval '1 day'`,
    [userId],
  );
  if ((rows[0]?.n ?? 0) >= ASK_PER_DAY) throw new AppError(429, 'slow_down', 'You’ve asked a lot of questions today. Try again tomorrow.');
}

/**
 * Questions that ask where someone lives: Ask the city is for places and things, never for finding
 * a person. A small first line of defence; reports and moderation do the rest.
 */
const ABOUT_SOMEONE = [
  /\b(home|house|exact)\s+address\s+(of|for)\b/i,
  /\bwhere\s+(does|do|did)\s+(?!(?:the|a|an|this|that)\b)\S+(?:\s+\S+)?\s+(live|stay|sleep)\b/i,
  /\bwho\s+knows\s+where\s+\S+(?:\s+\S+)?\s+(lives|stays|sleeps)\b/i,
];
export function asksAboutSomeone(text: string): boolean {
  return ABOUT_SOMEONE.some((r) => r.test(text));
}

export interface AskArea {
  city: string;
  area: string | null;
  placeId: string | null;
  lat: number | null;
  lng: number | null;
}

/** The middle of the place pages in a city, or null when it has none. */
async function cityPoint(db: Q, city: string): Promise<{ lat: number; lng: number } | null> {
  const { rows } = await db.query<{ lat: number | null; lng: number | null }>(
    `SELECT avg(lat) AS lat, avg(lng) AS lng FROM places WHERE deleted_at IS NULL AND lat IS NOT NULL AND lower(city) = $1`,
    [cityKey(city)],
  );
  const r = rows[0];
  return r?.lat == null || r.lng == null ? null : { lat: Number(r.lat), lng: Number(r.lng) };
}

/** The city most place pages in a box are in, or null. */
async function cityInBox(db: Q, b: MapBox): Promise<string | null> {
  const { rows } = await db.query<{ city: string }>(
    `SELECT min(city) AS city FROM places
     WHERE deleted_at IS NULL AND city IS NOT NULL AND btrim(city) <> '' AND lat BETWEEN $1 AND $3 AND lng BETWEEN $2 AND $4
     GROUP BY lower(btrim(city)) ORDER BY count(*) DESC LIMIT 1`,
    [b.south, b.west, b.north, b.east],
  );
  return rows[0]?.city?.trim() || null;
}

/** The city questions are about for this person: the one they help in, or their profile's. */
export async function homeCity(db: Q, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ city: string | null }>(
    `SELECT coalesce((SELECT city FROM ask_city_helpers WHERE user_id = $1), nullif(btrim(pr.city), '')) AS city FROM profiles pr WHERE pr.user_id = $1`,
    [userId],
  );
  return rows[0]?.city ?? null;
}

/**
 * Where a question is about. A place page: its name, city and point (public already). A city, with
 * the part of the map on screen: its middle on the ASK_AREA_METRES grid. A box alone: the city
 * most place pages there are in. Nothing usable: the asker's profile city.
 */
export async function resolveArea(db: Q, userId: string, a: AskAreaInput): Promise<AskArea> {
  if (a.placeId) {
    const { rows } = await db.query<{ name: string; city: string | null; lat: number | null; lng: number | null }>(
      `SELECT name, city, lat, lng FROM places WHERE id = $1 AND deleted_at IS NULL`,
      [a.placeId],
    );
    const pl = rows[0];
    if (!pl) throw notFound('Place');
    const city = (a.city ?? pl.city ?? pl.name).trim().slice(0, 60);
    return { city, area: pl.name.trim().slice(0, 120), placeId: a.placeId, lat: pl.lat, lng: pl.lng };
  }
  const city = a.city?.trim() || (a.box ? await cityInBox(db, a.box) : null) || (await homeCity(db, userId));
  if (!city) throw badRequest('Choose a place or a city for your question.');
  const point = a.box ? askAreaPoint(a.box) : await cityPoint(db, city);
  return { city: city.slice(0, 60), area: null, placeId: null, lat: point?.lat ?? null, lng: point?.lng ?? null };
}

/** When a question closes: in an hour, at the end of the asker's day (tomorrow's when that's under an hour away), or in a week. */
export async function expiryOf(db: Q, expires: AskExpiry | null, tz: string): Promise<Date | null> {
  if (!expires) return null;
  const { rows } = await db.query<{ at: Date }>(
    expires === 'today'
      ? `SELECT CASE WHEN m - now() < interval '1 hour' THEN m + interval '1 day' ELSE m END AS at
         FROM (SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1 AS m) d`
      : `SELECT now() + $1::interval AS at`,
    [expires === 'today' ? tz : expires === '1h' ? '1 hour' : '7 days'],
  );
  return rows[0]!.at;
}

/** Keep a question's row (inside the transaction that writes its post). */
export async function writeQuestion(c: Q, postId: string, authorId: string, topic: AskTopic, area: AskArea, expiresAt: Date | null): Promise<void> {
  await c.query(
    `INSERT INTO ask_city_questions (post_id, author_id, topic, city, city_key, area, place_id, lat, lng, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [postId, authorId, topic, area.city, cityKey(area.city), area.area, area.placeId, area.lat, area.lng, expiresAt],
  );
}

// ─── Reading ────────────────────────────────────────────────────────────

/** Give question posts their `askCity`: topic, area, end, answers and helpful answers. */
export async function attachAskCity(db: Q, posts: Post[]): Promise<void> {
  if (!posts.length) return;
  const { rows } = await db.query(
    `SELECT aq.post_id, aq.topic, aq.city, aq.area, aq.place_id, aq.expires_at, ${askOpenSql()} AS open,
            (SELECT count(*) FROM ask_city_helpful h JOIN comments cm ON cm.id = h.comment_id
             WHERE h.post_id = aq.post_id AND cm.deleted_at IS NULL AND cm.hidden_at IS NULL AND cm.moderation_status IN ('normal', 'review'))::int AS helpful
     FROM ask_city_questions aq WHERE aq.post_id = ANY($1::uuid[])`,
    [posts.map((p) => p.id)],
  );
  const byId = new Map(rows.map((r) => [r.post_id as string, r]));
  for (const p of posts) {
    const r = byId.get(p.id);
    if (!r) continue;
    p.askCity = {
      topic: r.topic,
      city: r.city,
      area: r.area,
      placeId: r.place_id,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      open: !!r.open,
      answers: p.counts?.comments ?? 0,
      helpful: r.helpful,
    };
  }
}

export interface AskListQuery {
  viewer: string;
  city: string | null;
  box: MapBox | null;
  topic: AskTopic | undefined;
  offset: number;
  limit: number;
}

/**
 * Open questions in a city, or with their area in a box: those still waiting for an answer first,
 * then the newest. Ids, one more than asked for (to tell whether there's a next page).
 */
export async function listQuestions(db: Q, q: AskListQuery): Promise<string[]> {
  const params: unknown[] = [q.viewer, q.limit + 1, q.offset];
  const where: string[] = [askOpenSql(), askListedSql('$1')];
  if (q.box) {
    params.push(q.box.south, q.box.west, q.box.north, q.box.east);
    where.push(`aq.lat BETWEEN $4 AND $6 AND aq.lng BETWEEN $5 AND $7`);
  } else {
    params.push(cityKey(q.city ?? ''));
    where.push(`aq.city_key = $${params.length}`);
  }
  if (q.topic) {
    params.push(q.topic);
    where.push(`aq.topic = $${params.length}`);
  }
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id ${QUESTION_FROM} WHERE ${where.join(' AND ')}
     ORDER BY (p.comment_count = 0) DESC, p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
    params,
  );
  return rows.map((r) => r.id);
}

/** Your own questions, open or not, newest first. */
export async function myQuestions(db: Q, userId: string, offset: number, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id ${QUESTION_FROM} WHERE aq.author_id = $1 AND p.deleted_at IS NULL AND p.status = 'published'
     ORDER BY p.created_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
    [userId, limit + 1, offset],
  );
  return rows.map((r) => r.id);
}

/**
 * Now and then in For you and the Yaps filter, a question in your city: one slot before every
 * ASK_FEED_EVERY - 1 ranked posts (counted over the whole feed, so paging adds no more), each the
 * next open question you haven't answered. In the Yaps filter, spoken questions only.
 */
export async function mixInQuestions<T extends { id: string; reason: FeedReason }>(
  db: Q,
  viewer: string,
  surface: 'for_you' | 'yaps',
  offset: number,
  items: T[],
  personal: string,
): Promise<(T | { id: string; reason: FeedReason })[]> {
  const every = ASK_FEED_EVERY - 1;
  const slots = items.map((_, i) => offset + i).filter((g) => g > 0 && g % every === 0);
  if (!slots.length || !(await isEnabled(db, 'ASK_CITY'))) return items;
  const city = await homeCity(db, viewer);
  if (!city) return items;
  const last = slots.at(-1)! / every;
  const { rows } = await db.query<{ id: string }>(
    `SELECT p.id ${QUESTION_FROM}
     WHERE aq.city_key = $2 AND ${askOpenSql()} AND p.author_id <> $1 AND ${askListedSql('$1')} ${personal}
       ${surface === 'yaps' ? `AND p.format = 'yap'` : ''}
       AND ${sameAgeSql('p.author_id', '$1')}
       AND NOT EXISTS (SELECT 1 FROM comments cm WHERE cm.post_id = p.id AND cm.author_id = $1 AND cm.deleted_at IS NULL)
     ORDER BY (p.comment_count = 0) DESC, p.created_at DESC, p.id DESC LIMIT $3`,
    [viewer, cityKey(city), last + items.length],
  );
  const shown = new Set(items.map((x) => x.id));
  const picks = rows.map((r) => r.id).filter((id) => !shown.has(id));
  const out: (T | { id: string; reason: FeedReason })[] = [];
  items.forEach((item, i) => {
    const g = offset + i;
    const pick = g > 0 && g % every === 0 ? picks[g / every - 1] : undefined;
    if (pick) out.push({ id: pick, reason: { code: 'ask_city' } });
    out.push(item);
  });
  return out;
}

// ─── Helpful answers ────────────────────────────────────────────────────

/** A question and its asker, while the post is up. */
async function questionOf(db: Q, postId: string) {
  const { rows } = await db.query<{ author_id: string; city: string; city_key: string }>(
    `SELECT aq.author_id, aq.city, aq.city_key FROM ask_city_questions aq JOIN posts p ON p.id = aq.post_id
     WHERE aq.post_id = $1 AND p.deleted_at IS NULL AND p.status = 'published'`,
    [postId],
  );
  if (!rows[0]) throw notFound('That post');
  return rows[0];
}

/** The asker marks an answer helpful: it comes first, and its writer hears and counts the person they helped. */
export async function markHelpful(deps: Deps, askerId: string, postId: string, commentId: string): Promise<void> {
  const q = await questionOf(deps.db, postId);
  if (q.author_id !== askerId) throw forbidden('Only the person who asked can mark answers as helpful.');
  const { rows } = await deps.db.query<{ author_id: string }>(
    `SELECT cm.author_id FROM comments cm JOIN posts p ON p.id = cm.post_id
     WHERE cm.id = $2 AND cm.post_id = $3 AND cm.hidden_at IS NULL AND cm.moderation_status IN ('normal', 'review') AND ${commentVisibleSql('$1')}`,
    [askerId, commentId, postId],
  );
  const answer = rows[0];
  if (!answer) throw notFound('That comment');
  if (answer.author_id === askerId) throw badRequest('Mark answers from other people as helpful.');
  const made = await deps.db.query(
    `INSERT INTO ask_city_helpful (comment_id, post_id, helper_id, asker_id, city, city_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (comment_id) DO NOTHING`,
    [commentId, postId, answer.author_id, askerId, q.city, q.city_key],
  );
  if (made.rowCount)
    await notify(deps.db, deps.realtime, {
      userId: answer.author_id,
      category: 'creators',
      type: 'ask_helpful',
      actorId: askerId,
      entityType: 'post',
      entityId: postId,
      data: { commentId },
    });
}

export async function unmarkHelpful(db: Q, askerId: string, postId: string, commentId: string): Promise<void> {
  const q = await questionOf(db, postId);
  if (q.author_id !== askerId) throw forbidden('Only the person who asked can mark answers as helpful.');
  await db.query(`DELETE FROM ask_city_helpful WHERE comment_id = $1 AND post_id = $2`, [commentId, postId]);
}

/**
 * "Helped 12 people in Lagos": the city where the most different people marked one of this
 * person's answers helpful (answers still up, from accounts still active), or null.
 */
export async function localHelperOf(db: Q, userId: string): Promise<LocalHelper | null> {
  const { rows } = await db.query<{ city: string; people: number }>(
    `SELECT min(h.city) AS city, count(DISTINCT h.asker_id)::int AS people
     FROM ask_city_helpful h JOIN comments cm ON cm.id = h.comment_id JOIN users ku ON ku.id = h.asker_id
     WHERE h.helper_id = $1 AND cm.deleted_at IS NULL AND ku.status = 'active'
     GROUP BY h.city_key ORDER BY count(DISTINCT h.asker_id) DESC, max(h.created_at) DESC LIMIT 1`,
    [userId],
  );
  return rows[0] ? { people: rows[0].people, city: rows[0].city } : null;
}

// ─── Help answer questions near me ──────────────────────────────────────

export async function helperSettings(db: Q, userId: string): Promise<AskHelperSettings> {
  const { rows } = await db.query<{ city: string | null; topics: AskTopic[] | null; on: boolean }>(
    `SELECT coalesce(h.city, nullif(btrim(pr.city), '')) AS city, h.topics, h.user_id IS NOT NULL AS on
     FROM profiles pr LEFT JOIN ask_city_helpers h ON h.user_id = pr.user_id WHERE pr.user_id = $1`,
    [userId],
  );
  const r = rows[0];
  return { on: !!r?.on, city: r?.city ?? null, topics: r?.topics ?? [...ASK_TOPICS] };
}

/** Turn it on (for the city given, the one chosen before, or the profile's) or off (the row goes). */
export async function setHelperSettings(db: Q, userId: string, s: { on: boolean; city?: string | null; topics?: AskTopic[] }): Promise<AskHelperSettings> {
  if (!s.on) {
    await db.query(`DELETE FROM ask_city_helpers WHERE user_id = $1`, [userId]);
    return helperSettings(db, userId);
  }
  const now = await helperSettings(db, userId);
  const city = (s.city === undefined ? now.city : s.city)?.trim() || null;
  if (!city) throw badRequest('Choose a city.');
  const topics = [...new Set(s.topics ?? now.topics)];
  await db.query(
    `INSERT INTO ask_city_helpers (user_id, city, city_key, topics) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET city = EXCLUDED.city, city_key = EXCLUDED.city_key, topics = EXCLUDED.topics, updated_at = now()`,
    [userId, city, cityKey(city), topics],
  );
  return helperSettings(db, userId);
}

// ─── Telling people nearby ──────────────────────────────────────────────

/** A spoken question whose words aren't back yet is looked at again this often, this many times. */
const WAIT_SECONDS = 30;
const WAIT_TRIES = 20;
/** At most this many people are told about one question. */
const NOTIFY_MAX = 500;

/**
 * Tell people who help answer in the question's city and topic: once it's cleared (a spoken one
 * once its words passed), while it's open, never the asker or anyone blocked either way, only
 * people who may see it and are of the asker's age group (or family-linked), at most
 * ASK_NOTIFY_PER_DAY a day each, nobody twice, and nobody in quiet hours (theirs or a guardian's).
 */
export async function notifyNearby(deps: Deps, postId: string, tries = 0): Promise<number> {
  const { db } = deps;
  const { rows } = await db.query(
    `SELECT aq.topic, aq.city, aq.city_key, aq.area, p.author_id, ${askOpenSql()} AS open,
            (p.deleted_at IS NULL AND p.status = 'published' AND p.moderation_status = 'normal') AS up,
            ${yapDistributableSql('p')} AS words_ok,
            EXISTS (SELECT 1 FROM post_media vpm JOIN voice_clips vvc ON vvc.media_id = vpm.media_id
                    WHERE vpm.post_id = p.id AND vvc.transcript_status = 'pending') AS waiting
     FROM ask_city_questions aq JOIN posts p ON p.id = aq.post_id WHERE aq.post_id = $1`,
    [postId],
  );
  const q = rows[0];
  if (!q || !q.up || !q.open || !(await isEnabled(db, 'ASK_CITY'))) return 0;
  if (!q.words_ok) {
    if (q.waiting && tries < WAIT_TRIES) await enqueue(db, ASK_NOTIFY_JOB, { postId, tries: tries + 1 }, WAIT_SECONDS);
    return 0;
  }
  const { rows: people } = await db.query<{ user_id: string }>(
    `SELECT h.user_id FROM ask_city_helpers h JOIN users hu ON hu.id = h.user_id
     JOIN posts p ON p.id = $1 JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE h.city_key = $2 AND $3 = ANY(h.topics) AND h.user_id <> p.author_id AND hu.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM ask_city_notified n WHERE n.post_id = $1 AND n.user_id = h.user_id)
       AND (SELECT count(*) FROM ask_city_notified n WHERE n.user_id = h.user_id AND n.created_at > now() - interval '1 day') < $4
       AND ${notBlockedSql('p.author_id', 'h.user_id')}
       AND ${sameAgeSql('p.author_id', 'h.user_id')}
       AND ${postVisibleSql('h.user_id')}
     ORDER BY h.updated_at DESC LIMIT $5`,
    [postId, q.city_key, q.topic, ASK_NOTIFY_PER_DAY, NOTIFY_MAX],
  );
  let told = 0;
  for (const { user_id } of people) {
    if ((await activeControls(db, user_id))?.quietNow || (await inQuietHours(db, user_id))) continue;
    const kept = await db.query(
      `INSERT INTO ask_city_notified (post_id, user_id)
       SELECT $1, $2 WHERE (SELECT count(*) FROM ask_city_notified WHERE user_id = $2 AND created_at > now() - interval '1 day') < $3
       ON CONFLICT DO NOTHING`,
      [postId, user_id, ASK_NOTIFY_PER_DAY],
    );
    if (!kept.rowCount) continue;
    await notify(db, deps.realtime, {
      userId: user_id,
      category: 'communities',
      type: 'ask_nearby',
      actorId: q.author_id,
      entityType: 'post',
      entityId: postId,
      data: { topic: q.topic, area: askAreaLabel(q) },
    });
    told++;
  }
  return told;
}

// ─── The map's Questions layer ──────────────────────────────────────────

/** Candidates for the map (the same for everyone): open, cleared questions with a point in the box ($1..$4), newest first. */
export const ASK_MAP_CANDIDATES = `SELECT aq.post_id AS id, aq.lat, aq.lng FROM ask_city_questions aq JOIN posts p ON p.id = aq.post_id
  WHERE aq.lat IS NOT NULL AND aq.lat BETWEEN $1 AND $3 AND aq.lng BETWEEN $2 AND $4 AND ${askOpenSql()}
    AND p.deleted_at IS NULL AND p.status = 'published' AND p.moderation_status = 'normal'
  ORDER BY aq.created_at DESC LIMIT $5`;

/** The questions among `ids` this viewer may find, as map items: the question's words, its area, the asker and answers so far. */
export async function questionMapItems(db: Q, viewer: string | null, ids: string[]): Promise<MapItem[]> {
  const { rows } = await db.query(
    `SELECT p.id, p.body, aq.topic, aq.city, aq.area, aq.place_id, aq.lat, aq.lng, aq.created_at, aq.expires_at, p.comment_count,
            (SELECT vc.transcript FROM post_media pm JOIN voice_clips vc ON vc.media_id = pm.media_id
             WHERE pm.post_id = p.id AND vc.transcript_status = 'ready' AND vc.screened = 'passed' LIMIT 1) AS transcript,
            ap.user_id AS u_id, ap.username AS u_username, ap.display_name AS u_display_name, ap.avatar_url AS u_avatar_url, ap.mode AS u_mode, ${plusCol('u_', 'ap')}
     ${QUESTION_FROM} WHERE aq.post_id = ANY($2::uuid[]) AND ${askOpenSql()} AND ${askListedSql('$1')}
     ORDER BY aq.created_at DESC`,
    [viewer, ids],
  );
  return rows.map((r) => {
    const words = String(r.body || r.transcript || '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      key: `questions:${r.id}`,
      layer: 'questions',
      title: [...words].length > 120 ? `${[...words].slice(0, 119).join('').trimEnd()}…` : words,
      subtitle: askAreaLabel(r),
      point: { lat: r.lat, lng: r.lng },
      approximate: !r.place_id,
      at: new Date(r.created_at).toISOString(),
      endsAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      thumbUrl: r.u_avatar_url ?? null,
      count: r.comment_count,
      user: publicUserFrom(r, 'u_'),
      target: { kind: 'post', id: r.id },
    } satisfies MapItem;
  });
}
