import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Pool, PoolClient } from 'pg';
import {
  allowsDerivatives,
  echoFrame,
  echoVolumes,
  type EchoBlock,
  type EchoLayout,
  type EchoOptions,
  type EchoRender,
  type EchoTheirAudio,
  type MediaItem,
  type MusicLicence,
} from '@yapilapi/shared';
import { AppError, notFound } from './errors.ts';
import { minorRuleSql } from './collabs.ts';
import { postUnlockedSql, postVisibleSql } from './visibility.ts';
import { plusCol, publicUserFrom } from './users.ts';
import { mediaSizesSql, withSmallVariants } from './data-saver.ts';
import { NO_METADATA } from './media-formats.ts';
import { mediaJobHandlers, probe, run } from './media-processing.ts';
import type { MediaModerator } from './media-moderation.ts';
import type { MediaStorage } from './storage.ts';
import type { RealtimeHub } from './realtime.ts';
import { sourceKey } from './share-video.ts';
import { FONTS } from './media-edit.ts';
import { parseVtt, type Cue } from './webvtt.ts';
import { saveCaptionTrack } from './studio.ts';
import { recipientLocale } from './email.ts';
// Every language, loaded up front: the credit is drawn in the echo author's.
import { t } from '@yapilapi/shared/i18n';

type Q = Pool | PoolClient;

/**
 * Echoes: a reel answering another reel with the answerer's own video, the two shown together
 * (packages/shared/src/echoes.ts has the layouts and the rules both apps show).
 *
 * Who may echo a reel is its author's choice per reel (allow_echoes: everyone, people they follow,
 * nobody; by default everyone for public accounts and nobody for private and under-18 ones).
 * Whatever it says, blocks stop echoes (the reel isn't visible), an adult can echo someone under 18
 * only once they're friends, and only normal reels shared publicly, with followers or with friends
 * can be echoed: never subscriber-only or sensitive ones, or echoes themselves.
 *
 * The combined video is made here ('echo.render'), stored as the maker's media and put through the
 * same processing and checks as an upload; the maker then posts it (posts.create with `echo`).
 * An echo stays up only while the reel it echoes is there for the viewer (visibility.ts, echoShownSql).
 */

export const ECHO_RENDER_JOB = 'echo.render';

/** The author's choice for reel `p` (profile `ap`, user `au`), or the default for their account. */
export const echoPermissionSql = (p = 'p', ap = 'ap', au = 'au') =>
  `coalesce(${p}.allow_echoes, CASE WHEN ${ap}.is_private OR coalesce(${au}.birth_date > current_date - interval '18 years', false) THEN 'nobody' ELSE 'everyone' END)`;

/**
 * Reel `p` (profile `ap`, user `au`) may be echoed by viewer `v`, who can already see it (the
 * caller checked postVisibleSql, which covers blocks). The author may always echo their own reel.
 */
export function echoAllowedSql(v: string, ap = 'ap'): string {
  return `(${v}::uuid IS NOT NULL AND p.format = 'reel' AND NOT p.is_echo AND p.visibility IN ('public', 'followers', 'friends')
           AND p.moderation_status = 'normal'
           AND NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.moderation IN ('sensitive', 'blocked'))
           AND (p.author_id = ${v} OR (
             CASE ${echoPermissionSql('p', ap)}
               WHEN 'everyone' THEN true
               WHEN 'following' THEN EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = p.author_id AND f.followee_id = ${v})
               ELSE false END
             AND ${minorRuleSql(v, 'p.author_id')})))`;
}

/** Plain words for each reason a reel can't be echoed (the apps show their own translations). */
export const ECHO_BLOCK_MESSAGES: Record<EchoBlock, string> = {
  not_reel: 'Only reels can be echoed.',
  echo: "Echoes can't be echoed.",
  audience: 'Only reels shared publicly, with followers or with friends can be echoed.',
  subscribers: "Reels for subscribers can't be echoed.",
  sensitive: "This reel can't be echoed.",
  processing: 'This reel is still being prepared. Try again in a moment.',
  nobody: "The creator of this reel doesn't allow echoes.",
  following: 'Only people the creator follows can echo this reel.',
  unavailable: "This reel's video can't be used right now.",
};

