import { randomInt } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import {
  STASH_AREA_METRES,
  STASH_AREA_OFFSET_METRES,
  STASH_EXPLORERS_LIMIT,
  STASH_MAX_ACCURACY,
  STASH_JUMP_METRES,
  STASH_MAX_SPEED_KMH,
  STASH_NEAR_METRES,
  STASH_PER_DAY,
  STASH_SAMPLE_MINUTES,
  STASH_VIDEO_MAX_MS,
  accurateEnough,
  cityKey,
  distanceMetres,
  launchCityAt,
  roundedToGo,
  stashBadges,
  stashMetresToGo,
  type HideStashInput,
  type LatLng,
  type MapItem,
  type MusicTrack,
  type StashCard,
  type StashContent,
  type StashExplorer,
  type StashExplorerRow,
  type StashFind,
  type StashOpenResult,
  type StashPosition,
  type StashReaction,
  type StashSettings,
  type VoiceClip,
} from '@yapilapi/shared';
import type { AppContext } from './context.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from './errors.ts';
import { activeControls } from './family.ts';
import { inQuietHours } from './interactions.ts';
import { MEDIA_BLOCKED_MESSAGE } from './media-moderation.ts';
import { analyzeText, statusForRisk } from './moderation.ts';
import { libraryByIds } from './music/library.ts';
import { isEnabled, notify } from './services.ts';
import { activeMember } from './squads.ts';
import { areFriends, followEachOther, isBlockedEitherWay, plusCol, publicUserFrom } from './users.ts';
import { claimVoice, startTranscript, voiceClipSql } from './voice.ts';
import { notBlockedSql, squadMemberSql } from './visibility.ts';

type Q = Pool | PoolClient;
type Deps = Pick<AppContext, 'db' | 'realtime' | 'config' | 'music' | 'mediaModerator'> & { transcription?: AppContext['transcription'] };

/**
 * Stash (docs/product/stash.md): hide something at a real place; it only opens for someone who is
 * there.
 *
 * The point a stash was hidden at (stashes.lat, lng) is used for one thing, opening it, and is
 * never put in any answer except to the person who hid it (and moderators, in the queue). Everyone
 * else gets its area: a point a random distance and direction from it, chosen once (so asking again
 * never narrows it down), and "about 300 m away" from that. Opening says how far there is to go,
 * rounded up (roundedToGo); attempts are rate-limited and a position that jumped faster than
 * STASH_MAX_SPEED_KMH since the last one is refused, so walking around a stash is the only way in.
 *
 * Who finds one (on the map, in the list, on its page and when opening) goes through
 * stashVisibleSql: its audience (one person, friends, a squad or everyone), blocks either way, the
 * hider's account still active, its words, photo, video or voice note cleared by moderation, and
 * minors' rules: someone under 18 and an adult never find each other's stashes unless they are
 * friends or family-linked (the team's launch stashes are for everyone).
 */

// ─── Visibility ─────────────────────────────────────────────────────────

/** Whether someone is under 18 (unknown ages count as adults, as for messages). */
const minorSql = (x: string) => `coalesce((SELECT ux.birth_date > current_date - interval '18 years' FROM users ux WHERE ux.id = ${x}), false)`;
const friendsSql = (a: string, b: string) => `EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST(${a}, ${b}) AND fr.user_b = GREATEST(${a}, ${b}))`;
const familySql = (a: string, b: string) =>
  `EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active' AND ((fl.guardian_id = ${a} AND fl.teen_id = ${b}) OR (fl.guardian_id = ${b} AND fl.teen_id = ${a})))`;

/** Stashes `s` still findable in time: not taken back and not past their end. */
export const stashLiveSql = (s = 's') => `(${s}.deleted_at IS NULL AND (${s}.expires_at IS NULL OR ${s}.expires_at > now()))`;

/**
 * Stashes `s` whose contents are cleared: words that passed (moderation_status), a photo or video
 * that isn't blocked or sensitive, a voice note whose words are back and passed, and nothing that
 * went with it gone.
 */
export const stashClearedSql = (s = 's') => `(${s}.moderation_status = 'normal'
  AND (${s}.kind NOT IN ('photo', 'video', 'voice') OR ${s}.media_id IS NOT NULL)
  AND (${s}.kind <> 'song' OR ${s}.sound_id IS NOT NULL OR ${s}.music_track_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM media sm WHERE sm.id = ${s}.media_id AND (sm.moderation IN ('blocked', 'sensitive') OR sm.deleted_at IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM voice_clips sv WHERE sv.media_id = ${s}.media_id AND (sv.transcript_status = 'pending' OR sv.screened = 'held')))`;

/**
 * Stashes `s` viewer `v` may find (know about and try to open): their own, or live, cleared ones
 * for their audience from an active account nobody blocked, between people of the same age group
 * unless friends or family-linked (the team's launch stashes are for everyone).
 */
