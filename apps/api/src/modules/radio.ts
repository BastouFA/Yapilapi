import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  normalizeTag,
  RADIO_NEAR_KM,
  RADIO_PAGE,
  RADIO_PAGE_MAX,
  RADIO_SKIP_DAYS,
  RADIO_STATIONS,
  type Post,
  type RadioStationInfo,
  type RadioStationKind,
} from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { badRequest, featureDisabled, notFound, parse } from '../lib/errors.ts';
import { hydratePosts } from '../lib/posts.ts';
import { rankedPage } from '../lib/ranking.ts';
import { isEnabled, personalizationAllowed } from '../lib/services.ts';
import { readerLanguages } from '../lib/translation.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql, squadMemberSql } from '../lib/visibility.ts';
import { yapDistributableSql } from '../lib/voice.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { PERSONAL_FILTERS } from './posts.ts';

/**
 * Yap Radio (docs/product/yap-radio.md): press play once and listen hands-free, one Yap after
 * another, like radio. Each station answers with its next Yaps in order and a cursor:
 *
 * - `for_you`: the recommender's Yap ranking (the Yaps filter on Pulse, lib/ranking.ts).
 * - `friends`: people you follow and your friends, newest first.
 * - `near`: Yaps tagged at places near you (`lat`/`lng`, rounded by the apps) or in your profile's city.
 * - `topics`: the #tags you follow, or the one in `key`.
 * - `squad`: one of your squads (members only).
 * - `person`: one person's Yaps ("Play as radio" on a profile).
 * - `place`: one place's Yaps.
 *
 * Every station plays only Yaps the listener may see and open (audiences, squads, blocks, regional
 * rules, moderation), never one they finished anywhere or quickly skipped on the radio lately, never
 * one whose words were held by the checks, and, outside the people they follow and their squads,
 * only Yaps whose words passed the checks (or will never have any): what the recommender may suggest.
 * Their own Yaps play only on their own profile's station.
 */

const stationParam = z.object({ station: z.enum(RADIO_STATIONS) });
const radioQuery = z.object({
  key: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(RADIO_PAGE_MAX).default(RADIO_PAGE),
  start: z.string().uuid().optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});
type RadioQuery = z.infer<typeof radioQuery>;
const UUID = z.string().uuid();

const POST_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;

/** A Yap the viewer ($1) may hear on the radio: visible, open to them, with a playable clip, not held, not finished or lately skipped. */
const PLAYABLE = `p.format = 'yap' AND ${postVisibleSql('$1')} AND ${postUnlockedSql('$1')} ${PERSONAL_FILTERS}
  AND EXISTS (SELECT 1 FROM post_media rpm JOIN voice_clips rvc ON rvc.media_id = rpm.media_id JOIN media rm ON rm.id = rpm.media_id
              WHERE rpm.post_id = p.id AND rm.moderation <> 'blocked' AND (rvc.screened IS NULL OR rvc.screened <> 'held'))
  AND NOT EXISTS (SELECT 1 FROM feed_events rfe WHERE rfe.user_id = $1 AND rfe.post_id = p.id
                    AND (rfe.kind = 'listen_complete' OR (rfe.kind = 'skip' AND rfe.surface = 'radio' AND rfe.created_at > now() - interval '${RADIO_SKIP_DAYS} days')))`;
/** Stations beyond the people you follow: only what the recommender may suggest (lib/voice.ts). */
const SUGGESTABLE = yapDistributableSql('p');
const NOT_OWN = `p.author_id <> $1`;

/** What a station plays, as SQL over posts `p` (the viewer is $1), and its name. */
interface Scope {
  info: RadioStationInfo;
  where: string;
  params: unknown[];
  /** Near you without a place to go by: nothing to play until the listener gives one. */
  needsPlace?: boolean;
}