export const echoRefused = (reason: EchoBlock) =>
  new AppError(reason === 'processing' ? 409 : 403, reason === 'processing' ? 'media_processing' : 'echo_not_allowed', ECHO_BLOCK_MESSAGES[reason], {
    reason,
  });

/** What the check needs of the original reel. */
export interface OriginalRow {
  id: string;
  author_id: string;
  body: string;
  format: string;
  visibility: string;
  moderation_status: string;
  is_echo: boolean;
  permission: 'everyone' | 'following' | 'nobody';
  author_follows_me: boolean;
  minor_ok: boolean;
  unlocked: boolean;
  music_track_id: string | null;
  music: { startMs: number; durationMs: number } | null;
  sound_id: string | null;
  sound_source: string | null;
  sound_media_id: string | null;
  media_id: string | null;
  storage_key: string | null;
  variants: Record<string, string> | null;
  duration_ms: number | null;
  moderation: string | null;
  media_status: string | null;
  media: MediaItem | null;
  track_title: string | null;
  track_artist: string | null;
  track_licence: MusicLicence | null;
  [key: string]: unknown;
}

/** The reel `postId` as viewer `v` sees it, with what deciding on an echo needs; null when they can't see it. */
export async function originalFor(db: Q, postId: string, viewer: string): Promise<OriginalRow | null> {
  const { rows } = await db.query<OriginalRow>(
    `SELECT p.id, p.author_id, p.body, p.format, p.visibility, p.moderation_status, p.is_echo, ${echoPermissionSql()} AS permission,
            EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = p.author_id AND f.followee_id = $1) AS author_follows_me,
            (p.author_id = $1 OR ${minorRuleSql('$1', 'p.author_id')}) AS minor_ok, coalesce(${postUnlockedSql('$1')}, false) AS unlocked,
            p.music_track_id, p.music, p.sound_id, s.source_post_id AS sound_source, s.media_id AS sound_media_id,
            m.id AS media_id, m.storage_key, m.variants, m.duration_ms, m.moderation, m.status AS media_status,
            CASE WHEN m.id IS NOT NULL THEN json_build_object('id', m.id, 'kind', m.kind, 'url', m.url, 'altText', m.alt_text, 'width', m.width, 'height', m.height,
              'variants', m.variants, 'sizes', ${mediaSizesSql()}, 'posterUrl', m.poster_url, 'hlsUrl', m.hls_url, 'placeholder', m.blurhash,
              'captions', (SELECT coalesce(json_agg(json_build_object('lang', ct.lang, 'label', ct.label, 'url', ct.url) ORDER BY ct.lang), '[]')
                           FROM caption_tracks ct WHERE ct.media_id = m.id AND ct.status = 'ready')) END AS media,
            mt.title AS track_title, mt.artist AS track_artist, mt.licence AS track_licence,
            pr.user_id AS a_id, pr.username AS a_username, pr.display_name AS a_display_name, pr.avatar_url AS a_avatar_url, pr.mode AS a_mode, ${plusCol('a_')}
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id JOIN profiles pr ON pr.user_id = p.author_id
     LEFT JOIN sounds s ON s.id = p.sound_id
     LEFT JOIN music_tracks mt ON mt.id = p.music_track_id
     LEFT JOIN LATERAL (SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = p.id AND m.kind = 'video' ORDER BY pm.position LIMIT 1) m ON true
     WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
    [viewer, postId],
  );
  return rows[0] ?? null;
}

/** Why viewer `me` can't echo this reel, or null when they can. `moderated`: automated checks are on. */
export function echoBlock(o: OriginalRow, me: string, moderated: boolean): EchoBlock | null {
  if (o.format !== 'reel') return 'not_reel';
  if (o.is_echo) return 'echo';
  if (o.visibility === 'subscribers') return 'subscribers';
  if (!['public', 'followers', 'friends'].includes(o.visibility)) return 'audience';
  if (o.moderation_status !== 'normal' || o.moderation === 'sensitive' || o.moderation === 'blocked') return 'sensitive';
  if (!o.media_id || !o.storage_key) return 'unavailable';
  if (o.author_id !== me) {
    if (o.permission === 'nobody') return 'nobody';
    if (o.permission === 'following' && !o.author_follows_me) return 'following';
    // Someone under 18 and an adult who aren't friends: it reads as the creator's choice.
    if (!o.minor_ok) return 'nobody';
  }
  if (o.media_status !== 'ready' || (moderated && o.moderation === 'pending')) return 'processing';
  return null;
}

/**
 * What would be heard of the original in an echo: its own audio ('mixed'), a sound it borrowed
 * from another reel (mixed the same way), or the catalogue song it plays, which the echo keeps
 * only when the song's licence allows derivatives ('song'), else 'dropped'.
 */
export function theirAudioFor(o: OriginalRow): Exclude<EchoTheirAudio, 'muted'> {
  if (o.music_track_id) return o.track_licence && allowsDerivatives(o.track_licence) ? 'song' : 'dropped';
  return 'mixed';
}

export function echoOptions(o: OriginalRow, me: string, moderated: boolean): EchoOptions {
  const reason = echoBlock(o, me, moderated);
  return {
    canEcho: !reason,
    reason,
    original: {
      id: o.id,
      author: publicUserFrom(o, 'a_'),
      body: o.body,
      media: o.media ? withSmallVariants(o.media) : null,
      durationMs: o.duration_ms,
    },
    theirAudio: theirAudioFor(o),
    song: o.music_track_id && o.track_title ? { title: o.track_title, artist: o.track_artist ?? '' } : null,
  };
}

// ─── Rendering ─────────────────────────────────────────────────────────

export interface EchoPlanInput {
  layout: EchoLayout;
  /** Their video, already seeked to where it starts (the cut's start, or 0). */
  theirs: string;
  theirStartMs: number;
  yours: string;
  /** Where their audio comes from: their own video file, or a borrowed sound's file (looped); null when none is heard. */
  theirAudio: { file: string; loop: boolean } | null;
  yoursHasAudio: boolean;
  /** "Echo of @name", drawn as a picture. */
  credit: string | null;
  /** The cut that plays first (0 for none) and your video's length. */
  cutMs: number;
  yoursMs: number;
  volumes: { theirs: number; yours: number };
  output: string;
}

export interface EchoPlan {
  args: string[];
  width: number;
  height: number;
  durationMs: number;
}

const secs = (ms: number) => (ms / 1000).toFixed(3);
const vol = (v: number) => (Math.round(v * 1000) / 1000).toString();
/** Fill a w × h place with a video, cropped to fit (never stretched). */
const fill = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;

/**
 * The ffmpeg command for an echo. Their video runs from the cut's start (or its beginning) for the
 * whole echo and holds its last frame if it's shorter; during the cut it fills the frame alone,
 * then the two share the frame in the layout for as long as your video lasts. Their audio and
 * yours are mixed at the chosen balance (theirs at full level during the cut), and metadata is
 * left out of the output.
 */
export function planEcho(p: EchoPlanInput): EchoPlan {
  const f = echoFrame(p.layout);
  const { width: W, height: H } = f;
  const C = Math.max(0, p.cutMs);
  const Y = p.yoursMs;
  const T = C + Y;
  const inputs = ['-ss', secs(p.theirStartMs), '-i', p.theirs, '-i', p.yours];
  let next = 2;
  let audioIn = -1;
  if (p.theirAudio) {
    audioIn = next++;
    if (p.theirAudio.loop) inputs.push('-stream_loop', '-1', '-i', p.theirAudio.file);
    else inputs.push('-ss', secs(p.theirStartMs), '-i', p.theirAudio.file);
  }
  let creditIn = -1;
  if (p.credit) {
    creditIn = next++;
    inputs.push('-loop', '1', '-i', p.credit);
  }

  const g: string[] = [];
  // Their video, as long as the whole echo (the last frame held).
  const theirs = `[0:v]fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=${secs(T)},trim=duration=${secs(T)},setpts=PTS-STARTPTS`;
  if (C > 0) {
    g.push(`${theirs},split=2[t0][t1]`);
    g.push(`[t0]trim=duration=${secs(C)},setpts=PTS-STARTPTS,${fill(W, H)}[cut]`);
    g.push(`[t1]trim=start=${secs(C)},setpts=PTS-STARTPTS,${fill(f.theirs.width, f.theirs.height)}[theirs]`);
  } else {
    g.push(`${theirs},${fill(f.theirs.width, f.theirs.height)}[theirs]`);
  }
  g.push(
    `[1:v]fps=30,setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=duration=${secs(Y)},setpts=PTS-STARTPTS,${fill(f.yours.width, f.yours.height)}[yours]`,
  );
  if (p.layout === 'side') g.push(`[theirs][yours]hstack=inputs=2[both]`);
  else if (p.layout === 'stack') g.push(`[theirs][yours]vstack=inputs=2[both]`);
  else {
    const b = f.border;
    g.push(`[theirs]pad=${f.theirs.width + 2 * b}:${f.theirs.height + 2 * b}:${b}:${b}:color=white[inset]`);
    g.push(`[yours][inset]overlay=${f.theirs.x - b}:${f.theirs.y - b}[both]`);
  }
  let v = 'both';
  if (C > 0) {
    g.push(`[cut]format=yuv420p[cutf]`, `[both]format=yuv420p[bothf]`, `[cutf][bothf]concat=n=2:v=1:a=0[joined]`);
    v = 'joined';
  }
  if (creditIn >= 0) {
    g.push(`[${v}][${creditIn}:v]overlay=${f.credit.x}:${f.credit.y}:shortest=1[marked]`);
    v = 'marked';
  }
  g.push(`[${v}]format=yuv420p[v]`);

  // Audio: theirs (full during the cut, then at the balance), yours after the cut, then mixed.
  const stereo = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const parts: string[] = [];
  if (audioIn >= 0 && p.volumes.theirs > 0) {
    const skip = p.theirAudio!.loop && p.theirStartMs > 0 ? `atrim=start=${secs(p.theirStartMs)},` : '';
    const level = C > 0 ? `volume='if(lt(t,${secs(C)}),1,${vol(p.volumes.theirs)})':eval=frame` : `volume=${vol(p.volumes.theirs)}`;
    g.push(`[${audioIn}:a]${stereo},${skip}asetpts=PTS-STARTPTS,apad,atrim=duration=${secs(T)},${level}[ta]`);
    parts.push('[ta]');
  }
  if (p.yoursHasAudio && p.volumes.yours > 0) {
    const delay = C > 0 ? `adelay=${Math.round(C)}|${Math.round(C)},` : '';
    g.push(`[1:a]${stereo},atrim=duration=${secs(Y)},asetpts=PTS-STARTPTS,${delay}apad,atrim=duration=${secs(T)},volume=${vol(p.volumes.yours)}[ya]`);
    parts.push('[ya]');
  }
  if (parts.length === 2) g.push(`[ta][ya]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3,alimiter=limit=0.95[a]`);
  else if (parts.length === 1) g.push(`${parts[0]}anull[a]`);
  else g.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${secs(T)}[a]`);

  return {
    width: W,
    height: H,
    durationMs: T,
    args: [
      '-y',
      ...inputs,
      '-filter_complex',
      g.join(';'),
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      ...NO_METADATA,
      '-movflags',
      '+faststart',
      '-t',
      secs(T),
      p.output,
    ],
  };
}

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The "Echo of @name" credit as a small picture, in the echo's author's language: white words on a
 * soft dark pill, drawn with the bundled font so it looks the same on any server. Returns false
 * when text can't be drawn here.
 */