export function stashVisibleSql(v: string, s = 's'): string {
  return `(${s}.owner_id = ${v} OR (
    ${stashLiveSql(s)} AND ${stashClearedSql(s)}
    AND EXISTS (SELECT 1 FROM users sou WHERE sou.id = ${s}.owner_id AND sou.status = 'active')
    AND ${notBlockedSql(`${s}.owner_id`, v)}
    AND (CASE ${s}.audience
           WHEN 'everyone' THEN true
           WHEN 'friends' THEN ${friendsSql(`${s}.owner_id`, v)}
           WHEN 'person' THEN ${s}.recipient_id = ${v}
           WHEN 'squad' THEN ${squadMemberSql(`${s}.squad_id`, v)}
           ELSE false END)
    AND (${s}.seeded OR ${minorSql(`${s}.owner_id`)} = ${minorSql(v)} OR ${friendsSql(`${s}.owner_id`, v)} OR ${familySql(`${s}.owner_id`, v)})))`;
}

/** A first-finder stash `s` that someone other than `v` already opened. */
export const stashTakenSql = (v: string, s = 's') =>
  `(${s}.first_only AND EXISTS (SELECT 1 FROM stash_finds tf WHERE tf.stash_id = ${s}.id AND tf.finder_id IS DISTINCT FROM ${v}))`;

// ─── Positions ──────────────────────────────────────────────────────────

const M_PER_DEG = 111_320;

