import type { Pool, PoolClient } from 'pg';
import { licenceBlock, type MusicLicence, type MusicSource, type MusicUnavailable, type PostMusic } from '@yapilapi/shared';
import { REQUEST_COUNTRY } from '../request-context.ts';

type Q = Pool | PoolClient;

/**
 * Music as a viewer gets it, checked again at view time from what is stored here (no provider is
 * called while people scroll): a song the provider withdrew, whose licence ended, or whose provider
 * is switched off plays silently with a note; one the viewer's country can't play says so, quietly.
 */

/** The part a post or story plays, as stored. */
export interface StoredPart {
  startMs: number;
  durationMs: number;
}

/** The countries known for a viewer: the one they chose, the one the network reported for their account, and this request's. */
export async function viewerCountries(db: Q, viewer: string | null): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT (SELECT country FROM profiles WHERE user_id = $1) AS chosen, (SELECT cdn_country FROM profiles WHERE user_id = $1) AS cdn, ${REQUEST_COUNTRY} AS req`,
    [viewer],
  );
  const r = rows[0] ?? {};
  return [...new Set([r.chosen, r.cdn, r.req].filter((c): c is string => typeof c === 'string').map((c) => c.trim()))];
}

/** A catalogue song as stored (music_tracks), with the part it plays. */
export interface TrackRow {
  id: string;
  provider: string;
  title: string;
  artist: string;
  cover_url: string | null;
  preview_url: string | null;
  licence: MusicLicence;
  status: 'active' | 'withdrawn' | 'paused';
}

/** Why a stored song doesn't play for this viewer (null when it does). `commercial`: the post's author is a business account. */
export function trackUnavailable(row: Pick<TrackRow, 'licence' | 'status'>, ctx: { countries: string[]; commercial: boolean }): MusicUnavailable | null {
  if (row.status === 'withdrawn') return 'withdrawn';
  if (row.status === 'paused') return 'unavailable';
  const block = licenceBlock(row.licence, { commercial: ctx.commercial, countries: ctx.countries });
  if (!block) return null;
  if (block === 'region') return 'region';
  if (block === 'expired') return 'withdrawn';
  return 'unavailable';
}

/** A catalogue song on a post, for a viewer. */
export function trackMusic(row: TrackRow, part: StoredPart, ctx: { countries: string[]; commercial: boolean }): PostMusic {
  const unavailable = trackUnavailable(row, ctx);
  return {
    source: row.provider as MusicSource,
    id: row.id,
    title: row.title,
    artist: row.artist,
    coverUrl: row.cover_url,
    audioUrl: unavailable ? null : row.preview_url,
    startMs: part.startMs,
    durationMs: part.durationMs,
    style: 'compact',
    licenceName: row.licence.name,
    licenceUrl: row.licence.url,
    attribution: row.licence.attribution,
    ...(unavailable ? { unavailable } : {}),
  };
}

/** Catalogue songs by id, as stored. */
export async function tracksByIds(db: Q, ids: string[]): Promise<Map<string, TrackRow>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<TrackRow>(
    `SELECT id, provider, title, artist, cover_url, preview_url, licence, status FROM music_tracks WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((r) => [r.id, r]));
}
