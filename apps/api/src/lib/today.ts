import type { Pool, PoolClient } from 'pg';
import {
  baseLanguage,
  languageName,
  TODAY_DEFAULT_HOUR,
  TODAY_MAX_SEGMENTS,
  TODAY_MAX_WORDS,
  type TodayBriefing,
  type TodaySegment,
  type TodaySettings,
  type TodaySource,
} from '@yapilapi/shared';
import type { Config } from '../config.ts';
import { logAiCall } from './ai/assists.ts';
import type { AiProvider } from './ai/providers.ts';
import { analyzeText } from './moderation.ts';
import type { RealtimeHub } from './realtime.ts';
import { isEnabled, notify } from './services.ts';
import { speak, type SpeechProvider, type SpeechSource } from './speech.ts';
import type { MediaStorage } from './storage.ts';
import { postUnlockedSql, postVisibleSql, PUBLIC_POST_SQL } from './visibility.ts';
import { TIMEZONE_SQL } from './wrap.ts';

type Q = Pool | PoolClient;

/**
 * Yapilapi Today (docs/product/yapilapi-today.md): every morning, a short briefing of what your
 * people and your city are talking about, written by a model from the day's top posts and Yaps
 * you can see, and read aloud in your language.
 *
 * The rules, in the AI gateway's order: only what the person can see right now goes in (the
 * feeds' visibility SQL, plus: nothing held, flagged, sensitive or reported, nothing from people
 * they muted or said they're not interested in, nothing from under-18s to adults); the model only
 * rewrites what the posts say and cites them by number (a segment can't point anywhere else); its
 * text goes through the safety check; every call is in the AI audit log, never the content. When
 * served, a segment shows only while the reader can still see every post it cites.
 *
 * The city part is shared: made once per city, local day and language from public posts by
 * adults, and filtered per reader. The people part (follows, friends, squads) is the person's own.
 */

export interface TodayDeps {
  db: Pool;
  storage: MediaStorage;
  speech: SpeechProvider | null;
  realtime: RealtimeHub;
  provider: AiProvider;
  config: Pick<Config, 'APP_ENV' | 'TTS_DAILY_CHAR_LIMIT' | 'TTS_PER_HOUR' | 'TODAY_DAILY_LIMIT' | 'TODAY_TTS_DAILY_CHAR_LIMIT'>;
}

/** What goes in: posts and Yaps of the last day. */
const WINDOW_HOURS = 24;
/** At most this many of each kind are given to the model, the best first. */
const PEOPLE_ITEMS = 20;
const CITY_ITEMS = 15;
/** The people part says at most this much, the city part the rest. */
const PEOPLE_SEGMENTS = 4;
const CITY_SEGMENTS = TODAY_MAX_SEGMENTS - PEOPLE_SEGMENTS;
const PEOPLE_WORDS = 180;
const CITY_WORDS = TODAY_MAX_WORDS - PEOPLE_WORDS;
/** "Not interested in this" keeps those people out of your Todays this long. */
const FEEDBACK_DAYS = 30;
/** Briefings and city parts are kept this long, then deleted with their spoken clips. */
const KEEP_DAYS = 7;

/** A post the same for everyone, as the ranking sees it: likes, comments, finished listens. */
const SCORE_SQL = `(p.like_count + 2 * p.comment_count + 3 * coalesce((SELECT ps.listen_completes FROM post_stats ps WHERE ps.post_id = p.id), 0))`;

const minorSql = (birth: string) => `coalesce(${birth} > current_date - interval '18 years', false)`;
const adultSql = (birth: string) => `coalesce(${birth} <= current_date - interval '18 years', false)`;

/**
 * Posts aliased `p` (author profile `ap`, user `au`) that may be in a Today at all: not held for
 * review or restricted, no media marked sensitive or blocked, no open report, a Yap's words not held.
 */
