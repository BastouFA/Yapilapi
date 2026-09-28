import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import {
  licenceBlock,
  maxClipMs,
  MIX_COVER_TILES,
  MIX_LINE_WINDOW_MINUTES,
  MUSIC_CLIP_MAX_MS,
  type MessageSystemInfo,
  type Mix,
  type MixCard,
  type MixChat,
  type MixSong,
  type MixSongUnavailable,
  type MusicLicence,
  type MusicSource,
} from '@yapilapi/shared';
import { publishLine } from './chat-games.ts';
import { readersOf } from './chat-polls.ts';
import { enqueue } from './jobs.ts';
import type { RealtimeHub } from './realtime.ts';
import { soundUsableSql, soundVisibleSql } from './sounds.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { viewerCountries } from './music/view.ts';
import { notBlockedSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Mixes (migration 0048): who may see a mix, the cards and songs as each viewer gets them, and the
 * line in a chat when someone adds songs. Used by modules/mixes.ts, the messaging module (cards in
 * chats), posts (cards in posts) and profiles (the Mixes tab).
 *
 * SQL building blocks: mixes are aliased `mx`, the owner's user row `ou` and profile `op`. `v` is
 * the viewer placeholder (NULL when signed out).
 */
export interface MixDeps {
  db: Pool;
  realtime: RealtimeHub;
}

const minor = (birthCol: string) => `coalesce(${birthCol} > current_date - interval '18 years', false)`;
const follows = (v: string, other: string) => `EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = ${other})`;
const friends = (v: string, other: string) =>
  `EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${v} AND fr.user_b = ${other}) OR (fr.user_b = ${v} AND fr.user_a = ${other}))`;

/**
 * The viewer is in a chat the mix is shared into, the mix's card is still there, and its owner is
 * still in that chat. Never for a mix only its owner sees.
 */
export const mixCollaboratorSql = (v: string) => `(mx.visibility <> 'private' AND EXISTS (
  SELECT 1 FROM mix_chats mc
  JOIN conversation_members cmv ON cmv.conversation_id = mc.conversation_id AND cmv.user_id = ${v} AND cmv.left_at IS NULL
  JOIN conversation_members cmo ON cmo.conversation_id = mc.conversation_id AND cmo.user_id = mx.owner_id AND cmo.left_at IS NULL
  JOIN messages card ON card.id = mc.message_id AND card.deleted_at IS NULL AND (card.expires_at IS NULL OR card.expires_at > now())
  WHERE mc.mix_id = mx.id))`;

/**
 * Whether the viewer may see a mix: its owner always (a restricted or held one too); people in a
 * chat it's shared into; and, by its audience, everyone (a private account's followers; an
 * under-18's public mix is read as followers only), followers or friends. Blocks either way hide it,
 * and so does a deleted or suspended owner.
 */
export function mixVisibleSql(v: string): string {
  return `(ou.status = 'active' AND mx.deleted_at IS NULL AND ${notBlockedSql('mx.owner_id', v)} AND (
    mx.owner_id = ${v}
    OR (mx.moderation_status = 'normal' AND (
      ${mixCollaboratorSql(v)}
      OR (mx.visibility = 'public' AND NOT ${minor('ou.birth_date')} AND (NOT op.is_private OR ${follows(v, 'mx.owner_id')}))
      OR ((mx.visibility = 'followers' OR (mx.visibility = 'public' AND ${minor('ou.birth_date')})) AND ${follows(v, 'mx.owner_id')})
      OR (mx.visibility = 'friends' AND ${friends(v, 'mx.owner_id')})
    ))
  ))`;
}

export const MIX_FROM = `FROM mixes mx JOIN users ou ON ou.id = mx.owner_id JOIN profiles op ON op.user_id = mx.owner_id`;

const OWNER_COLS = `op.user_id AS o_id, op.username AS o_username, op.display_name AS o_display_name, op.avatar_url AS o_avatar_url, op.mode AS o_mode, ${plusCol('o_', 'op')}`;

/** Everything a mix card needs, for viewer $1. */
export const MIX_SUMMARY = `
  SELECT mx.id, mx.owner_id, mx.title, mx.description, mx.visibility, mx.like_count, mx.created_at, mx.updated_at, ${OWNER_COLS},
         (SELECT count(*)::int FROM mix_songs ms WHERE ms.mix_id = mx.id) AS song_count,
         EXISTS (SELECT 1 FROM mix_likes l WHERE l.mix_id = mx.id AND l.user_id = $1) AS liked,
         EXISTS (SELECT 1 FROM mix_saves sv WHERE sv.mix_id = mx.id AND sv.user_id = $1) AS saved,
         ${mixCollaboratorSql('$1')} AS collaborator,
         -- The mosaic: covers of the first songs that have one. A sound's cover only while the viewer may see the sound.
         (SELECT coalesce(array_agg(cv.url ORDER BY cv.position, cv.id), '{}') FROM (
            SELECT ms.id, ms.position, coalesce(mt.cover_url, CASE WHEN s.id IS NOT NULL AND ${soundVisibleSql('$1')} THEN sm.poster_url END) AS url
            FROM mix_songs ms
            LEFT JOIN music_tracks mt ON mt.id = ms.track_id AND mt.status <> 'withdrawn'
            LEFT JOIN sounds s ON s.id = ms.sound_id
            LEFT JOIN media sm ON sm.id = s.media_id
            WHERE ms.mix_id = mx.id AND coalesce(mt.cover_url, sm.poster_url) IS NOT NULL
            ORDER BY ms.position, ms.id LIMIT ${MIX_COVER_TILES + 2}
          ) cv WHERE cv.url IS NOT NULL) AS covers
  ${MIX_FROM}`;

type Row = Record<string, any>;

export function roleOf(r: Row, viewer: string | null): Mix['role'] {
  if (viewer && r.owner_id === viewer) return 'owner';
  return r.collaborator ? 'collaborator' : null;
}

/** A mix as its card shows it. `lite` (Data saver) leaves the covers out. */
export function toMix(r: Row, viewer: string | null, chats: MixChat[], lite = false): Mix {
  const role = roleOf(r, viewer);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    visibility: r.visibility,
    owner: publicUserFrom(r, 'o_'),
    songCount: Number(r.song_count ?? 0),
    covers: lite ? [] : ((r.covers as string[] | null) ?? []).slice(0, MIX_COVER_TILES),
    likeCount: Number(r.like_count ?? 0),
    liked: !!r.liked,
    saved: !!r.saved,
    role,
    canAdd: role !== null,
    chats,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

/**
 * The chats each mix is shared into, as the viewer may know of them: the owner sees all, anyone
 * else only the ones they're in. A one-to-one chat is named after the other person.
 */
export async function mixChats(db: Q, rows: Row[], viewer: string | null): Promise<Map<string, MixChat[]>> {
  const out = new Map<string, MixChat[]>();
  if (!viewer || !rows.length) return out;
  const own = rows.filter((r) => r.owner_id === viewer).map((r) => r.id as string);
  const { rows: chats } = await db.query(
    `SELECT mc.mix_id, mc.conversation_id, mc.message_id, c.kind, c.title,
            (SELECT pr.display_name FROM conversation_members o JOIN profiles pr ON pr.user_id = o.user_id
             WHERE o.conversation_id = c.id AND o.user_id <> $2 AND o.left_at IS NULL ORDER BY o.user_id LIMIT 1) AS other_name
     FROM mix_chats mc JOIN conversations c ON c.id = mc.conversation_id
     JOIN messages card ON card.id = mc.message_id AND card.deleted_at IS NULL AND (card.expires_at IS NULL OR card.expires_at > now())
     WHERE mc.mix_id = ANY($1::uuid[])
       AND (mc.mix_id = ANY($3::uuid[])
            OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = mc.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL))
     ORDER BY mc.created_at`,
    [rows.map((r) => r.id), viewer, own],
  );
  for (const c of chats) {
    const list = out.get(c.mix_id) ?? [];
    list.push({
      conversationId: c.conversation_id,
      kind: c.kind === 'group' ? 'group' : 'direct',
      title: c.kind === 'group' ? (c.title ?? null) : (c.other_name ?? null),
      messageId: c.message_id,
    });
    out.set(c.mix_id, list);
  }
  return out;
}

/** Mixes the viewer may see, by id, in the given order (the others are left out). */
export async function loadMixes(db: Q, ids: string[], viewer: string | null, lite = false): Promise<Mix[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const { rows } = await db.query(`${MIX_SUMMARY} WHERE mx.id = ANY($2::uuid[]) AND ${mixVisibleSql('$1')}`, [viewer, unique]);
  return presentMixes(db, rows, viewer, lite, ids);
}

/** Summary rows as mixes, with the chats each is shared into; `order` keeps an order (by id). */
export async function presentMixes(db: Q, rows: Row[], viewer: string | null, lite = false, order?: string[]): Promise<Mix[]> {
  const chats = await mixChats(db, rows, viewer);
  const mixes = rows.map((r) => toMix(r, viewer, chats.get(r.id) ?? [], lite));
  if (!order) return mixes;
  const byId = new Map(mixes.map((m) => [m.id, m]));
  return order.map((id) => byId.get(id)).filter((m): m is Mix => !!m);
}

/** Cards for mixes on posts or in chats: the mix while the viewer may see it, otherwise a note that it isn't there. */
export async function mixCards(db: Q, ids: string[], viewer: string | null): Promise<Map<string, MixCard>> {
  const seen = new Map((await loadMixes(db, ids, viewer)).map((m) => [m.id, m]));
  return new Map(
    [...new Set(ids)].map((id) => {
      const m = seen.get(id);
      return [id, m ? { available: true as const, ...m } : { id, available: false as const }];
    }),
  );
}

/** The mix cards among these chat messages (by message id), as the reader sees them. */
export async function mixCardsForMessages(db: Q, messageIds: string[], reader: string): Promise<Map<string, MixCard>> {
  if (!messageIds.length) return new Map();
  const { rows } = await db.query<{ id: string; mix_id: string }>(
    `SELECT m.id, m.meta->>'mixId' AS mix_id FROM messages m WHERE m.id = ANY($1::uuid[]) AND m.kind = 'message' AND m.meta ? 'mixId'`,
    [messageIds],
  );
  if (!rows.length) return new Map();
  const cards = await mixCards(
    db,
    rows.map((r) => r.mix_id),
    reader,
  );
  return new Map(rows.map((r) => [r.id, cards.get(r.mix_id) ?? { id: r.mix_id, available: false }]));
}

/** The Mixes tab shows on a profile while the viewer may see at least one of that person's mixes. */
export async function hasMixesTab(db: Q, owner: string, viewer: string | null): Promise<boolean> {
  const { rows } = await db.query(`SELECT EXISTS (SELECT 1 ${MIX_FROM} WHERE mx.owner_id = $2 AND ${mixVisibleSql('$1')}) AS shown`, [viewer, owner]);
  return !!rows[0]?.shown;
}

// ── Songs ────────────────────────────────────────────────────────────────

/** A catalogue song's licence and state, and whether its provider is switched on here. */
export interface SongCheck {
  licence: MusicLicence;
  status: 'active' | 'withdrawn' | 'paused';
  providerOn: boolean;
}

/**
 * Why a catalogue song can't play or be added for this person, or null when it can. `commercial`:
 * the mix's owner has a business account, so only songs cleared for business use play.
 */
export function songUnavailable(t: SongCheck, who: { countries: string[]; commercial: boolean }): Exclude<MixSongUnavailable, 'hidden'> | null {
  if (t.status === 'withdrawn') return 'withdrawn';
  if (t.status === 'paused' || !t.providerOn) return 'unavailable';
  const block = licenceBlock(t.licence, { commercial: who.commercial, countries: who.countries });
  if (!block) return null;
  if (block === 'region') return 'region';
  if (block === 'commercial') return 'commercial';
  if (block === 'expired') return 'withdrawn';
  return 'unavailable';
}

/**
 * A mix's songs in order, as the viewer gets them. Each catalogue song is checked again for the
 * viewer's countries and the owner's account type (no provider is called); a sound plays while the
 * viewer may see or use it. What plays is the start of the song, as long as its licence allows (at
 * most MUSIC_CLIP_MAX_MS); songs that can't play say why and have nothing to load.
 */
export async function mixSongs(
  db: Q,
  opts: { mixId: string; ownerBusiness: boolean; viewer: string | null; role: Mix['role']; providerOn: (provider: string) => boolean },
): Promise<MixSong[]> {
  const { rows } = await db.query(
    `SELECT ms.id, ms.track_id, ms.sound_id, ms.added_by, ms.created_at,
            pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')},
            ab.status AS a_status,
            CASE WHEN ms.added_by IS NOT NULL THEN NOT ${notBlockedSql('ms.added_by', '$1::uuid')} END AS a_blocked,
            mt.provider, mt.title AS t_title, mt.artist AS t_artist, mt.cover_url AS t_cover, mt.preview_url AS t_preview, mt.licence AS t_licence,
            mt.status AS t_status, mt.duration_ms AS t_duration,
            s.title AS s_title, so.display_name AS s_artist, sm.poster_url AS s_cover, coalesce(sm.variants->>'mp4', sm.url) AS s_audio,
            coalesce(s.duration_ms, sm.duration_ms) AS s_duration,
            CASE WHEN s.id IS NOT NULL THEN (${soundVisibleSql('$1')} OR ${soundUsableSql('$1')}) END AS s_visible
     FROM mix_songs ms
     LEFT JOIN music_tracks mt ON mt.id = ms.track_id
     LEFT JOIN sounds s ON s.id = ms.sound_id
     LEFT JOIN media sm ON sm.id = s.media_id
     LEFT JOIN profiles so ON so.user_id = s.owner_id
     LEFT JOIN users ab ON ab.id = ms.added_by
     LEFT JOIN profiles pr ON pr.user_id = ms.added_by
     WHERE ms.mix_id = $2
     ORDER BY ms.position, ms.id`,
    [opts.viewer, opts.mixId],
  );
  const countries = rows.some((r) => r.track_id) ? await viewerCountries(db, opts.viewer) : [];
  return rows.map((r): MixSong => {
    const former = !r.added_by || r.a_status === 'deleted';
    const addedBy = !former && r.a_status === 'active' && !r.a_blocked ? publicUserFrom(r, 'a_') : null;
    const base = {
      id: r.id as string,
      addedBy,
      ...(former ? { addedByFormer: true } : {}),
      addedAt: (r.created_at as Date).toISOString(),
      canRemove: opts.role === 'owner' || (opts.role === 'collaborator' && r.added_by === opts.viewer),
    };
    if (r.track_id) {
      const licence = r.t_licence as MusicLicence;
      const unavailable = songUnavailable(
        { licence, status: r.t_status, providerOn: opts.providerOn(r.provider) },
        { countries, commercial: opts.ownerBusiness },
      );
      const part = Math.min(maxClipMs(licence), r.t_duration ?? Infinity);
      return {
        ...base,
        source: r.provider as MusicSource,
        musicId: r.track_id,
        title: r.t_title,
        artist: r.t_artist,
        coverUrl: r.t_cover ?? null,
        durationMs: r.t_duration ?? null,
        licenceName: licence.name,
        attribution: licence.attribution ?? null,
        play: !unavailable && r.t_preview ? { audioUrl: r.t_preview, startMs: 0, durationMs: part } : null,
        ...(unavailable ? { unavailable } : r.t_preview ? {} : { unavailable: 'unavailable' as const }),
      };
    }
    if (!r.s_visible)
      return {
        ...base,
        source: 'library',
        musicId: r.sound_id,
        title: '',
        artist: '',
        coverUrl: null,
        durationMs: null,
        licenceName: null,
        attribution: null,
        play: null,
        unavailable: 'hidden',
      };
    const part = Math.min(MUSIC_CLIP_MAX_MS, r.s_duration ?? Infinity);
    return {
      ...base,
      source: 'library',
      musicId: r.sound_id,
      title: r.s_title,
      artist: r.s_artist ?? '',
      coverUrl: r.s_cover ?? null,
      durationMs: r.s_duration ?? null,
      licenceName: null,
      attribution: null,
      play: r.s_audio ? { audioUrl: r.s_audio, startMs: 0, durationMs: part } : null,
      ...(r.s_audio ? {} : { unavailable: 'unavailable' as const }),
    };
  });
}

// ── Chats ────────────────────────────────────────────────────────────────

/** The chats a mix is shared into where `userId` is still a member and its card is still there. */
async function chatsWith(db: Q, mixId: string, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ conversation_id: string }>(
    `SELECT mc.conversation_id FROM mix_chats mc
     JOIN conversation_members cm ON cm.conversation_id = mc.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL
     JOIN messages card ON card.id = mc.message_id AND card.deleted_at IS NULL AND (card.expires_at IS NULL OR card.expires_at > now())
     WHERE mc.mix_id = $1`,
    [mixId, userId],
  );
  return rows.map((r) => r.conversation_id);
}

/**
 * Songs were added to a mix: a line in each chat it's shared into that the person who added them
 * is in ("Ada added 3 songs to Road trip"). More adds by the same person within
 * MIX_LINE_WINDOW_MINUTES raise that line's count instead of writing another. Lines follow each
 * chat's disappearing setting, and go live to everyone there who sees the person who added them.
 */
export async function noteSongsAdded(deps: MixDeps, mix: { id: string; title: string }, userId: string, count: number): Promise<void> {
  if (count < 1) return;
  for (const conversationId of await chatsWith(deps.db, mix.id, userId)) {
    const done = await tx(deps.db, async (c) => {
      // One writer per person, mix and chat at a time, so two quick adds share a line.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`mix-line:${conversationId}:${userId}:${mix.id}`]);
      const recent = (
        await c.query<{ id: string }>(
          `SELECT id FROM messages
           WHERE conversation_id = $1 AND sender_id = $2 AND kind = 'system' AND meta->>'type' = 'mix' AND meta->>'mixId' = $3
             AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND created_at > now() - make_interval(mins => $4)
           ORDER BY created_at DESC LIMIT 1`,
          [conversationId, userId, mix.id, MIX_LINE_WINDOW_MINUTES],
        )
      ).rows[0];
      if (recent) {
        const { rows } = await c.query<{ meta: MessageSystemInfo }>(
          `UPDATE messages SET meta = meta || jsonb_build_object('count', coalesce((meta->>'count')::int, 0) + $2, 'title', $3::text)
           WHERE id = $1 RETURNING meta`,
          [recent.id, count, mix.title],
        );
        return { kind: 'updated' as const, id: recent.id, system: rows[0]!.meta };
      }
      const meta: MessageSystemInfo = { type: 'mix', mixId: mix.id, title: mix.title, count };
      const seconds: number | null =
        (await c.query(`SELECT disappearing_seconds FROM conversations WHERE id = $1`, [conversationId])).rows[0]?.disappearing_seconds ?? null;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_id, body, kind, meta, expires_at)
         VALUES ($1,$2,'','system',$3, now() + make_interval(secs => $4::int)) RETURNING id`,
        [conversationId, userId, meta, seconds],
      );
      const id = rows[0]!.id;
      if (seconds) await enqueue(c, 'messages.expire', { messageId: id }, seconds + 1);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      return { kind: 'created' as const, id };
    });
    if (done.kind === 'created') await publishLine(deps, done.id);
    else
      await deps.realtime.publish(await readersOf(deps.db, conversationId, userId), {
        type: 'message.system',
        data: { id: done.id, conversationId, system: done.system },
      });
  }
}

/**
 * Tell everyone who may add to a mix that it changed (songs, order, name): the owner and the people
 * in the chats it's shared into who haven't blocked the owner. They load it again, as they see it.
 */
export async function publishMixChanged(deps: MixDeps, mixId: string, ownerId: string): Promise<void> {
  const { rows } = await deps.db.query<{ user_id: string; conversation_id: string }>(
    `SELECT DISTINCT cm.user_id, mc.conversation_id FROM mix_chats mc
     JOIN conversation_members cm ON cm.conversation_id = mc.conversation_id AND cm.left_at IS NULL
     WHERE mc.mix_id = $1 AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = $2)`,
    [mixId, ownerId],
  );
  const users = [...new Set([ownerId, ...rows.map((r) => r.user_id)])];
  await deps.realtime.publish(users, { type: 'mix.updated', data: { mixId, conversationIds: [...new Set(rows.map((r) => r.conversation_id))] } });
}