export default async function radioModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const on = async () => {
    if (!(await isEnabled(db, 'YAPS'))) throw featureDisabled('Yaps');
    if (!(await isEnabled(db, 'YAP_RADIO'))) throw featureDisabled('Yap Radio');
  };

  /** The stations offered to you: the four main ones, then your squads and the tags you follow. */
  app.get('/v1/radio', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const main: RadioStationInfo[] = (['for_you', 'friends', 'near', 'topics'] as const).map((kind) => ({ kind, key: null, title: null }));
    const [squads, tags] = await Promise.all([
      (await isEnabled(db, 'SQUADS'))
        ? db.query<{ id: string; name: string }>(
            `SELECT s.id, s.name FROM squads s JOIN squad_members sm ON sm.squad_id = s.id
             WHERE sm.user_id = $1 AND sm.status = 'active' ORDER BY s.updated_at DESC LIMIT 20`,
            [u.id],
          )
        : { rows: [] },
      db.query<{ slug: string }>(
        `SELECT tp.slug FROM user_interests ui JOIN topics tp ON tp.id = ui.topic_id WHERE ui.user_id = $1 ORDER BY tp.slug LIMIT 20`,
        [u.id],
      ),
    ]);
    return {
      stations: [
        ...main,
        ...squads.rows.map((s): RadioStationInfo => ({ kind: 'squad', key: s.id, title: s.name })),
        ...tags.rows.map((t): RadioStationInfo => ({ kind: 'topics', key: t.slug, title: `#${t.slug}` })),
      ],
    };
  });

  /** A station's next Yaps, in the order to play them. `start` (a Yap) goes first when it belongs here: where you left off. */
  app.get('/v1/radio/:station', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const { station } = parse(stationParam, req.params);
    const q = parse(radioQuery, req.query);
    if (station === 'for_you') return forYou(u.id, q);
    const scope = await scopeOf(u.id, station, q);
    if (scope.needsPlace) return { station: scope.info, items: [], following: [], nextCursor: null, needsPlace: true };
    const c = q.cursor ? decodeCursor<KeyCursor>(q.cursor) : null;
    const params = [u.id, ...scope.params];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const first = !c && q.start ? await startsHere(u.id, scope, q.start) : null;
    const skip = first ? `AND p.id <> ${add(first)}` : '';
    const after = c ? `AND (p.created_at, p.id) < (${add(c.t)}::timestamptz, ${add(c.id)}::uuid)` : '';
    const limit = add(q.limit + 1 - (first ? 1 : 0));
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `SELECT p.id, p.created_at ${POST_FROM} WHERE ${PLAYABLE} AND ${scope.where} ${skip} ${after}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`,
      params,
    );
    const room = q.limit - (first ? 1 : 0);
    const page = rows.slice(0, room);
    return {
      station: scope.info,
      ...(await playable(u.id, [...(first ? [first] : []), ...page.map((r) => r.id)])),
      nextCursor: rows.length > room && page.length ? keyCursorOf(page.at(-1)!) : null,
    };
  });

  /** For you: ranked like the Yaps filter (surface 'radio', kept for the next pages like Pulse's), without what was heard already. */
  async function forYou(userId: string, q: RadioQuery) {
    const prefs =
      (await db.query<{ reduced_recommendations: boolean }>(`SELECT reduced_recommendations FROM user_preferences WHERE user_id = $1`, [userId])).rows[0] ??
      null;
    // Appended to the ranking's own rules (with the viewer as $1); PLAYABLE brings the personal filters.
    const personal = `AND ${NOT_OWN} AND ${SUGGESTABLE} AND ${PLAYABLE}`;
    const ranked = await rankedPage(
      db,
      {
        userId,
        surface: 'radio',
        personalized: await personalizationAllowed(db, userId),
        personal,
        reduced: !!prefs?.reduced_recommendations,
        reader: await readerLanguages(db, userId, ctx.ai.machineTranslation),
      },
      q.cursor,
      q.limit,
    );
    const info: RadioStationInfo = { kind: 'for_you', key: null, title: null };
    const first = !q.cursor && q.start ? await startsHere(userId, { info, where: `${NOT_OWN} AND ${SUGGESTABLE}`, params: [] }, q.start) : null;
    const ids = [...(first ? [first] : []), ...ranked.items.map((x) => x.id).filter((id) => id !== first)];
    return { station: info, ...(await playable(userId, ids)), nextCursor: ranked.nextCursor };
  }

  /** `start` when it is a Yap this station would play the viewer now, else null. */
  async function startsHere(userId: string, scope: Scope, start: string): Promise<string | null> {
    const params = [userId, ...scope.params, start];
    const { rows } = await db.query(`SELECT p.id ${POST_FROM} WHERE p.id = $${params.length} AND ${PLAYABLE} AND ${scope.where}`, params);
    return rows[0]?.id ?? null;
  }

  /** The posts, in order, as the apps show them (only ones that came back with a clip to play), and which of their speakers the viewer follows. */
  async function playable(userId: string, ids: string[]): Promise<{ items: Post[]; following: string[] }> {
    const items = (await hydratePosts(db, ids, userId)).filter((p) => p.format === 'yap' && !!p.voice && !p.locked);
    const authors = [...new Set(items.map((p) => p.author.id))];
    const following = authors.length
      ? (
          await db.query<{ id: string }>(`SELECT followee_id AS id FROM follows WHERE follower_id = $1 AND followee_id = ANY($2::uuid[])`, [userId, authors])
        ).rows.map((r) => r.id)
      : [];
    return { items, following };
  }

  /** What each station other than For you plays (its station params start at $2). */
  async function scopeOf(userId: string, station: Exclude<RadioStationKind, 'for_you'>, q: RadioQuery): Promise<Scope> {
    const key = q.key ?? null;
    switch (station) {
      case 'friends':
        return {
          info: { kind: 'friends', key: null, title: null },
          where: `${NOT_OWN} AND p.community_id IS NULL AND p.author_id IN (
                    SELECT followee_id FROM follows WHERE follower_id = $1
                    UNION SELECT user_b FROM friendships WHERE user_a = $1
                    UNION SELECT user_a FROM friendships WHERE user_b = $1)`,
          params: [],
        };
      case 'near': {
        const info: RadioStationInfo = { kind: 'near', key: null, title: null };
        const there = `${NOT_OWN} AND ${SUGGESTABLE} AND p.place_id IS NOT NULL`;
        if (q.lat !== undefined && q.lng !== undefined) {
          // A box around the listener (the apps send it rounded to about 100 m): fine for picking what's near.
          const dLat = RADIO_NEAR_KM / 111;
          const dLng = RADIO_NEAR_KM / (111 * Math.max(0.05, Math.cos((q.lat * Math.PI) / 180)));
          return {
            info,
            where: `${there} AND EXISTS (SELECT 1 FROM places rpl WHERE rpl.id = p.place_id AND rpl.deleted_at IS NULL
                      AND rpl.lat BETWEEN $2 AND $3 AND rpl.lng BETWEEN $4 AND $5)`,
            params: [q.lat - dLat, q.lat + dLat, q.lng - dLng, q.lng + dLng],
          };
        }
        const city = (await db.query<{ city: string | null }>(`SELECT city FROM profiles WHERE user_id = $1`, [userId])).rows[0]?.city?.trim();
        if (!city) return { info, where: 'false', params: [], needsPlace: true };
        return {
          info: { ...info, title: city },
          where: `${there} AND EXISTS (SELECT 1 FROM places rpl WHERE rpl.id = p.place_id AND rpl.deleted_at IS NULL AND lower(rpl.city) = lower($2))`,
          params: [city],
        };
      }
      case 'topics': {
        if (key) {
          const tag = normalizeTag(key);
          if (!/^[\p{L}\p{M}\p{N}_]{2,40}$/u.test(tag)) throw badRequest('That is not a hashtag.');
          return {
            info: { kind: 'topics', key: tag, title: `#${tag}` },
            where: `${NOT_OWN} AND ${SUGGESTABLE} AND p.topics @> ARRAY[$2::text]`,
            params: [tag],
          };
        }
        return {
          info: { kind: 'topics', key: null, title: null },
          where: `${NOT_OWN} AND ${SUGGESTABLE} AND p.topics && coalesce((SELECT array_agg(tp.slug) FROM user_interests ui JOIN topics tp ON tp.id = ui.topic_id
                                                                          WHERE ui.user_id = $1), '{}'::text[])`,
          params: [],
        };
      }
      case 'squad': {
        if (!(await isEnabled(db, 'SQUADS'))) throw featureDisabled('Squads');
        const id = UUID.safeParse(key);
        if (!id.success) throw notFound('Squad');
        const s = (await db.query<{ name: string }>(`SELECT s.name FROM squads s WHERE s.id = $1 AND ${squadMemberSql('s.id', '$2')}`, [id.data, userId]))
          .rows[0];
        if (!s) throw notFound('Squad');
        return {
          info: { kind: 'squad', key: id.data, title: s.name },
          where: `${NOT_OWN} AND p.visibility = 'squad' AND p.squad_id = $2`,
          params: [id.data],
        };
      }
      case 'person': {
        if (!key) throw notFound('User');
        const p = (
          await db.query<{ user_id: string; username: string; display_name: string; followed: boolean }>(
            `SELECT pr.user_id, pr.username, pr.display_name,
                    (pr.user_id = $2 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.followee_id = pr.user_id)) AS followed
             FROM profiles pr JOIN users us ON us.id = pr.user_id
             WHERE lower(pr.username) = lower($1) AND us.status = 'active' AND ${notBlockedSql('pr.user_id', '$2')}`,
            [key, userId],
          )
        ).rows[0];
        if (!p) throw notFound('User');
        return {
          info: { kind: 'person', key: p.username, title: p.display_name },
          // Someone you don't follow: what the recommender may suggest of theirs.
          where: `p.author_id = $2 ${p.followed ? '' : `AND ${SUGGESTABLE}`}`,
          params: [p.user_id],
        };
      }
      case 'place': {
        const id = UUID.safeParse(key);
        if (!id.success) throw notFound('Place');
        const pl = (await db.query<{ name: string }>(`SELECT name FROM places WHERE id = $1 AND deleted_at IS NULL`, [id.data])).rows[0];
        if (!pl) throw notFound('Place');
        return { info: { kind: 'place', key: id.data, title: pl.name }, where: `${NOT_OWN} AND ${SUGGESTABLE} AND p.place_id = $2`, params: [id.data] };
      }
    }
  }
}