/** The area's middle: a random distance (up to STASH_AREA_OFFSET_METRES) and direction from the point. */
export function areaFor(p: LatLng, rand: () => number = () => randomInt(0, 1_000_000) / 1_000_000): LatLng {
  const r = STASH_AREA_OFFSET_METRES * Math.sqrt(rand());
  const a = rand() * 2 * Math.PI;
  const lat = p.lat + (r * Math.cos(a)) / M_PER_DEG;
  const lng = p.lng + (r * Math.sin(a)) / (M_PER_DEG * Math.max(Math.cos((p.lat * Math.PI) / 180), 0.01));
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

function assertAccurate(accuracy: number): void {
  if (!accurateEnough(accuracy))
    throw new AppError(422, 'location_inaccurate', 'Your location isn’t accurate enough yet. Move outside or wait for a better GPS signal.');
}

/**
 * Keep a position someone hid or opened from, after checking it's possible from their last one
 * (within the hour): a jump of more than STASH_JUMP_METRES faster than STASH_MAX_SPEED_KMH, the
 * accuracy of both counting in their favour, is refused and not kept. Only the last few are kept, and none for more than STASH_SAMPLE_MINUTES.
 */
export async function checkAndKeepPosition(db: Q, userId: string, pos: StashPosition): Promise<void> {
  const { rows } = await db.query<{ lat: number; lng: number; accuracy: number; secs: number }>(
    `SELECT lat, lng, accuracy, extract(epoch FROM now() - created_at)::float AS secs FROM stash_location_samples
     WHERE user_id = $1 AND created_at > now() - make_interval(mins => $2) ORDER BY created_at DESC LIMIT 1`,
    [userId, STASH_SAMPLE_MINUTES],
  );
  const last = rows[0];
  if (last) {
    const metres = Math.max(0, distanceMetres(last, pos) - last.accuracy - pos.accuracy);
    const kmh = metres / 1000 / (Math.max(last.secs, 1) / 3600);
    if (metres > STASH_JUMP_METRES && kmh > STASH_MAX_SPEED_KMH)
      throw new AppError(422, 'impossible_travel', 'Your location moved too far, too fast. Try again in a little while from where you are.');
  }
  await db.query(`INSERT INTO stash_location_samples (user_id, lat, lng, accuracy) VALUES ($1, $2, $3, $4)`, [userId, pos.lat, pos.lng, pos.accuracy]);
  await db.query(
    `DELETE FROM stash_location_samples WHERE user_id = $1 AND id NOT IN (SELECT id FROM stash_location_samples WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5)`,
    [userId],
  );
}

/** Delete positions older than STASH_SAMPLE_MINUTES (the minute sweep). */
export async function sweepStashSamples(db: Q): Promise<number> {
  return (await db.query(`DELETE FROM stash_location_samples WHERE created_at <= now() - make_interval(mins => $1)`, [STASH_SAMPLE_MINUTES])).rowCount ?? 0;
}

/** The city a point is in: a launch city, else the city of the nearest place page within about 25 km, else the hider's. */
async function cityAt(db: Q, userId: string, p: LatLng): Promise<string | null> {
  const launch = launchCityAt(p);
  if (launch) return launch.name;
  const d = 0.25;
  const { rows } = await db.query<{ city: string }>(
    `SELECT btrim(city) AS city FROM places WHERE deleted_at IS NULL AND btrim(coalesce(city, '')) <> '' AND lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
     ORDER BY (lat - $5) ^ 2 + (lng - $6) ^ 2 LIMIT 1`,
    [p.lat - d, p.lat + d, p.lng - d, p.lng + d, p.lat, p.lng],
  );
  if (rows[0]) return rows[0].city.slice(0, 60);
  const own = await db.query<{ city: string | null }>(`SELECT nullif(btrim(city), '') AS city FROM profiles WHERE user_id = $1`, [userId]);
  return own.rows[0]?.city?.slice(0, 60) ?? null;
}

// ─── Hiding ─────────────────────────────────────────────────────────────

/** At most STASH_PER_DAY a day each (taken-back ones count). */
async function assertStashPace(db: Q, userId: string): Promise<void> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stashes WHERE owner_id = $1 AND created_at > now() - interval '1 day'`, [
    userId,
  ]);
  if ((rows[0]?.n ?? 0) >= STASH_PER_DAY) throw new AppError(429, 'slow_down', 'You’ve hidden a lot of stashes today. Try again tomorrow.');
}

/**
 * One person: someone you're friends with or who follows you back, nobody blocked either way. An
 * adult can hide one for someone under 18 (and the other way round) only when they're friends or family-linked.
 */
async function assertRecipient(db: Q, ownerId: string, recipientId: string): Promise<void> {
  if (recipientId === ownerId) throw badRequest('Choose someone else.');
  const { rows } = await db.query<{ minor: boolean; me_minor: boolean; family: boolean }>(
    `SELECT ${minorSql('u.id')} AS minor, ${minorSql('$2')} AS me_minor, ${familySql('u.id', '$2')} AS family
     FROM users u WHERE u.id = $1 AND u.status = 'active'`,
    [recipientId, ownerId],
  );
  const r = rows[0];
  if (!r || (await isBlockedEitherWay(db, ownerId, recipientId))) throw notFound('That person');
  const friends = await areFriends(db, ownerId, recipientId);
  if (r.minor !== r.me_minor && !friends && !r.family)
    throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only hide a stash for them once you are friends.');
  if (!friends && !r.family && !(await followEachOther(db, ownerId, recipientId)))
    throw forbidden('You can hide a stash for friends and people who follow you back.');
}

interface Prepared {
  mediaId: string | null;
  voiceId: string | null;
  soundId: string | null;
  trackId: string | null;
  startMs: number | null;
  durationMs: number | null;
}

/** A photo or video of yours for a stash: processed, not blocked or sensitive, a short video. */
async function assertMedia(deps: Deps, ownerId: string, mediaId: string, kind: 'image' | 'video'): Promise<void> {
  const { rows } = await deps.db.query<{ kind: string; status: string; moderation: string; processed: boolean; duration_ms: number | null }>(
    `SELECT m.kind, m.status, m.moderation, m.duration_ms,
            (m.variants ? 'thumb' OR m.variants ? 'mp4' OR m.poster_url IS NOT NULL) AS processed
     FROM media m WHERE m.id = $1 AND m.owner_id = $2 AND NOT m.private AND m.deleted_at IS NULL`,
    [mediaId, ownerId],
  );
  const m = rows[0];
  if (!m) throw notFound('That photo or video');
  if (m.kind !== kind) throw badRequest(kind === 'image' ? 'Choose a photo.' : 'Choose a video.');
  if (m.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
  if (m.moderation === 'sensitive') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
  if (m.status !== 'ready' || !m.processed || (deps.mediaModerator.name !== 'none' && m.moderation === 'pending'))
    throw new AppError(409, 'media_processing', 'Your photo or video is still being prepared. Try again in a moment.');
  if (kind === 'video' && (m.duration_ms ?? 0) > STASH_VIDEO_MAX_MS + 500) throw badRequest('A video in a stash can be up to a minute long.');
}

/** Check what goes in, outside the transaction (a catalogue song is read again from its provider). */
async function prepareContent(deps: Deps, ownerId: string, input: HideStashInput): Promise<Prepared> {
  const none: Prepared = { mediaId: null, voiceId: null, soundId: null, trackId: null, startMs: null, durationMs: null };
  if (input.kind === 'photo' || input.kind === 'video') {
    await assertMedia(deps, ownerId, input.mediaId!, input.kind === 'photo' ? 'image' : 'video');
    return { ...none, mediaId: input.mediaId! };
  }
  if (input.kind === 'voice') return { ...none, voiceId: input.voiceId! };
  if (input.kind === 'song') {
    const m = input.music!;
    const used = await deps.music.prepareUse(
      ownerId,
      { soundId: m.soundId, trackId: m.trackId, startMs: m.startMs ?? 0, durationMs: m.durationMs ?? 15_000 },
      'posts',
    );
    return { ...none, soundId: used.soundId, trackId: used.trackId, startMs: used.stored.startMs, durationMs: used.stored.durationMs };
  }
  return none;
}

export interface HideOptions {
  /** Seed mode (admins): the team's stash, at a chosen point, for everyone. */
  seeded?: boolean;
  point: LatLng;
  accuracy: number | null;
}

/**
 * Hide a stash: who it's for, what goes in (checked like a post's words, photo, video or voice
 * note; held contents can't be found until a moderator clears them), how long and whether only the
 * first finder gets it. Not seeded: where the device is now, accurate enough, at most STASH_PER_DAY a day.
 */
export async function hideStash(deps: Deps, ownerId: string, input: HideStashInput, o: HideOptions): Promise<string> {
  const { db } = deps;
  if (!o.seeded) {
    assertAccurate(o.accuracy ?? Infinity);
    await assertStashPace(db, ownerId);
  }
  if (input.audience === 'person') await assertRecipient(db, ownerId, input.recipientId!);
  if (input.audience === 'squad') await activeMember(db, input.squadId!, ownerId);
  const words = [input.title, input.hint, input.body, input.kind === 'gift' ? input.giftCode : undefined].filter(Boolean).join('\n');
  const analysis = analyzeText(words);
  if (analysis.risk === 'escalate')
    throw new AppError(
      422,
      'content_blocked',
      "This post can't be published because it may put someone at risk. If you or someone else is in danger, contact local emergency services.",
    );
  const status = analysis.risk === 'normal' ? 'normal' : statusForRisk(analysis.risk);
  const content = await prepareContent(deps, ownerId, input);
  if (!o.seeded) await checkAndKeepPosition(db, ownerId, { lat: o.point.lat, lng: o.point.lng, accuracy: o.accuracy ?? STASH_MAX_ACCURACY });
  const city = await cityAt(db, ownerId, o.point);
  const area = areaFor(o.point);
  const id = await tx(db, async (c) => {
    if (content.voiceId) await claimVoice(c, ownerId, content.voiceId, 'yap');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO stashes (owner_id, seeded, kind, title, hint, body, gift_code, media_id, sound_id, music_track_id, music_start_ms, music_ms,
                            lat, lng, accuracy, area_lat, area_lng, city, city_key, audience, recipient_id, squad_id, first_only, expires_at, moderation_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               CASE $24 WHEN '24h' THEN now() + interval '24 hours' WHEN '7d' THEN now() + interval '7 days' END, $25)
       RETURNING id`,
      [
        ownerId,
        !!o.seeded,
        input.kind,
        input.title ?? null,
        input.hint ?? null,
        input.body ?? null,
        input.kind === 'gift' ? (input.giftCode ?? null) : null,
        content.mediaId ?? content.voiceId,
        content.soundId,
        content.trackId,
        content.startMs,
        content.durationMs,
        o.point.lat,
        o.point.lng,
        o.accuracy,
        area.lat,
        area.lng,
        city,
        city ? cityKey(city) : null,
        input.audience,
        input.audience === 'person' ? input.recipientId : null,
        input.audience === 'squad' ? input.squadId : null,
        input.firstOnly ?? false,
        input.duration,
        status,
      ],
    );
    const stashId = rows[0]!.id;
    if (status !== 'normal')
      await c.query(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('stash', $1, $2, 'automated', $3, $4)
         ON CONFLICT (target_type, target_id) WHERE status = 'open' DO NOTHING`,
        [stashId, ownerId, analysis.risk, { signals: analysis.signals }],
      );
    return stashId;
  });
  // A voice note's words are checked once they're back; until then it can't be found.
  if (content.voiceId) await startTranscript(deps, content.voiceId);
  return id;
}

// ─── Reading ────────────────────────────────────────────────────────────

const STASH_FROM = `FROM stashes s LEFT JOIN profiles op ON op.user_id = s.owner_id`;
const ownerCols = `op.user_id AS u_id, op.username AS u_username, op.display_name AS u_display_name, op.avatar_url AS u_avatar_url, op.mode AS u_mode, ${plusCol('u_', 'op')}`;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Stashes by id (in order) as `viewer` may see them; ones they may not find are left out. */
export async function stashCards(deps: Pick<Deps, 'db' | 'music'>, ids: string[], viewer: string): Promise<StashCard[]> {
  if (!ids.length) return [];
  const { db } = deps;
  const { rows } = await db.query(
    `SELECT s.*, ${ownerCols},
            (SELECT count(*)::int FROM stash_finds f WHERE f.stash_id = s.id) AS finds,
            EXISTS (SELECT 1 FROM stash_finds f WHERE f.stash_id = s.id AND f.finder_id = $2) AS found,
            ${stashTakenSql('$2')} AS taken,
            NOT ${stashLiveSql()} AS ended,
            m.kind AS m_kind, m.url AS m_url, m.poster_url AS m_poster, m.width AS m_width, m.height AS m_height, m.alt_text AS m_alt,
            coalesce(m.variants->>'mp4', m.url) AS m_video,
            ${voiceClipSql('s.media_id')} AS voice
     ${STASH_FROM} LEFT JOIN media m ON m.id = s.media_id AND s.kind IN ('photo', 'video')
     WHERE s.id = ANY($1::uuid[]) AND ${stashVisibleSql('$2')}`,
    [ids, viewer],
  );
  const songs = new Map<string, MusicTrack>();
  const trackIds = rows.filter((r) => r.music_track_id).map((r) => r.music_track_id as string);
  const soundIds = rows.filter((r) => r.sound_id).map((r) => r.sound_id as string);
  if (trackIds.length) {
    const who = await deps.music.who(viewer);
    for (const tr of await deps.music.byIds(trackIds, viewer, who)) songs.set(tr.id, tr);
  }
  if (soundIds.length) for (const tr of await libraryByIds(db, soundIds, viewer)) songs.set(tr.id, tr);
  const byId = new Map(
    rows.map((r) => {
      const mine = r.owner_id === viewer;
      const open = mine || r.found;
      const song = songs.get(r.music_track_id ?? r.sound_id ?? '');
      const content: StashContent | null = open
        ? {
            body: r.body,
            giftCode: r.gift_code,
            media: r.m_kind
              ? {
                  kind: r.m_kind === 'video' ? 'video' : 'image',
                  url: r.m_kind === 'video' ? r.m_video : r.m_url,
                  posterUrl: r.m_poster,
                  width: r.m_width,
                  height: r.m_height,
                  altText: r.m_alt,
                }
              : null,
            voice: r.kind === 'voice' ? ((r.voice as VoiceClip | null) ?? null) : null,
            song: song ? { track: song, startMs: r.music_start_ms ?? 0, durationMs: r.music_ms ?? 15_000 } : null,
          }
        : null;
      const card: StashCard = {
        id: r.id,
        kind: r.kind,
        title: r.title,
        hint: r.hint,
        audience: r.audience,
        seeded: r.seeded,
        owner: r.seeded ? null : publicUserFrom(r, 'u_'),
        area: { center: { lat: r.area_lat, lng: r.area_lng }, metres: STASH_AREA_METRES },
        city: r.city,
        expiresAt: iso(r.expires_at),
        firstOnly: r.first_only,
        finds: r.finds,
        createdAt: iso(r.created_at)!,
        mine,
        found: r.found,
        taken: r.taken,
        ended: r.ended,
        content,
      };
      if (mine) {
        card.point = { lat: r.lat, lng: r.lng };
        card.moderation = r.moderation_status;
      }
      return [r.id as string, card] as const;
    }),
  );
  // Yours: who it's for.
  const own = [...byId.values()].filter((c) => c.mine);
  if (own.length) {
    const { rows: who } = await db.query(
      `SELECT s.id, sq.id AS squad_id, sq.name AS squad_name, rp.user_id AS u_id, rp.username AS u_username, rp.display_name AS u_display_name,
              rp.avatar_url AS u_avatar_url, rp.mode AS u_mode, ${plusCol('u_', 'rp')}
       FROM stashes s LEFT JOIN profiles rp ON rp.user_id = s.recipient_id LEFT JOIN squads sq ON sq.id = s.squad_id
       WHERE s.id = ANY($1::uuid[])`,
      [own.map((c) => c.id)],
    );
    for (const r of who) {
      const c = byId.get(r.id)!;
      c.recipient = r.u_id ? publicUserFrom(r, 'u_') : null;
      c.squad = r.squad_id ? { id: r.squad_id, name: r.squad_name } : null;
    }
  }
  return ids.map((id) => byId.get(id)).filter((c): c is StashCard => !!c);
}

export async function stashCard(deps: Pick<Deps, 'db' | 'music'>, id: string, viewer: string): Promise<StashCard> {
  const [card] = await stashCards(deps, [id], viewer);
  if (!card) throw notFound('That stash');
  return card;
}

/** Roughly how far (to the area's middle, never the point) and nearest first, around `from`: ids. */
export async function nearStashes(db: Q, viewer: string, from: LatLng): Promise<{ id: string; metres: number }[]> {
  const dLat = STASH_NEAR_METRES / M_PER_DEG;
  const dLng = dLat / Math.max(Math.cos((from.lat * Math.PI) / 180), 0.01);
  const { rows } = await db.query<{ id: string; area_lat: number; area_lng: number }>(
    `SELECT s.id, s.area_lat, s.area_lng FROM stashes s
     WHERE s.area_lat BETWEEN $2 AND $3 AND s.area_lng BETWEEN $4 AND $5 AND ${stashLiveSql()} AND ${stashVisibleSql('$1')} AND NOT ${stashTakenSql('$1')}
     ORDER BY (s.area_lat - $6) ^ 2 + ((s.area_lng - $7) * $8) ^ 2 LIMIT 50`,
    [viewer, from.lat - dLat, from.lat + dLat, from.lng - dLng, from.lng + dLng, from.lat, from.lng, Math.cos((from.lat * Math.PI) / 180)],
  );
  return rows.map((r) => ({ id: r.id, metres: Math.round(distanceMetres(from, { lat: r.area_lat, lng: r.area_lng }) / 50) * 50 }));
}

/** Your stashes, newest first (with their points: they're yours). */
export async function myStashes(db: Q, ownerId: string, limit = 50): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM stashes WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2`, [
    ownerId,
    limit,
  ]);
  return rows.map((r) => r.id);
}