const SAFE_POST_SQL = `(p.moderation_status = 'normal'
  AND NOT EXISTS (SELECT 1 FROM post_media spm JOIN media sm ON sm.id = spm.media_id WHERE spm.post_id = p.id AND sm.moderation IN ('sensitive', 'blocked'))
  AND NOT EXISTS (SELECT 1 FROM post_media vpm JOIN voice_clips vvc ON vvc.media_id = vpm.media_id WHERE vpm.post_id = p.id AND vvc.screened = 'held')
  AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.target_type = 'post' AND r.target_id = p.id AND r.status <> 'closed'))`;

/**
 * Posts aliased `p` that viewer `v` may hear about in their Today: what they can see and open,
 * safe (above), not from someone they muted or said they're not interested in (in the feed or in
 * Today), and nothing by someone under 18 for an adult. `feedback: false` (a briefing already
 * made): "Not interested in this" only takes away the segment it was said to, not the rest.
 */
function todayVisibleSql(v: string, { feedback = true }: { feedback?: boolean } = {}): string {
  return `(${postVisibleSql(v)} AND ${postUnlockedSql(v)} AND ${SAFE_POST_SQL} AND p.author_id <> ${v}
    AND NOT EXISTS (SELECT 1 FROM mutes mu WHERE mu.muter_id = ${v} AND mu.muted_id = p.author_id)
    AND NOT EXISTS (SELECT 1 FROM feed_feedback ff WHERE ff.user_id = ${v} AND (
          (ff.signal = 'not_interested' AND ff.post_id = p.id) OR (ff.signal = 'mute_creator' AND ff.author_id = p.author_id)))
    ${
      feedback
        ? `AND NOT EXISTS (SELECT 1 FROM today_feedback tf WHERE tf.user_id = ${v} AND tf.created_at > now() - interval '${FEEDBACK_DAYS} days'
          AND (tf.author_id = p.author_id OR tf.post_id = p.id))`
        : ''
    }
    AND (${minorSql(`(SELECT uv.birth_date FROM users uv WHERE uv.id = ${v})`)} OR NOT ${minorSql('au.birth_date')}))`;
}

/** The words of a post: its text and, for a Yap, its transcript (once ready and not held). */
const ITEM_COLS = `p.id, p.author_id, ap.username, ap.display_name AS name, p.body, p.format, p.like_count, p.comment_count,
  (SELECT vcl.transcript FROM post_media pm JOIN voice_clips vcl ON vcl.media_id = pm.media_id
   WHERE pm.post_id = p.id AND vcl.transcript_status = 'ready' AND vcl.screened IS DISTINCT FROM 'held' LIMIT 1) AS transcript`;

interface Item {
  id: string;
  author_id: string;
  username: string;
  name: string;
  body: string;
  format: string;
  like_count: number;
  comment_count: number;
  transcript: string | null;
  friend?: boolean;
  squad?: boolean;
}

/** A segment as stored: the posts it cites by id. */
interface Stored {
  kind: 'people' | 'city';
  text: string;
  sources: string[];
  audioUrl: string | null;
}

const words = (it: Item) => [it.body.trim(), it.transcript?.trim() ?? ''].filter(Boolean).join(' — ');
const safe = (s: string) => {
  const r = analyzeText(s).risk;
  return r !== 'escalate' && r !== 'restrict';
};
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** JSON from a model reply: structured output is plain JSON, but tolerate a fenced block. */
function parseJson(text: string): any {
  try {
    return JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
  } catch {
    return null;
  }
}

// ─── Settings and availability ───────────────────────────────────────────

/** Today works here: the TODAY flag, and a real model (the offline stand-in only outside production). */
export async function todayAvailable(deps: Pick<TodayDeps, 'db' | 'provider' | 'config'>): Promise<boolean> {
  if (deps.provider.name === 'dev' && deps.config.APP_ENV === 'production') return false;
  return isEnabled(deps.db, 'TODAY');
}