export async function drawCredit(out: string, username: string, size: number, locale = 'en'): Promise<boolean> {
  try {
    const text = await sharp({
      text: {
        text: `<span foreground="white">${escapeMarkup(t('echo.credit', locale, { username }))}</span>`,
        fontfile: FONTS.bold,
        font: `Inter Bold ${size}`,
        dpi: 72,
        rgba: true,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    const padX = Math.round(size * 0.6);
    const padY = Math.round(size * 0.35);
    const w = text.info.width + 2 * padX;
    const h = text.info.height + 2 * padY;
    const pill = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${Math.round(h / 2)}" fill="#000" fill-opacity="0.55"/></svg>`,
    );
    await sharp(pill)
      .composite([{ input: text.data, left: padX, top: padY }])
      .png()
      .toFile(out);
    return true;
  } catch {
    return false;
  }
}

/** Their caption tracks, moved to where their reel plays in the echo (from `startMs` on, for `durationMs`). */
export function shiftCues(cues: Cue[], startMs: number, durationMs: number): Cue[] {
  const from = startMs / 1000;
  const end = durationMs / 1000;
  return cues
    .map((c) => ({ ...c, start: Math.max(0, c.start - from), end: Math.min(end, c.end - from) }))
    .filter((c) => c.end > c.start + 0.05)
    .map(({ id: _id, ...c }) => c);
}

export interface EchoDeps {
  db: Pool;
  storage: MediaStorage;
  moderator?: MediaModerator;
  realtime?: RealtimeHub;
}

async function fail(deps: EchoDeps, id: string, resultId: string | null, ownerId: string, message: string) {
  await deps.db.query(`UPDATE echoes SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [id, message]);
  if (resultId) await deps.db.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [resultId]);
  await deps.realtime?.publish([ownerId], { type: 'echo.updated', data: { id, status: 'failed' } });
}

/**
 * Make one echo video, then run the normal media processing and checks on it. Failures are
 * recorded on the echo (the same inputs would fail again), not retried.
 */
export async function renderEchoJob(deps: EchoDeps, echoId: string): Promise<void> {
  const { db, storage } = deps;
  const { rows } = await db.query(
    `SELECT e.id, e.owner_id, e.layout, e.cut_start_ms, e.cut_end_ms, e.balance, e.their_audio, e.status, e.result_media_id, e.original_post_id,
            src.storage_key AS your_key, src.duration_ms AS your_ms,
            om.storage_key AS their_key, om.variants AS their_variants, om.id AS their_media_id, om.duration_ms AS their_ms,
            sm.storage_key AS sound_key, (s.source_post_id IS DISTINCT FROM o.id) AS borrowed,
            opr.username AS their_username, own.locale AS owner_locale
     FROM echoes e
     LEFT JOIN profiles own ON own.user_id = e.owner_id
     LEFT JOIN media src ON src.id = e.source_media_id
     LEFT JOIN posts o ON o.id = e.original_post_id
     LEFT JOIN profiles opr ON opr.user_id = o.author_id
     LEFT JOIN LATERAL (SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id WHERE pm.post_id = o.id AND m.kind = 'video' ORDER BY pm.position LIMIT 1) om ON true
     LEFT JOIN sounds s ON s.id = o.sound_id
     LEFT JOIN media sm ON sm.id = s.media_id
     WHERE e.id = $1`,
    [echoId],
  );
  const e = rows[0];
  if (!e || !['queued', 'rendering'].includes(e.status)) return;
  if (!e.your_key || !e.their_key) return fail(deps, e.id, e.result_media_id, e.owner_id, "We couldn't make your echo: one of the videos is no longer there.");
  await db.query(`UPDATE echoes SET status = 'rendering' WHERE id = $1`, [echoId]);
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-echo-'));
  try {
    const theirs = path.join(dir, 'theirs');
    const yours = path.join(dir, 'yours');
    const key = sourceKey({ storage_key: e.their_key, variants: e.their_variants });
    // The processed web MP4 is upright and plays everywhere; the upload is the fallback.
    await storage.download(key!, theirs).catch(() => storage.download(e.their_key, theirs));
    await storage.download(e.your_key, yours);
    const [theirInfo, yourInfo] = await Promise.all([probe(theirs), probe(yours)]);
    if (!yourInfo.durationMs || !theirInfo.durationMs) throw new Error("We couldn't read one of the videos.");

    // What is heard of their reel: its own audio, or the sound it borrowed from another reel.
    let theirAudio: EchoTheirAudio = e.their_audio;
    let audioSource: EchoPlanInput['theirAudio'] = null;
    if (theirAudio === 'mixed') {
      if (e.borrowed && e.sound_key) {
        const sound = path.join(dir, 'sound');
        await storage.download(e.sound_key, sound);
        if ((await probe(sound)).hasAudio) audioSource = { file: sound, loop: true };
      } else if (theirInfo.hasAudio) audioSource = { file: theirs, loop: false };
      if (!audioSource) theirAudio = 'none';
    }

    const start = e.cut_start_ms ?? 0;
    const cutMs = e.cut_end_ms !== null ? e.cut_end_ms - e.cut_start_ms : 0;
    const f = echoFrame(e.layout);
    const creditFile = path.join(dir, 'credit.png');
    // Burned into the video, so in the language of whoever made the echo.
    const credit = e.their_username && (await drawCredit(creditFile, e.their_username, f.credit.size, recipientLocale(e.owner_locale))) ? creditFile : null;
    const output = path.join(dir, 'echo.mp4');
    const plan = planEcho({
      layout: e.layout,
      theirs,
      theirStartMs: start,
      yours,
      theirAudio: audioSource,
      yoursHasAudio: yourInfo.hasAudio,
      credit,
      cutMs,
      yoursMs: yourInfo.durationMs,
      // The balance is between their sound and yours; with nothing of theirs to hear, yours plays at its own level.
      volumes: audioSource ? echoVolumes(e.balance) : { theirs: 0, yours: 1 },
      output,
    });
    await run(plan.args, dir);
    const out = await probe(output);
    const durationMs = out.durationMs ?? plan.durationMs;
    const stored = await storage.putFile(output, 'mp4', 'video/mp4', `echoes/${e.owner_id}/${randomUUID()}.mp4`);
    await db.query(
      `UPDATE media SET url = $2, storage_key = $3, mime = 'video/mp4', size_bytes = $4, duration_ms = $5, width = $6, height = $7 WHERE id = $1`,
      [e.result_media_id, stored.url, stored.key, (await stat(output)).size, durationMs, plan.width, plan.height],
    );

    // Their captions, where their reel plays in the echo.
    const tracks = await db.query(`SELECT lang, label, storage_key FROM caption_tracks WHERE media_id = $1 AND status = 'ready' AND storage_key IS NOT NULL`, [
      e.their_media_id,
    ]);
    for (const tr of tracks.rows) {
      try {
        const cues = shiftCues(parseVtt(await storage.read(tr.storage_key)), start, durationMs);
        if (cues.length)
          await saveCaptionTrack(deps, { mediaId: e.result_media_id, lang: tr.lang, label: tr.label, source: 'upload', cues, userId: e.owner_id });
      } catch {
        // A track that can't be read is left out; the echo still goes ahead.
      }
    }

    // The same processing and checks as an upload.
    await mediaJobHandlers({ db, storage, moderator: deps.moderator, realtime: deps.realtime })['media.process']({
      mediaId: e.result_media_id,
      filename: 'echo.mp4',
    });
    await db.query(
      `UPDATE echoes SET status = 'ready', their_audio = $2, width = $3, height = $4, duration_ms = $5, error = NULL, finished_at = now() WHERE id = $1`,
      [echoId, theirAudio, plan.width, plan.height, durationMs],
    );
    await deps.realtime?.publish([e.owner_id], { type: 'echo.updated', data: { id: echoId, status: 'ready' } });
  } catch (err) {
    await fail(deps, e.id, e.result_media_id, e.owner_id, `We couldn't make your echo. ${String((err as Error).message).slice(0, 200)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function echoJobHandlers(deps: EchoDeps) {
  return {
    [ECHO_RENDER_JOB]: ({ echoId }: { echoId: string }) => renderEchoJob(deps, echoId),
  };
}

/** An echo as its maker sees it. */
export async function echoRender(db: Q, id: string, owner: string): Promise<EchoRender | null> {
  const { rows } = await db.query(
    `SELECT e.id, e.status, e.error, e.layout, e.their_audio, e.original_post_id, e.post_id, e.created_at,
            m.id AS m_id, m.url AS m_url, m.poster_url AS m_poster, e.width, e.height, e.duration_ms
     FROM echoes e LEFT JOIN media m ON m.id = e.result_media_id WHERE e.id = $1 AND e.owner_id = $2`,
    [id, owner],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    error: r.status === 'failed' ? (r.error ?? "We couldn't make your echo.") : null,
    layout: r.layout,
    theirAudio: r.their_audio,
    originalId: r.original_post_id,
    media:
      r.status === 'ready' && r.m_id ? { id: r.m_id, url: r.m_url, posterUrl: r.m_poster, width: r.width, height: r.height, durationMs: r.duration_ms } : null,
    postId: r.post_id,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/**
 * Posting an echo (inside the publishing transaction): the echo must be yours, made and not posted
 * yet, the video must be the one made for it, and you must still be allowed to echo the original
 * (the creator may have changed their setting, or one of you blocked the other, since).
 */
export async function claimEcho(
  c: PoolClient,
  userId: string,
  echoId: string,
  mediaId: string | undefined,
): Promise<{ originalId: string; originalAuthorId: string; song: { trackId: string; part: { startMs: number; durationMs: number } } | null }> {
  const e = (await c.query(`SELECT * FROM echoes WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [echoId, userId])).rows[0];
  if (!e) throw notFound('That echo');
  if (e.post_id) throw new AppError(409, 'echo_posted', 'This echo was already posted.');
  if (e.status !== 'ready') throw new AppError(409, 'echo_not_ready', 'Your echo is still being made. Try again in a moment.');
  if (!mediaId || mediaId !== e.result_media_id) throw new AppError(400, 'validation_failed', 'Post the video that was made for this echo.');
  if (!e.original_post_id) throw notFound('The reel you echoed');
  const o = await originalFor(c, e.original_post_id, userId);
  if (!o) throw notFound('The reel you echoed');
  // Their video was checked when the echo was made; what may have changed since is who can echo.
  const reason = echoBlock(o, userId, false);
  if (reason) throw echoRefused(reason);
  return {
    originalId: o.id,
    originalAuthorId: o.author_id,
    song: e.their_audio === 'song' && e.music_track_id && e.music ? { trackId: e.music_track_id, part: e.music } : null,
  };
}

/** Link a just-written echo reel to its original and its echo video. */
export async function linkEcho(c: PoolClient, postId: string, echoId: string, originalId: string, song: { trackId: string; part: object } | null) {
  await c.query(`UPDATE posts SET is_echo = true, echo_of_post_id = $2, allow_remix = false, music_track_id = $3, music = $4 WHERE id = $1`, [
    postId,
    originalId,
    song?.trackId ?? null,
    song ? { ...song.part, style: 'compact' } : null,
  ]);
  await c.query(`UPDATE echoes SET post_id = $2 WHERE id = $1`, [echoId, postId]);
}

/**
 * Before posting an echo that keeps their song: the song is read again from its provider and must
 * still be allowed for you (your account type, your country, the part's length). Outside a
 * transaction, since it may ask the provider.
 */
export async function checkEchoSong(
  deps: { db: Q; music: { checkTrack(userId: string, trackId: string, clipMs: number): Promise<unknown> } },
  userId: string,
  echoId: string,
) {
  const e = (await deps.db.query(`SELECT their_audio, music_track_id, music FROM echoes WHERE id = $1 AND owner_id = $2`, [echoId, userId])).rows[0];
  if (e?.their_audio === 'song' && e.music_track_id && e.music) await deps.music.checkTrack(userId, e.music_track_id, e.music.durationMs);
}
