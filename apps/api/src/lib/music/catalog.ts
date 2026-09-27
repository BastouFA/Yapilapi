import type { Pool, PoolClient } from 'pg';
import {
  licenceBlock,
  maxClipMs,
  storyMusicPart,
  type MusicLicence,
  type MusicSource,
  type MusicSourceInfo,
  type MusicTab,
  type MusicTrack,
} from '@yapilapi/shared';
import { AppError, notFound } from '../errors.ts';
import { REQUEST_COUNTRY } from '../request-context.ts';
import { assertSoundUsable } from '../sounds.ts';
import { libraryByIds, libraryFromFollows, librarySearch } from './library.ts';
import { ProviderError, type MusicProvider, type ProviderTrack } from './types.ts';

type Q = Pool | PoolClient;

/** Search and trending answers from a provider are reused for this long (metadata only). */
const LIST_CACHE_MS = 10 * 60_000;
const LIST_CACHE_MAX = 500;
/** A song's metadata and licence are read again from its provider after this long (see refresh). */
export const TRACK_REFRESH_MS = 24 * 60 * 60_000;
/** At publish time the provider is asked again; if it can't be reached, metadata this fresh is trusted. */
const PUBLISH_GRACE_MS = 60 * 60_000;

/** Who is using or looking at music: business accounts need songs cleared for commercial use; countries decide the rest. */
export interface MusicWho {
  commercial: boolean;
  countries: string[];
}

/** Music checked for a new post, reel or story: a sound or a catalogue song, and the part that plays. */
export interface PreparedMusic {
  soundId: string | null;
  trackId: string | null;
  stored: { startMs: number; durationMs: number };
}

interface TrackDbRow {
  id: string;
  provider: string;
  external_id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  cover_url: string | null;
  preview_url: string | null;
  licence: MusicLicence;
  status: 'active' | 'withdrawn' | 'paused';
  fetched_at: Date;
  uses?: number;
  saved?: boolean;
}

/**
 * The music catalogue: the in-app sounds library plus every enabled provider, behind one search.
 * It caches provider metadata (never audio), checks each song's licence for the person using it, and
 * checks again at publish time; view-time checks read what is stored (lib/music/view.ts).
 */
export class MusicCatalog {
  private listCache = new Map<string, { at: number; ids: string[] }>();

  constructor(
    private readonly db: Pool,
    readonly providers: MusicProvider[],
    private readonly log: (msg: string, err?: unknown) => void = () => {},
  ) {}

  provider(id: string): MusicProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  private enabled(): MusicProvider[] {
    return this.providers.filter((p) => p.enabled);
  }

  /** The sources the picker lists: original sounds (always on) and each provider, on or off. The dev tones only show while on. */
  sources(): MusicSourceInfo[] {
    return [
      { id: 'library', label: 'Original sounds', kind: 'original', enabled: true },
      ...this.providers.filter((p) => p.kind !== 'dev' || p.enabled).map((p) => ({ id: p.id, label: p.label, kind: p.kind, enabled: p.enabled })),
    ];
  }

  /** A person's account type and known countries. */
  async who(userId: string | null, db: Q = this.db): Promise<MusicWho> {
    const { rows } = await db.query(
      `SELECT (SELECT mode FROM profiles WHERE user_id = $1) AS mode, (SELECT country FROM profiles WHERE user_id = $1) AS chosen,
              (SELECT cdn_country FROM profiles WHERE user_id = $1) AS cdn, ${REQUEST_COUNTRY} AS req`,
      [userId],
    );
    const r = rows[0] ?? {};
    return {
      commercial: r.mode === 'business',
      countries: [...new Set([r.chosen, r.cdn, r.req].filter((c): c is string => typeof c === 'string').map((c) => c.trim()))],
    };
  }

  // ── Listing ────────────────────────────────────────────────────────────