export async function todaySettings(db: Q, userId: string): Promise<TodaySettings> {
  const { rows } = await db.query(
    `SELECT coalesce(up.today, true) AS enabled, coalesce(up.today_hour, ${TODAY_DEFAULT_HOUR}) AS hour, coalesce(up.today_city, true) AS city,
            coalesce(up.today_notify, false) AS notify, ${TIMEZONE_SQL('up')} AS timezone
     FROM (SELECT $1::uuid AS id) u LEFT JOIN user_preferences up ON up.user_id = u.id`,
    [userId],
  );
  const r = rows[0];
  return { enabled: r.enabled, hour: Number(r.hour), city: r.city, notify: r.notify, timezone: r.timezone };
}

// ─── Budgets ──────────────────────────────────────────────────────────────

/** Take one new script from today's (UTC) budget for everyone: false once TODAY_DAILY_LIMIT is reached. */
async function takeCall(db: Q, limit: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO today_budget AS b (day, calls) VALUES ((now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (day) DO UPDATE SET calls = b.calls + 1 WHERE b.calls + 1 <= $1`,
    [limit],
  );
  return limit > 0 && !!rowCount;
}

/** Take `chars` of today's reading-aloud budget for Today, all or none. */
async function takeChars(db: Q, chars: number, limit: number): Promise<boolean> {
  if (chars > limit) return false;
  const { rowCount } = await db.query(
    `INSERT INTO today_budget AS b (day, chars) VALUES ((now() AT TIME ZONE 'utc')::date, $1)
     ON CONFLICT (day) DO UPDATE SET chars = b.chars + $1 WHERE b.chars + $1 <= $2`,
    [chars, limit],
  );
  return !!rowCount;
}

/**
 * A segment read aloud (lib/speech.ts), for `source`; null without a provider, past either
 * budget or when the service fails: the segment is then text, with the original Yaps to hear.
 * `fresh`: a new text, counted against Today's budget (a city segment copied into a briefing
 * was counted when the city part was made).
 */
async function voiceOf(deps: TodayDeps, text: string, lang: string, source: SpeechSource, fresh: boolean): Promise<string | null> {
  if (!deps.speech) return null;
  if (fresh && !(await takeChars(deps.db, text.length, deps.config.TODAY_TTS_DAILY_CHAR_LIMIT))) return null;
  try {
    return (await speak({ db: deps.db, storage: deps.storage, speech: deps.speech, config: deps.config }, { text, lang, source })).url;
  } catch {
    return null;
  }
}

// ─── Writing ─────────────────────────────────────────────────────────────

/**
 * The model's segments for these items, in `lang`: each one or a few sentences citing the items
 * it is about. Null when the model declined or answered something unusable. The offline stand-in
 * (development only) says the first words of the top items instead.
 */
async function write(
  deps: TodayDeps,
  items: Item[],
  part: 'people' | 'city',
  lang: string,
  log: { userId: string; scopes: string[] },
): Promise<{ text: string; sources: string[] }[] | null> {
  const max = part === 'people' ? PEOPLE_SEGMENTS : CITY_SEGMENTS;
  const budget = part === 'people' ? PEOPLE_WORDS : CITY_WORDS;
  const started = Date.now();
  const p = deps.provider;
  const done = (status: 'ok' | 'error' | 'blocked' | 'denied') =>
    logAiCall(deps.db, { userId: log.userId, task: 'today', provider: p.name, model: p.model, scopes: log.scopes, status, started });
  if (!(await takeCall(deps.db, deps.config.TODAY_DAILY_LIMIT))) {
    await done('denied');
    return null;
  }
  let raw: { text: string; posts: number[] }[];
  if (p.name === 'dev') {
    raw = items.slice(0, max).map((it, i) => ({ text: `@${it.username}: ${firstWords(words(it))}`, posts: [i + 1] }));
  } else {
    let res;
    try {
      res = await p.complete({
        system: [
          `You write part of Yapilapi Today, a short spoken morning briefing on a social app about what ${part === 'people' ? "the listener's friends, the people they follow and their squads" : 'people in their city'} shared in the last day. It is read aloud.`,
          `Write in ${languageName(lang, 'en')}. Up to ${max} segments, each one to three short, plain sentences about one person or topic, under ${budget} words in all.`,
          'Only say what the posts say. Never invent or guess facts, feelings, relationships, ages, places or numbers that are not written. Name people only by their handle as given (@name).',
          'Be neutral and warm. No exaggeration, no pressure, no calls to action, no questions, no exclamation marks, no emoji.',
          'Leave out anything about health, death, violence, sex, money trouble, politics or anyone in a private difficulty.',
          'Each segment lists the numbers of the posts it is about. Put each post in one segment at most.',
        ].join(' '),
        prompt: items
          .map(
            (it, i) =>
              `[${i + 1}] @${it.username}${it.friend ? ' (friend)' : ''}${it.squad ? ' (squad)' : ''} · ${it.format === 'yap' ? 'Yap (voice post), transcript' : 'post'} · ${it.like_count} likes · ${it.comment_count} comments\n${words(it).slice(0, 600)}`,
          )
          .join('\n\n'),
        maxTokens: 1500,
        schema: {
          type: 'object',
          properties: {
            segments: {
              type: 'array',
              items: {
                type: 'object',
                properties: { text: { type: 'string' }, posts: { type: 'array', items: { type: 'integer' } } },
                required: ['text', 'posts'],
                additionalProperties: false,
              },
            },
          },
          required: ['segments'],
          additionalProperties: false,
        },
      });
    } catch {
      await done('error');
      return null;
    }
    const json = res.refused ? null : parseJson(res.text);
    if (!json || !Array.isArray(json.segments)) {
      await done(res.refused ? 'blocked' : 'error');
      return null;
    }
    raw = json.segments;
  }
  const out: { text: string; sources: string[] }[] = [];
  const used = new Set<number>();
  let total = 0;
  for (const s of raw) {
    const text = typeof s?.text === 'string' ? s.text.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    // Only items that were given to the model, each once, so a segment can't point anywhere else.
    const refs = [
      ...new Set(
        (Array.isArray(s?.posts) ? s.posts : []).filter(
          (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= items.length,
        ),
      ),
    ]
      .filter((n) => !used.has(n))
      .slice(0, 4);
    if (!text || !refs.length || !safe(text)) continue;
    const n = wordCount(text);
    if (total + n > budget + 20) break;
    total += n;
    refs.forEach((r) => used.add(r));
    out.push({ text, sources: refs.map((r) => items[r - 1]!.id) });
    if (out.length >= max) break;
  }
  await done('ok');
  return out;
}

const firstWords = (s: string, max = 140) => {
  const one =
    s
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.!?])\s/)[0] ?? '';
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

// ─── The two parts ───────────────────────────────────────────────────────

/** Your people's top posts and Yaps of the last day: follows, friends and your squads. */
async function peopleItems(db: Q, userId: string): Promise<Item[]> {
  const { rows } = await db.query<Item>(
    `SELECT ${ITEM_COLS},
            EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST($1::uuid, p.author_id) AND fr.user_b = GREATEST($1::uuid, p.author_id)) AS friend,
            (p.visibility = 'squad') AS squad
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.created_at > now() - make_interval(hours => ${WINDOW_HOURS}) AND p.community_id IS NULL
       AND (EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)
            OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST($1::uuid, p.author_id) AND fr.user_b = GREATEST($1::uuid, p.author_id))
            OR p.visibility = 'squad')
       AND ${todayVisibleSql('$1')}
     ORDER BY ${SCORE_SQL} + CASE WHEN p.visibility = 'squad' THEN 3 ELSE 0 END DESC, p.created_at DESC
     LIMIT ${PEOPLE_ITEMS * 2}`,
    [userId],
  );
  return rows.filter((r) => words(r)).slice(0, PEOPLE_ITEMS);
}

/**
 * The city's top public posts and Yaps of the last day, the same for everyone: tagged at a place
 * in the city or by someone who lives there, from adults with public accounts, safe, and not
 * withheld anywhere or echoing another post (each reader's own checks come when it's served).
 */
async function cityItems(db: Q, cityKey: string): Promise<Item[]> {
  const { rows } = await db.query<Item>(
    `SELECT ${ITEM_COLS}
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.created_at > now() - make_interval(hours => ${WINDOW_HOURS}) AND p.community_id IS NULL AND NOT p.is_echo
       AND ${PUBLIC_POST_SQL} AND ${SAFE_POST_SQL} AND ${adultSql('au.birth_date')}
       AND (lower(btrim(ap.city)) = $1 OR EXISTS (SELECT 1 FROM places pl WHERE pl.id = p.place_id AND pl.deleted_at IS NULL AND lower(btrim(pl.city)) = $1))
       AND NOT EXISTS (SELECT 1 FROM post_withholdings w WHERE w.post_id = p.id)
     ORDER BY ${SCORE_SQL} DESC, p.created_at DESC
     LIMIT ${CITY_ITEMS * 2}`,
    [cityKey],
  );
  return rows.filter((r) => words(r)).slice(0, CITY_ITEMS);
}

/** The city part for this city, local day and language: made once, then shared. */
async function cityPart(deps: TodayDeps, cityKey: string, day: string, lang: string, userId: string): Promise<Stored[]> {
  const found = await deps.db.query<{ segments: Stored[] }>(`SELECT segments FROM today_city_segments WHERE city_key = $1 AND day = $2 AND lang = $3`, [
    cityKey,
    day,
    lang,
  ]);
  if (found.rows[0]) {
    await logAiCall(deps.db, {
      userId,
      task: 'today',
      provider: deps.provider.name,
      model: deps.provider.model,
      scopes: ['today:city', 'cache'],
      status: 'ok',
      started: Date.now(),
    });
    return found.rows[0].segments;
  }
  const items = await cityItems(deps.db, cityKey);
  if (!items.length) return [];
  const made = await write(deps, items, 'city', lang, { userId, scopes: ['today:city', `posts:${items.length}`] });
  if (!made) return [];
  const ins = await deps.db.query<{ id: string }>(
    `INSERT INTO today_city_segments (city_key, day, lang, segments, provider, model) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (city_key, day, lang) DO NOTHING RETURNING id`,
    [cityKey, day, lang, JSON.stringify(made.map((s) => ({ kind: 'city', ...s, audioUrl: null }))), deps.provider.name, deps.provider.model],
  );
  const id = ins.rows[0]?.id;
  // Someone else's request made it at the same moment: theirs is the one everyone shares.
  if (!id)
    return (
      (await deps.db.query(`SELECT segments FROM today_city_segments WHERE city_key = $1 AND day = $2 AND lang = $3`, [cityKey, day, lang])).rows[0]
        ?.segments ?? []
    );
  const segments: Stored[] = await Promise.all(
    made.map(async (s) => ({ kind: 'city' as const, ...s, audioUrl: await voiceOf(deps, s.text, lang, { kind: 'today_city', id }, true) })),
  );
  if (segments.some((s) => s.audioUrl)) await deps.db.query(`UPDATE today_city_segments SET segments = $2 WHERE id = $1`, [id, JSON.stringify(segments)]);
  return segments;
}

// ─── Making a briefing ───────────────────────────────────────────────────

// Two requests for the same person's Today at the same moment share one.
const making = new Map<string, Promise<string | null>>();

/**
 * Make `userId`'s Today for their local `day`, once: the people part, then their city's (when
 * they want it, have a city on their profile and are an adult), each segment read aloud when
 * listening is set up. Nothing to say: an empty one is kept so it isn't tried again that day.
 * Past the day's budget for scripts: nothing, quietly. Returns the briefing's id.
 */
export async function makeToday(deps: TodayDeps, userId: string, day: string, tz: string): Promise<string | null> {
  const key = `${userId}:${day}`;
  const running = making.get(key);
  if (running) return running;
  const job = (async () => {
    const existing = await deps.db.query<{ id: string }>(`SELECT id FROM today_briefings WHERE user_id = $1 AND day = $2`, [userId, day]);
    if (existing.rows[0]) return existing.rows[0].id;
    const settings = await todaySettings(deps.db, userId);
    const who = (
      await deps.db.query<{ locale: string | null; city: string | null; adult: boolean }>(
        `SELECT pr.locale, pr.city, ${adultSql('u.birth_date')} AS adult FROM users u JOIN profiles pr ON pr.user_id = u.id WHERE u.id = $1`,
        [userId],
      )
    ).rows[0];
    if (!who) return null;
    const lang = baseLanguage(who.locale) || 'en';
    const cityKey = (who.city ?? '').trim().toLowerCase().slice(0, 60);

    const segments: Stored[] = [];
    const items = await peopleItems(deps.db, userId);
    if (items.length) {
      const made = await write(deps, items, 'people', lang, { userId, scopes: ['today:people', `posts:${items.length}`] });
      // Past the budget or the model failed: no Today rather than half of one.
      if (!made) return null;
      segments.push(...made.map((s) => ({ kind: 'people' as const, ...s, audioUrl: null })));
    }
    if (settings.city && who.adult && cityKey)
      segments.push(...(await cityPart(deps, cityKey, day, lang, userId)).map((s) => ({ ...s, audioUrl: s.audioUrl ?? null })));

    const ins = await deps.db.query<{ id: string }>(
      `INSERT INTO today_briefings (user_id, day, timezone, lang, segments, empty, provider, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, day) DO NOTHING RETURNING id`,
      [userId, day, tz, lang, JSON.stringify(segments.map((s) => ({ ...s, audioUrl: null }))), !segments.length, deps.provider.name, deps.provider.model],
    );
    const id = ins.rows[0]?.id;
    if (!id) return (await deps.db.query<{ id: string }>(`SELECT id FROM today_briefings WHERE user_id = $1 AND day = $2`, [userId, day])).rows[0]?.id ?? null;
    if (segments.length && deps.speech) {
      // The briefing's own use of each clip (a city clip is already made: that's free).
      const voiced = await Promise.all(
        segments.map(async (s) => ({
          ...s,
          audioUrl: s.kind === 'city' && !s.audioUrl ? null : await voiceOf(deps, s.text, lang, { kind: 'today', id }, s.kind === 'people'),
        })),
      );
      await deps.db.query(`UPDATE today_briefings SET segments = $2 WHERE id = $1`, [id, JSON.stringify(voiced)]);
    }
    return id;
  })().finally(() => making.delete(key));
  making.set(key, job);
  return job;
}

/** The person's local date and hour now (or at `now`), in their Today time zone. */
export async function localNow(db: Q, tz: string, now = new Date()): Promise<{ day: string; hour: number }> {
  const { rows } = await db.query<{ day: string; hour: number }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS day, extract(hour FROM $1::timestamptz AT TIME ZONE $2)::int AS hour`,
    [now, tz],
  );
  return rows[0]!;
}