/** Stashes you opened, the latest first. */
export async function myFinds(db: Q, finderId: string, limit = 50): Promise<string[]> {
  const { rows } = await db.query<{ stash_id: string }>(
    `SELECT f.stash_id FROM stash_finds f JOIN stashes s ON s.id = f.stash_id WHERE f.finder_id = $1 AND s.deleted_at IS NULL
     ORDER BY f.created_at DESC LIMIT $2`,
    [finderId, limit],
  );
  return rows.map((r) => r.stash_id);
}

/** Who found your stash and what they sent back (yours only), the latest first; nobody blocked either way. */
export async function stashFinds(db: Q, ownerId: string, stashId: string): Promise<StashFind[]> {
  const { rows } = await db.query(
    `SELECT f.created_at, f.reaction, f.thanks, fp.user_id AS u_id, fp.username AS u_username, fp.display_name AS u_display_name,
            fp.avatar_url AS u_avatar_url, fp.mode AS u_mode, ${plusCol('u_', 'fp')}
     FROM stash_finds f JOIN stashes s ON s.id = f.stash_id JOIN profiles fp ON fp.user_id = f.finder_id JOIN users fu ON fu.id = f.finder_id
     WHERE f.stash_id = $2 AND s.owner_id = $1 AND fu.status = 'active' AND ${notBlockedSql('f.finder_id', '$1')}
     ORDER BY f.created_at DESC LIMIT 200`,
    [ownerId, stashId],
  );
  return rows.map((r) => ({ finder: publicUserFrom(r, 'u_'), foundAt: iso(r.created_at)!, reaction: r.reaction, thanks: r.thanks }));
}