  /**
   * The picker's list: a search across every enabled source, or a tab. Business accounts only get
   * songs cleared for commercial use, and nobody gets songs their country can't use; saved songs that
   * can't be used any more are still listed, with the reason.
   */
  async list(viewer: string, opts: { q: string; tab: MusicTab; source?: MusicSource; limit: number }): Promise<MusicTrack[]> {
    const who = await this.who(viewer);
    const q = opts.q.trim();
    const wants = (s: MusicSource) => !opts.source || opts.source === s;
    const providers = this.enabled().filter((p) => wants(p.id));
    const query = { limit: opts.limit, commercialOnly: who.commercial, country: who.countries[0] ?? null };
    let lists: MusicTrack[][];

    if (opts.tab === 'saved') {
      const { rows } = await this.db.query<{ track_id: string | null; sound_id: string | null }>(
        `SELECT track_id, sound_id FROM music_saves WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [viewer],
      );
      const [sounds, tracks] = await Promise.all([
        wants('library')
          ? libraryByIds(
              this.db,
              rows.flatMap((r) => (r.sound_id ? [r.sound_id] : [])),
              viewer,
            )
          : [],
        this.byIds(
          rows.flatMap((r) => (r.track_id ? [r.track_id] : [])),
          viewer,
          who,
        ),
      ]);
      const all = new Map<string, MusicTrack>([...sounds, ...tracks.filter((t) => wants(t.source))].map((t) => [t.id, t]));
      const saved = rows.map((r) => all.get((r.sound_id ?? r.track_id)!)).filter((t): t is MusicTrack => !!t);
      return (q ? saved.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q.toLowerCase())) : saved).slice(0, opts.limit);
    }

    if (opts.tab === 'original' || opts.source === 'library') {
      return libraryByIds(this.db, await librarySearch(this.db, viewer, q, opts.limit), viewer);
    }

    if (q) {
      // Everything that matches, from every source, interleaved.
      const fromProviders = providers.map((p) => this.cachedIds(p, 'search', q, query.commercialOnly, query.country, () => p.search(q, query)));
      const [lib, ...external] = await Promise.all([
        wants('library') ? librarySearch(this.db, viewer, q, Math.ceil(opts.limit / 2)) : Promise.resolve([]),
        ...fromProviders,
      ]);
      lists = [await libraryByIds(this.db, lib, viewer), ...(await Promise.all(external.map((ids) => this.byIds(ids, viewer, who))))];
    } else {
      const trending = await Promise.all(providers.map((p) => this.cachedIds(p, 'trending', '', query.commercialOnly, query.country, () => p.trending(query))));
      const [popularHere, lib, followed] = await Promise.all([
        this.popularTracks(opts.limit, opts.source),
        wants('library') ? librarySearch(this.db, viewer, '', Math.ceil(opts.limit / 2)) : Promise.resolve([]),
        opts.tab === 'for_you' ? this.followedIds(viewer, opts.limit, opts.source) : Promise.resolve({ tracks: [], sounds: [] }),
      ]);
      lists = [
        ...(opts.tab === 'for_you'
          ? [await this.byIds(followed.tracks, viewer, who), wants('library') ? await libraryByIds(this.db, followed.sounds, viewer) : []]
          : []),
        await this.byIds(popularHere, viewer, who),
        ...(await Promise.all(trending.map((ids) => this.byIds(ids, viewer, who)))),
        await libraryByIds(this.db, lib, viewer),
      ];
    }
    return interleave(
      lists.map((l) => l.filter((t) => t.canUse)),
      opts.limit,
    );
  }

  /** One catalogue song, as the picker shows it (null when it doesn't exist). */
  async track(id: string, viewer: string | null): Promise<MusicTrack | null> {
    const who = await this.who(viewer);
    return (await this.byIds([id], viewer, who))[0] ?? null;
  }

  /** Catalogue songs by id (in order), with the viewer's saves and whether they may use each. */
  async byIds(ids: string[], viewer: string | null, who: MusicWho): Promise<MusicTrack[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.query<TrackDbRow>(
      `SELECT t.*,
              (SELECT count(*) FROM posts p WHERE p.music_track_id = t.id AND p.deleted_at IS NULL AND p.status = 'published')::int
                + (SELECT count(*) FROM moments m WHERE m.music_track_id = t.id AND m.deleted_at IS NULL)::int AS uses,
              EXISTS (SELECT 1 FROM music_saves ms WHERE ms.track_id = t.id AND ms.user_id = $2) AS saved
       FROM music_tracks t WHERE t.id = ANY($1::uuid[])`,
      [ids, viewer],
    );
    const byId = new Map(rows.map((r) => [r.id, this.toTrack(r, who)]));
    return ids.map((id) => byId.get(id)).filter((t): t is MusicTrack => !!t);
  }

  private toTrack(r: TrackDbRow, who: MusicWho): MusicTrack {
    const providerOn = !!this.provider(r.provider)?.enabled;
    const blocked =
      r.status === 'withdrawn'
        ? ('withdrawn' as const)
        : r.status === 'paused' || !providerOn
          ? ('unavailable' as const)
          : licenceBlock(r.licence, { commercial: who.commercial, countries: who.countries });
    return {
      source: r.provider as MusicSource,
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      durationMs: r.duration_ms,
      coverUrl: r.cover_url,
      previewUrl: blocked ? null : r.preview_url,
      licence: r.licence,
      attribution: r.licence.attribution ?? `${r.title} by ${r.artist} · ${r.licence.name}`,
      maxClipMs: maxClipMs(r.licence),
      uses: r.uses ?? 0,
      saved: !!r.saved,
      canUse: !blocked,
      ...(blocked ? { blocked } : {}),
    };
  }

  /** Catalogue songs used most here in the last 30 days (posts, reels and stories). */
  private async popularTracks(limit: number, source?: MusicSource): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT u.id FROM (
         SELECT music_track_id AS id FROM posts WHERE music_track_id IS NOT NULL AND deleted_at IS NULL AND status = 'published' AND created_at > now() - interval '30 days'
         UNION ALL
         SELECT music_track_id FROM moments WHERE music_track_id IS NOT NULL AND deleted_at IS NULL AND created_at > now() - interval '30 days'
       ) u JOIN music_tracks t ON t.id = u.id
       WHERE t.status = 'active' AND ($2::text IS NULL OR t.provider = $2) AND t.provider = ANY($3::text[])
       GROUP BY u.id ORDER BY count(*) DESC, u.id LIMIT $1`,
      [limit, source ?? null, this.enabled().map((p) => p.id)],
    );
    return rows.map((r) => r.id);
  }

  /** Songs and sounds people you follow used lately. */
  private async followedIds(viewer: string, limit: number, source?: MusicSource): Promise<{ tracks: string[]; sounds: string[] }> {
    const [tracks, sounds] = await Promise.all([
      this.db.query<{ id: string }>(
        `SELECT u.id FROM (
           SELECT p.music_track_id AS id FROM posts p JOIN follows f ON f.followee_id = p.author_id AND f.follower_id = $1
           WHERE p.music_track_id IS NOT NULL AND p.deleted_at IS NULL AND p.status = 'published' AND p.created_at > now() - interval '30 days'
           UNION ALL
           SELECT m.music_track_id FROM moments m JOIN follows f ON f.followee_id = m.author_id AND f.follower_id = $1
           WHERE m.music_track_id IS NOT NULL AND m.deleted_at IS NULL AND m.created_at > now() - interval '30 days'
         ) u JOIN music_tracks t ON t.id = u.id
         WHERE t.status = 'active' AND ($3::text IS NULL OR t.provider = $3)
         GROUP BY u.id ORDER BY count(*) DESC, u.id LIMIT $2`,
        [viewer, limit, source ?? null],
      ),
      !source || source === 'library' ? libraryFromFollows(this.db, viewer, limit) : Promise.resolve([]),
    ]);
    return { tracks: tracks.rows.map((r) => r.id), sounds };
  }

  /** A provider's answer as catalogue ids, cached for a while; a provider that fails is left out (and logged). */
  private async cachedIds(
    p: MusicProvider,
    kind: 'search' | 'trending',
    q: string,
    commercialOnly: boolean,
    country: string | null,
    fetchTracks: () => Promise<ProviderTrack[]>,
  ): Promise<string[]> {
    const key = `${p.id}\u0000${kind}\u0000${q.toLowerCase()}\u0000${commercialOnly}\u0000${country ?? ''}`;
    const hit = this.listCache.get(key);
    if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.ids;
    try {
      const ids = await this.upsert(p.id, await fetchTracks());
      if (this.listCache.size >= LIST_CACHE_MAX) this.listCache.delete(this.listCache.keys().next().value!);
      this.listCache.set(key, { at: Date.now(), ids });
      return ids;
    } catch (e) {
      this.log(`music provider ${p.id} failed`, e);
      return hit?.ids ?? [];
    }
  }

  /** Keep provider metadata (never audio): new songs get an id, known ones are refreshed. Ids in the given order. */
  private async upsert(provider: string, tracks: ProviderTrack[], db: Q = this.db): Promise<string[]> {
    if (!tracks.length) return [];
    const { rows } = await db.query<{ id: string; external_id: string }>(
      `INSERT INTO music_tracks (provider, external_id, title, artist, album, duration_ms, cover_url, preview_url, licence)
       SELECT $1, x.external_id, x.title, x.artist, x.album, x.duration_ms, x.cover_url, x.preview_url, x.licence
       FROM jsonb_to_recordset($2::jsonb) AS x(external_id text, title text, artist text, album text, duration_ms int, cover_url text, preview_url text, licence jsonb)
       ON CONFLICT (provider, external_id) DO UPDATE SET
         title = EXCLUDED.title, artist = EXCLUDED.artist, album = EXCLUDED.album, duration_ms = EXCLUDED.duration_ms, cover_url = EXCLUDED.cover_url,
         preview_url = EXCLUDED.preview_url, licence = EXCLUDED.licence, status = 'active', withdrawn_at = NULL, fetched_at = now()
       RETURNING id, external_id`,
      [
        provider,
        JSON.stringify(
          dedupe(tracks, (t) => t.externalId).map((t) => ({
            external_id: t.externalId,
            title: t.title,
            artist: t.artist,
            album: t.album,
            duration_ms: t.durationMs,
            cover_url: t.coverUrl,
            preview_url: t.previewUrl,
            licence: t.licence,
          })),
        ),
      ],
    );
    const byExternal = new Map(rows.map((r) => [r.external_id, r.id]));
    return dedupe(tracks, (t) => t.externalId).flatMap((t) => (byExternal.has(t.externalId) ? [byExternal.get(t.externalId)!] : []));
  }

  // ── Saving ─────────────────────────────────────────────────────────────

  async save(userId: string, ref: { trackId?: string; soundId?: string }, on: boolean): Promise<void> {
    if (ref.trackId) {
      const exists = await this.db.query(`SELECT 1 FROM music_tracks WHERE id = $1`, [ref.trackId]);
      if (!exists.rowCount) throw notFound('That song');
    }
    if (on)
      await this.db.query(`INSERT INTO music_saves (user_id, track_id, sound_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
        userId,
        ref.trackId ?? null,
        ref.soundId ?? null,
      ]);
    else
      await this.db.query(`DELETE FROM music_saves WHERE user_id = $1 AND (track_id = $2 OR sound_id = $3)`, [
        userId,
        ref.trackId ?? null,
        ref.soundId ?? null,
      ]);
  }

  // ── Using a song ───────────────────────────────────────────────────────

  /**
   * Check music for a new post, reel or story (or a draft as it's published): the sound must be one
   * the author may use; a catalogue song is read again from its provider and its licence checked for
   * the author's account type and country and for the length of the part.
   */
  async prepareUse(
    userId: string,
    m: { soundId?: string; trackId?: string; startMs: number; durationMs: number },
    what: 'posts' | 'reels' | 'stories',
    db: Q = this.db,
  ): Promise<PreparedMusic> {
    if (m.soundId) {
      await assertSoundUsable(db, m.soundId, userId, what);
      const { rows } = await db.query(
        `SELECT coalesce(s.duration_ms, sm.duration_ms) AS ms FROM sounds s LEFT JOIN media sm ON sm.id = s.media_id WHERE s.id = $1`,
        [m.soundId],
      );
      return { soundId: m.soundId, trackId: null, stored: partOrThrow(m, (rows[0]?.ms as number | null) ?? null, 'sound') };
    }
    const row = await this.checkTrack(userId, m.trackId!, m.durationMs, db);
    return { soundId: null, trackId: row.id, stored: partOrThrow(m, row.duration_ms, 'song') };
  }

  /** Read a catalogue song again from its provider and check its licence for this author and part length. */
  async checkTrack(userId: string, trackId: string, clipMs: number, db: Q = this.db): Promise<TrackDbRow> {
    const row = (await db.query<TrackDbRow>(`SELECT * FROM music_tracks WHERE id = $1`, [trackId])).rows[0];
    if (!row) throw notFound('That song');
    const provider = this.provider(row.provider);
    if (!provider?.enabled) throw new AppError(422, 'music_unavailable', "This song isn't available right now. Choose another one.");
    if (row.status === 'withdrawn') throw new AppError(422, 'music_unavailable', 'This song is no longer available. Choose another one.');
    let current = row;
    try {
      const fresh = await provider.getTrack(row.external_id);
      if (!fresh) {
        await this.markWithdrawn(row.id, db);
        throw new AppError(422, 'music_unavailable', 'This song is no longer available. Choose another one.');
      }
      await this.upsert(row.provider, [fresh], db);
      current = { ...row, ...fromProvider(fresh), status: 'active' };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      this.log(`music provider ${row.provider} failed`, e);
      if (row.status !== 'active' || Date.now() - new Date(row.fetched_at).getTime() > PUBLISH_GRACE_MS)
        throw new AppError(503, 'music_unavailable', "Music can't be checked right now. Try again in a moment.");
    }
    const who = await this.who(userId, db);
    const block = licenceBlock(current.licence, { ...who, clipMs });
    if (block === 'commercial') throw new AppError(403, 'music_not_allowed', "This song isn't cleared for business accounts. Choose another one.");
    if (block === 'region') throw new AppError(403, 'music_not_allowed', "This song isn't available in your country. Choose another one.");
    if (block === 'expired') throw new AppError(422, 'music_unavailable', 'This song is no longer available. Choose another one.');
    if (block === 'clip')
      throw new AppError(400, 'validation_failed', 'Check the highlighted fields.', {
        fields: { 'music.durationMs': `This song can play for up to ${current.licence.maxClipSeconds} seconds.` },
      });
    return current;
  }

  private async markWithdrawn(id: string, db: Q = this.db) {
    await db.query(`UPDATE music_tracks SET status = 'withdrawn', withdrawn_at = coalesce(withdrawn_at, now()), fetched_at = now() WHERE id = $1`, [id]);
    this.listCache.clear();
  }

  // ── Keeping metadata current ───────────────────────────────────────────

  /**
   * Read songs in use (on posts, reels and stories, or saved) again from their providers once their
   * metadata is a day old. A song the provider no longer has is marked withdrawn: posts keep going,
   * silently, with a note. Songs whose provider is switched off here are paused, and come back when
   * it's on again. Run by the job worker.
   */
  async refresh(opts: { limit?: number; olderThanMs?: number } = {}): Promise<{ checked: number; withdrawn: number; paused: number }> {
    const { rows } = await this.db.query<TrackDbRow>(
      `SELECT t.* FROM music_tracks t
       WHERE t.status <> 'withdrawn' AND (t.status = 'paused' OR t.fetched_at < now() - make_interval(secs => $2::double precision / 1000))
         AND (EXISTS (SELECT 1 FROM posts p WHERE p.music_track_id = t.id AND p.deleted_at IS NULL)
              OR EXISTS (SELECT 1 FROM moments m WHERE m.music_track_id = t.id AND m.deleted_at IS NULL)
              OR EXISTS (SELECT 1 FROM music_saves s WHERE s.track_id = t.id))
       ORDER BY t.fetched_at LIMIT $1`,
      [opts.limit ?? 100, opts.olderThanMs ?? TRACK_REFRESH_MS],
    );
    let withdrawn = 0;
    let paused = 0;
    for (const row of rows) {
      const p = this.provider(row.provider);
      if (!p?.enabled) {
        if (row.status !== 'paused') {
          await this.db.query(`UPDATE music_tracks SET status = 'paused' WHERE id = $1 AND status = 'active'`, [row.id]);
          paused++;
        }
        continue;
      }
      try {
        const fresh = await p.getTrack(row.external_id);
        if (fresh) await this.upsert(row.provider, [fresh]);
        else {
          await this.markWithdrawn(row.id);
          withdrawn++;
        }
      } catch (e) {
        // Tried again next time.
        this.log(`music provider ${row.provider} failed`, e);
      }
    }
    return { checked: rows.length, withdrawn, paused };
  }
}

/** The part to play: inside the song (shorter songs play whole). */
function partOrThrow(m: { startMs: number; durationMs: number }, songMs: number | null, what: 'sound' | 'song') {
  const part = storyMusicPart(m.startMs, m.durationMs, songMs);
  if (!part)
    throw new AppError(400, 'validation_failed', 'Check the highlighted fields.', {
      fields: { 'music.startMs': `This ${what} is ${Math.floor((songMs ?? 0) / 1000)} seconds long. Choose an earlier start.` },
    });
  return part;
}

function fromProvider(t: ProviderTrack): Partial<TrackDbRow> {
  return {
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration_ms: t.durationMs,
    cover_url: t.coverUrl,
    preview_url: t.previewUrl,
    licence: t.licence,
  };
}

function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => (seen.has(key(t)) ? false : (seen.add(key(t)), true)));
}

/** Round robin over the lists, without repeats, up to `limit`. */
function interleave(lists: MusicTrack[][], limit: number): MusicTrack[] {
  const out: MusicTrack[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++)
    for (const l of lists) {
      const t = l[i];
      if (!t || seen.has(`${t.source}:${t.id}`)) continue;
      seen.add(`${t.source}:${t.id}`);
      out.push(t);
      if (out.length >= limit) break;
    }
  return out;
}