// ─── Reading one ─────────────────────────────────────────────────────────

interface Row {
  id: string;
  user_id: string;
  day: string;
  lang: string;
  segments: Stored[];
  empty: boolean;
  hidden: number[];
  provider: string;
  dismissed_at: Date | null;
  notified_at: Date | null;
  created_at: Date;
}

const ROW_COLS = `id, user_id, to_char(day, 'YYYY-MM-DD') AS day, lang, segments, empty, hidden, provider, dismissed_at, notified_at, created_at`;

/**
 * A briefing as `viewer` may hear it now: the segments they didn't put away, and only those whose
 * every source they can still see (a post deleted, hidden or blocked since takes its segment with
 * it, since the words are about it). Each source with its author's handle and, for a Yap, its clip.
 */
async function present(db: Q, row: Row, viewer: string): Promise<TodayBriefing> {
  const ids = [...new Set(row.segments.flatMap((s) => s.sources))];
  const { rows } = ids.length
    ? await db.query<{ id: string; username: string; name: string; voice: TodaySource['voice'] }>(
        `SELECT p.id, ap.username, ap.display_name AS name,
                (SELECT json_build_object('id', m.id, 'url', m.url, 'durationMs', vc.duration_ms)
                 FROM post_media pm JOIN voice_clips vc ON vc.media_id = pm.media_id JOIN media m ON m.id = vc.media_id
                 WHERE pm.post_id = p.id AND p.format = 'yap' AND m.moderation NOT IN ('blocked', 'sensitive') LIMIT 1) AS voice
         FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
         WHERE p.id = ANY($2::uuid[]) AND ${todayVisibleSql('$1', { feedback: false })}`,
        [viewer, ids],
      )
    : { rows: [] };
  const seen = new Map(rows.map((r) => [r.id, r]));
  const segments: TodaySegment[] = [];
  row.segments.forEach((s, index) => {
    if (row.hidden.includes(index) || !s.sources.every((id) => seen.has(id))) return;
    segments.push({
      index,
      kind: s.kind,
      text: s.text,
      audioUrl: s.audioUrl ?? null,
      sources: s.sources.map((id) => {
        const r = seen.get(id)!;
        return { postId: id, username: r.username, displayName: r.name, voice: r.voice ?? null };
      }),
    });
  });
  return { id: row.id, day: row.day, lang: row.lang, segments, dev: row.provider === 'dev', createdAt: row.created_at.toISOString() };
}