// ─── Opening ────────────────────────────────────────────────────────────

/**
 * Try to open a stash from here: someone who may find it, with a position accurate enough and
 * possible from their last one, within STASH_OPEN_METRES of its point (with some of the accuracy
 * in their favour). Not yet: how far there is to go, rounded. A first-finder stash opens for one
 * person only: the row is locked while the find is written, so two at once can't both have it.
 * The person who hid it hears who found it (grouped per stash), unless the team hid it.
 */
export async function openStash(deps: Deps, viewer: string, stashId: string, pos: StashPosition): Promise<StashOpenResult> {
  const { db } = deps;
  assertAccurate(pos.accuracy);
  const { rows } = await db.query<{ owner_id: string; lat: number; lng: number; seeded: boolean; city_key: string | null; found: boolean; live: boolean }>(
    `SELECT s.owner_id, s.lat, s.lng, s.seeded, s.city_key, ${stashLiveSql()} AS live,
            EXISTS (SELECT 1 FROM stash_finds f WHERE f.stash_id = s.id AND f.finder_id = $2) AS found
     FROM stashes s WHERE s.id = $1 AND ${stashVisibleSql('$2')}`,
    [stashId, viewer],
  );
  const s = rows[0];
  if (!s) throw notFound('That stash');
  if (s.owner_id === viewer || s.found) return { opened: true, toGoMetres: 0, stash: await stashCard(deps, stashId, viewer) };
  if (!s.live) throw new AppError(410, 'stash_ended', 'This stash has ended.');
  await checkAndKeepPosition(db, viewer, pos);
  const toGo = stashMetresToGo(distanceMetres(s, pos), pos.accuracy);
  if (toGo > 0) return { opened: false, toGoMetres: roundedToGo(toGo), stash: await stashCard(deps, stashId, viewer) };
  const made = await tx(db, async (c) => {
    const lock = await c.query<{ first_only: boolean }>(`SELECT first_only FROM stashes WHERE id = $1 FOR UPDATE`, [stashId]);
    if (lock.rows[0]?.first_only) {
      const other = await c.query(`SELECT 1 FROM stash_finds WHERE stash_id = $1 AND finder_id <> $2`, [stashId, viewer]);
      if (other.rowCount) throw conflict('Someone found this one first.');
    }
    const ins = await c.query(`INSERT INTO stash_finds (stash_id, finder_id, city_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
      stashId,
      viewer,
      s.city_key,
    ]);
    return !!ins.rowCount;
  });
  if (made && !s.seeded)
    await notify(db, deps.realtime, {
      userId: s.owner_id,
      category: 'friends',
      type: 'stash_found',
      actorId: viewer,
      entityType: 'stash',
      entityId: stashId,
      group: stashId,
    });
  return { opened: true, toGoMetres: 0, stash: await stashCard(deps, stashId, viewer) };
}

/** The finder thanks the person who hid it: one of the quick thank-yous and a few words (checked like a comment's). */
export async function thankStash(deps: Deps, finderId: string, stashId: string, x: { reaction?: StashReaction; text?: string }): Promise<void> {
  const { db } = deps;
  if (x.text && analyzeText(x.text).risk !== 'normal') throw new AppError(422, 'content_blocked', 'This message can’t be sent.');
  const { rows } = await db.query<{ owner_id: string; seeded: boolean; thanked: boolean }>(
    `SELECT s.owner_id, s.seeded, f.thanked_at IS NOT NULL AS thanked FROM stash_finds f JOIN stashes s ON s.id = f.stash_id
     WHERE f.stash_id = $1 AND f.finder_id = $2 AND s.deleted_at IS NULL AND ${notBlockedSql('s.owner_id', '$2')}`,
    [stashId, finderId],
  );
  const r = rows[0];
  if (!r) throw notFound('That stash');
  await db.query(`UPDATE stash_finds SET reaction = $3, thanks = $4, thanked_at = now() WHERE stash_id = $1 AND finder_id = $2`, [
    stashId,
    finderId,
    x.reaction ?? null,
    x.text ?? null,
  ]);
  if (!r.thanked && !r.seeded)
    await notify(db, deps.realtime, {
      userId: r.owner_id,
      category: 'friends',
      type: 'stash_thanks',
      actorId: finderId,
      entityType: 'stash',
      entityId: stashId,
      data: { reaction: x.reaction ?? null },
    });
}

/** Take a stash back (yours): nobody can find it any more. */
export async function takeBack(db: Q, ownerId: string, stashId: string): Promise<void> {
  const r = await db.query(`UPDATE stashes SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, [stashId, ownerId]);
  if (!r.rowCount) throw notFound('That stash');
}

// ─── The map's Stashes layer ────────────────────────────────────────────

/** Candidates for the map (the same for everyone): live stashes with their area in the box ($1..$4), newest first. */
export const STASH_MAP_CANDIDATES = `SELECT s.id, s.area_lat AS lat, s.area_lng AS lng FROM stashes s
  WHERE s.area_lat BETWEEN $1 AND $3 AND s.area_lng BETWEEN $2 AND $4 AND ${stashLiveSql()}
  ORDER BY s.created_at DESC LIMIT $5`;

/** The stashes among `ids` this viewer may find, as map items: by their area only. */
export async function stashMapItems(db: Q, viewer: string, ids: string[]): Promise<MapItem[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.title, s.hint, s.seeded, s.area_lat, s.area_lng, s.created_at, s.expires_at, ${ownerCols},
            (SELECT count(*)::int FROM stash_finds f WHERE f.stash_id = s.id) AS finds
     ${STASH_FROM} WHERE s.id = ANY($2::uuid[]) AND ${stashLiveSql()} AND ${stashVisibleSql('$1')} AND NOT ${stashTakenSql('$1')}
     ORDER BY s.created_at DESC`,
    [viewer, ids],
  );
  return rows.map(
    (r) =>
      ({
        key: `stashes:${r.id}`,
        layer: 'stashes',
        title: r.title ?? '',
        subtitle: r.hint ?? null,
        point: { lat: r.area_lat, lng: r.area_lng },
        approximate: true,
        at: iso(r.created_at),
        endsAt: iso(r.expires_at),
        thumbUrl: null,
        count: r.finds,
        user: r.seeded ? null : publicUserFrom(r, 'u_'),
        target: { kind: 'stash', id: r.id },
      }) satisfies MapItem,
  );
}

// ─── Explorers ──────────────────────────────────────────────────────────

/**
 * "Stashes found: 12 · Hidden: 5" and badges, for `viewer` looking at `userId`'s profile. Null when
 * that person keeps it to themselves (they always see their own), or is blocked either way.
 */
export async function explorerOf(db: Q, userId: string, viewer: string | null): Promise<StashExplorer | null> {
  if (viewer !== userId) {
    const { rows } = await db.query<{ show: boolean }>(`SELECT coalesce((SELECT stash_show_counts FROM user_preferences WHERE user_id = $1), true) AS show`, [
      userId,
    ]);
    if (!rows[0]?.show) return null;
    if (viewer && (await isBlockedEitherWay(db, userId, viewer))) return null;
  }
  const { rows } = await db.query<{ found: number; cities: number; hidden: number }>(
    `SELECT (SELECT count(*)::int FROM stash_finds WHERE finder_id = $1) AS found,
            (SELECT count(DISTINCT city_key)::int FROM stash_finds WHERE finder_id = $1 AND city_key IS NOT NULL) AS cities,
            (SELECT count(*)::int FROM stashes WHERE owner_id = $1 AND NOT seeded AND deleted_at IS NULL AND moderation_status <> 'removed') AS hidden`,
    [userId],
  );
  const r = rows[0]!;
  return { found: r.found, hidden: r.hidden, cities: r.cities, badges: stashBadges(r.found, r.cities) };
}

/**
 * This month's top explorers in a city: the most finds there since the 1st, among adults who left
 * "Show me in explorer lists" on, with active accounts, nobody blocked with the viewer.
 */
export async function topExplorers(db: Q, viewer: string, city: string): Promise<StashExplorerRow[]> {
  const { rows } = await db.query(
    `SELECT f.finder_id, count(*)::int AS finds, fp.user_id AS u_id, fp.username AS u_username, fp.display_name AS u_display_name,
            fp.avatar_url AS u_avatar_url, fp.mode AS u_mode, ${plusCol('u_', 'fp')}
     FROM stash_finds f JOIN users fu ON fu.id = f.finder_id JOIN profiles fp ON fp.user_id = f.finder_id
     LEFT JOIN user_preferences up ON up.user_id = f.finder_id
     WHERE f.city_key = $2 AND f.created_at >= date_trunc('month', now()) AND fu.status = 'active'
       AND coalesce(fu.birth_date <= current_date - interval '18 years', false) AND coalesce(up.stash_explorer_lists, true)
       AND ${notBlockedSql('f.finder_id', '$1')}
     GROUP BY f.finder_id, fp.user_id, fp.username, fp.display_name, fp.avatar_url, fp.mode, fp.plus_until
     ORDER BY count(*) DESC, max(f.created_at) ASC LIMIT $3`,
    [viewer, cityKey(city), STASH_EXPLORERS_LIMIT],
  );
  return rows.map((r) => ({ user: publicUserFrom(r, 'u_'), finds: r.finds }));
}

// ─── Settings ───────────────────────────────────────────────────────────

export async function stashSettings(db: Q, userId: string): Promise<StashSettings> {
  const { rows } = await db.query<{ show: boolean; lists: boolean; nearby: boolean; minor: boolean }>(
    `SELECT coalesce(up.stash_show_counts, true) AS show, coalesce(up.stash_explorer_lists, true) AS lists,
            coalesce(up.stash_nearby_notify, false) AS nearby, NOT coalesce(u.birth_date <= current_date - interval '18 years', false) AS minor
     FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0]!;
  return { showCounts: r.show, explorerLists: r.lists && !r.minor, nearbyNotify: r.nearby, explorerListsLocked: r.minor };
}

export async function setStashSettings(
  db: Q,
  userId: string,
  s: { showCounts?: boolean; explorerLists?: boolean; nearbyNotify?: boolean },
): Promise<StashSettings> {
  await db.query(`INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  await db.query(
    `UPDATE user_preferences SET stash_show_counts = coalesce($2, stash_show_counts), stash_explorer_lists = coalesce($3, stash_explorer_lists),
            stash_nearby_notify = coalesce($4, stash_nearby_notify) WHERE user_id = $1`,
    [userId, s.showCounts ?? null, s.explorerLists ?? null, s.nearbyNotify ?? null],
  );
  return stashSettings(db, userId);
}

// ─── New stashes near you ───────────────────────────────────────────────

/**
 * "3 new stashes near you today", for people who turned it on: at most once a day each, about
 * stashes hidden in their profile's city since the last one (in the last day) that they may find,
 * not their own and not opened yet; never during quiet hours (theirs or a guardian's).
 */
export async function sweepStashNearby(deps: Pick<Deps, 'db' | 'realtime'>, batch = 200): Promise<number> {
  const { db } = deps;
  if (!(await isEnabled(db, 'STASH'))) return 0;
  const { rows: people } = await db.query<{ user_id: string; city_key: string; since: Date }>(
    `SELECT up.user_id, lower(regexp_replace(btrim(pr.city), '\\s+', ' ', 'g')) AS city_key,
            greatest(coalesce(up.stash_nearby_sent_at, now() - interval '1 day'), now() - interval '1 day') AS since
     FROM user_preferences up JOIN users u ON u.id = up.user_id JOIN profiles pr ON pr.user_id = up.user_id
     WHERE up.stash_nearby_notify AND u.status = 'active' AND btrim(coalesce(pr.city, '')) <> ''
       AND (up.stash_nearby_sent_at IS NULL OR up.stash_nearby_sent_at < now() - interval '1 day')
     ORDER BY up.stash_nearby_sent_at NULLS FIRST LIMIT $1`,
    [batch],
  );
  let told = 0;
  for (const p of people) {
    if ((await activeControls(db, p.user_id))?.quietNow || (await inQuietHours(db, p.user_id))) continue;
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stashes s
       WHERE s.city_key = $2 AND s.created_at > $3 AND s.owner_id <> $1 AND ${stashLiveSql()} AND ${stashVisibleSql('$1')} AND NOT ${stashTakenSql('$1')}
         AND NOT EXISTS (SELECT 1 FROM stash_finds f WHERE f.stash_id = s.id AND f.finder_id = $1)`,
      [p.user_id, p.city_key, p.since],
    );
    const n = rows[0]?.n ?? 0;
    if (!n) continue;
    const kept = await db.query(
      `UPDATE user_preferences SET stash_nearby_sent_at = now() WHERE user_id = $1 AND (stash_nearby_sent_at IS NULL OR stash_nearby_sent_at < now() - interval '1 day')`,
      [p.user_id],
    );
    if (!kept.rowCount) continue;
    await notify(db, deps.realtime, { userId: p.user_id, category: 'communities', type: 'stash_nearby', data: { count: n } });
    told++;
  }
  return told;
}