/**
 * GET /v1/today: this morning's Today for `userId`, made now if their hour has come and it wasn't
 * made yet (people who weren't around this week aren't made one in advance). Null when it's off,
 * not their hour yet, put away, past the budget, or there's nothing they can hear.
 */
export async function todayFor(deps: TodayDeps, userId: string, now = new Date()): Promise<TodayBriefing | null> {
  const settings = await todaySettings(deps.db, userId);
  if (!settings.enabled) return null;
  const local = await localNow(deps.db, settings.timezone, now);
  let row = await briefingRow(deps.db, userId, { day: local.day });
  if (!row) {
    if (local.hour < settings.hour) return null;
    const id = await makeToday(deps, userId, local.day, settings.timezone);
    if (!id) return null;
    row = await briefingRow(deps.db, userId, { id });
  }
  if (!row || row.empty || row.dismissed_at) return null;
  const out = await present(deps.db, row, userId);
  return out.segments.length ? out : null;
}

async function briefingRow(db: Q, userId: string, by: { id?: string; day?: string }): Promise<Row | null> {
  const { rows } = await db.query<Row>(`SELECT ${ROW_COLS} FROM today_briefings WHERE user_id = $1 AND ${by.id ? 'id = $2' : 'day = $2'}`, [
    userId,
    by.id ?? by.day,
  ]);
  return rows[0] ?? null;
}

/** One briefing of the owner's, as they may hear it now (Yap Radio plays it by id); null when it isn't theirs. */
export async function todayById(db: Q, userId: string, id: string): Promise<TodayBriefing | null> {
  const row = await briefingRow(db, userId, { id });
  return row && !row.empty ? present(db, row, userId) : null;
}

/**
 * "Not interested in this": the segment goes from this briefing, and the people (and posts) it was
 * about stay out of the person's Todays for 30 days. Returns false when there's no such segment.
 */
export async function notInterested(db: Pool, userId: string, id: string, index: number): Promise<boolean> {
  const row = await briefingRow(db, userId, { id });
  const seg = row?.segments[index];
  if (!row || !seg) return false;
  await db.query(
    `INSERT INTO today_feedback (user_id, author_id, post_id)
     SELECT $1, p.author_id, p.id FROM posts p WHERE p.id = ANY($2::uuid[])`,
    [userId, seg.sources],
  );
  await db.query(`UPDATE today_briefings SET hidden = array_append(hidden, $3::smallint) WHERE id = $1 AND user_id = $2 AND NOT ($3 = ANY(hidden))`, [
    id,
    userId,
    index,
  ]);
  return true;
}

/** "Hide": the card goes until tomorrow's. */
export async function dismissToday(db: Q, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE today_briefings SET dismissed_at = coalesce(dismissed_at, now()) WHERE id = $1 AND user_id = $2`, [id, userId]);
  return !!rowCount;
}

// ─── The morning sweep ───────────────────────────────────────────────────

let lastCleanup = 0;

/**
 * Make the Todays that are due: for everyone with Today on who used the app in the last 7 days,
 * whose chosen hour has come this morning (until noon, their time) and who has none for today
 * yet. "Your Today is ready" goes to those who asked for it (quiet hours hold the push). Old
 * briefings and city parts are deleted along the way. `now` is for tests. Returns how many were
 * made with something in them.
 */
export async function sweepToday(deps: TodayDeps, opts: { now?: Date; limit?: number; userIds?: string[] } = {}): Promise<number> {
  const { now = new Date(), limit = 100, userIds = null } = opts;
  if (!(await todayAvailable(deps))) return 0;
  if (Date.now() - lastCleanup > 60 * 60_000) {
    lastCleanup = Date.now();
    await deps.db.query(`DELETE FROM today_briefings WHERE day < current_date - ${KEEP_DAYS}`);
    await deps.db.query(`DELETE FROM today_city_segments WHERE day < current_date - ${KEEP_DAYS}`);
    await deps.db.query(`DELETE FROM today_feedback WHERE created_at < now() - interval '${FEEDBACK_DAYS} days'`);
    await deps.db.query(`DELETE FROM today_budget WHERE day < current_date - ${KEEP_DAYS}`);
  }
  const { rows } = await deps.db.query<{ id: string; tz: string; notify: boolean; day: string }>(
    `WITH cand AS (
       SELECT u.id, ${TIMEZONE_SQL('up')} AS tz, coalesce(up.today_hour, ${TODAY_DEFAULT_HOUR}) AS hour, coalesce(up.today_notify, false) AS notify
       FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
       WHERE u.status = 'active' AND coalesce(up.today, true) AND ($3::uuid[] IS NULL OR u.id = ANY($3::uuid[]))
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.last_seen_at > $1::timestamptz - interval '7 days')
     ), local AS (
       SELECT id, tz, hour, notify, ($1::timestamptz AT TIME ZONE tz) AS at FROM cand
     )
     SELECT id, tz, notify, to_char(at::date, 'YYYY-MM-DD') AS day FROM local
     WHERE extract(hour FROM at) >= hour AND extract(hour FROM at) < 12
       AND NOT EXISTS (SELECT 1 FROM today_briefings b WHERE b.user_id = local.id AND b.day = at::date)
     LIMIT $2`,
    [now, limit, userIds],
  );
  let made = 0;
  // A few at a time: each is a model call and a few clips.
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(
      rows.slice(i, i + 4).map(async (r) => {
        const id = await makeToday(deps, r.id, r.day, r.tz).catch(() => null);
        if (!id) return;
        const row = await briefingRow(deps.db, r.id, { id });
        if (!row || row.empty || row.notified_at || row.dismissed_at) return;
        made++;
        if (!r.notify || !(await present(deps.db, row, r.id)).segments.length) return;
        await notify(deps.db, deps.realtime, {
          userId: r.id,
          category: 'system',
          type: 'today_ready',
          entityType: 'today',
          entityId: id,
          data: { day: r.day },
        });
        await deps.db.query(`UPDATE today_briefings SET notified_at = now() WHERE id = $1`, [id]);
      }),
    );
  }
  return made;
}
