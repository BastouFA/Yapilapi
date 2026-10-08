import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { peaksFromSamples, VOICE_PEAKS, YAPS_PER_HOUR, type VoiceClip, type VoicePurpose } from '@yapilapi/shared';
import type { AppContext } from './context.ts';
import { AppError, badRequest, conflict, notFound } from './errors.ts';
import { enqueue } from './jobs.ts';
import { detectMedia, NO_METADATA } from './media-formats.ts';
import { run } from './media-processing.ts';
import { purgeMedia, unusedMedia } from './media-files.ts';
import { analyzeText, statusForRisk } from './moderation.ts';
import { decodeCueText, parseVtt } from './webvtt.ts';
import { MAX_TRANSCRIBE_AUDIO_BYTES } from './transcription.ts';
import { langOf } from './translation.ts';
import { enrollFairStart } from './fair-start.ts';
import { notBlockedSql, postUnlockedSql, postVisibleSql } from './visibility.ts';
import { commentVisibleSql, syncCommentCounts } from './comments.ts';

type Q = Pool | PoolClient;

/**
 * Yaps: voice posts of up to a minute, voice replies and voice intros (docs/product/yaps.md).
 *
 * A clip is uploaded on its own (POST /v1/voice): the server decodes it, measures it (the app's
 * word for its length is never taken), stores it small (AAC, mono, 24 kHz, 32 kbit/s: a full
 * minute is about 240 KB, some fifty times lighter than a minute of video) and draws its
 * waveform. It is then attached once: to a Yap (a post with format 'yap'), a comment or a
 * profile. When it's attached, its transcript is made through the configured speech-to-text
 * provider (lib/transcription.ts) and checked like a post's words. Without a provider it is
 * 'unavailable' at once, and moderation relies on reports.
 *
 * Until its words have passed the checks, a Yap reaches its author's followers (and everyone who
 * opens it) but isn't suggested to anyone else: not in For you, the Yaps filter or Fair start
 * (yapDistributableSql).
 */
export const VOICE_TRANSCRIBE_JOB = 'voice.clip.transcribe';

/** Stored clips: mono AAC at this rate and sample rate, in an M4A every browser and phone plays. */
const VOICE_BITRATE = '32k';
const VOICE_SAMPLE_RATE = '24000';
/** Decoded at this rate to measure the clip and draw its waveform. */
const PCM_RATE = 8000;
/** Decode no more than this much of an upload: anything longer is refused anyway. */
const DECODE_LIMIT_S = 75;

/** A Yap post `p` may be suggested beyond its author's followers: none of its clips is waiting for words, or had them held. */
export function yapDistributableSql(p = 'p'): string {
  return `NOT EXISTS (SELECT 1 FROM post_media vpm JOIN voice_clips vvc ON vvc.media_id = vpm.media_id
                      WHERE vpm.post_id = ${p}.id AND (vvc.transcript_status = 'pending' OR vvc.screened = 'held'))`;
}

/** The VoiceClip (as JSON) for the media id in `col`, or NULL. Words only once they're ready. */
export function voiceClipSql(col: string): string {
  return `(SELECT json_build_object('id', vmj.id, 'url', vmj.url, 'durationMs', vcj.duration_ms, 'peaks', vcj.peaks,
            'transcript', json_build_object('status', vcj.transcript_status,
              'text', CASE WHEN vcj.transcript_status = 'ready' THEN vcj.transcript END,
              'lang', CASE WHEN vcj.transcript_status = 'ready' THEN vcj.lang END,
              'segments', CASE WHEN vcj.transcript_status = 'ready' THEN coalesce(vcj.segments, '[]'::jsonb) ELSE '[]'::jsonb END))
          FROM voice_clips vcj JOIN media vmj ON vmj.id = vcj.media_id WHERE vcj.media_id = ${col} AND vmj.moderation <> 'blocked')`;
}

/**
 * Voice clips aliased `vc` the viewer `v` may hear: their own, one on a post they can see and open,
 * one in a comment they'd be shown, or a voice intro on a profile they can see (nobody blocked
 * either way; a private account's intro only for someone signed in, as with its bio).
 */
export function voiceVisibleSql(v: string): string {
  return `(vc.owner_id = ${v}
    OR EXISTS (SELECT 1 FROM post_media pm JOIN posts p ON p.id = pm.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
               WHERE pm.media_id = vc.media_id AND ${postVisibleSql(v)} AND ${postUnlockedSql(v)})
    OR EXISTS (SELECT 1 FROM comments cm JOIN posts p ON p.id = cm.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
               WHERE cm.voice_media_id = vc.media_id AND ${commentVisibleSql(v)} AND ${postVisibleSql(v)} AND ${postUnlockedSql(v)})
    OR EXISTS (SELECT 1 FROM profiles ip JOIN users iu ON iu.id = ip.user_id
               WHERE ip.voice_intro_media_id = vc.media_id AND iu.status = 'active' AND ${notBlockedSql('ip.user_id', v)}
                 AND (NOT ip.is_private OR ${v}::uuid IS NOT NULL)))`;
}

/** One clip the viewer may hear, or null. */
export async function loadVoice(db: Q, mediaId: string, viewer: string | null): Promise<VoiceClip | null> {
  const { rows } = await db.query(`SELECT ${voiceClipSql('vc.media_id')} AS voice FROM voice_clips vc WHERE vc.media_id = $2 AND ${voiceVisibleSql('$1')}`, [
    viewer,
    mediaId,
  ]);
  return (rows[0]?.voice as VoiceClip | undefined) ?? null;
}

/**
 * An upload made ready to keep: decoded (at most DECODE_LIMIT_S of it), measured from its samples,
 * stored as small mono AAC without any of the tags it came with, and drawn as VOICE_PEAKS bars.
 */
export async function prepareVoice(raw: Buffer, declaredMime: string): Promise<{ buf: Buffer; durationMs: number; peaks: number[] }> {
  const detected = detectMedia(raw, declaredMime || 'audio/webm');
  if (!detected || detected.kind === 'image') throw new AppError(415, 'unsupported_media', "That file isn't a voice recording.");
  const dir = await mkdtemp(path.join(tmpdir(), 'ypl-voice-'));
  try {
    const input = path.join(dir, `in.${detected.ext}`);
    const out = path.join(dir, 'voice.m4a');
    const pcm = path.join(dir, 'voice.pcm');
    await writeFile(input, raw);
    await run([
      '-y',
      '-t',
      String(DECODE_LIMIT_S),
      '-i',
      input,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      VOICE_SAMPLE_RATE,
      '-c:a',
      'aac',
      '-b:a',
      VOICE_BITRATE,
      ...NO_METADATA,
      '-movflags',
      '+faststart',
      out,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      String(PCM_RATE),
      '-f',
      's16le',
      pcm,
    ]).catch(() => {
      throw new AppError(415, 'unsupported_media', "That file isn't a voice recording.");
    });
    const raw16 = await readFile(pcm);
    const count = Math.floor(raw16.length / 2);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = raw16.readInt16LE(i * 2) / 32768;
    return { buf: await readFile(out), durationMs: Math.round((count / PCM_RATE) * 1000), peaks: peaksFromSamples(samples, VOICE_PEAKS) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Take one of your clips for a Yap, a comment or your intro (inside the transaction that attaches
 * it). It must be yours, recorded for this purpose, and not used anywhere yet (`except`: the post
 * being saved again, or the intro you have now).
 */
export async function claimVoice(c: Q, userId: string, mediaId: string, purpose: VoicePurpose, except: { postId?: string } = {}): Promise<void> {
  const { rows } = await c.query<{ purpose: VoicePurpose; used: boolean }>(
    `SELECT vc.purpose,
            (EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = vc.media_id AND pm.post_id IS DISTINCT FROM $3::uuid)
             OR EXISTS (SELECT 1 FROM comments cm WHERE cm.voice_media_id = vc.media_id)
             OR EXISTS (SELECT 1 FROM profiles pr WHERE pr.voice_intro_media_id = vc.media_id)) AS used
     FROM voice_clips vc JOIN media m ON m.id = vc.media_id
     WHERE vc.media_id = $1 AND vc.owner_id = $2 AND m.moderation <> 'blocked'
     FOR UPDATE OF vc`,
    [mediaId, userId, except.postId ?? null],
  );
  const r = rows[0];
  if (!r) throw notFound('That recording');
  if (r.purpose !== purpose) throw badRequest('That recording was made for something else. Record it again here.');
  if (r.used) throw conflict('That recording was already used. Record a new one.');
}

/** At most YAPS_PER_HOUR Yaps an hour each (drafts and scheduled ones count when they go out). */
export async function assertYapPace(db: Q, userId: string): Promise<void> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM posts WHERE author_id = $1 AND format = 'yap' AND status = 'published' AND created_at > now() - interval '1 hour'`,
    [userId],
  );
  if ((rows[0]?.n ?? 0) >= YAPS_PER_HOUR) throw new AppError(429, 'slow_down', 'You’ve posted a lot of Yaps in the last hour. Try again later.');
}

type VoiceDeps = Pick<AppContext, 'db' | 'config' | 'realtime'> & { transcription?: AppContext['transcription'] };

/**
 * A clip was just attached: transcribe it in the background, or, without speech-to-text, say the
 * transcript isn't available (and let a Yap go on to Fair start).
 */
export async function startTranscript(deps: VoiceDeps, mediaId: string): Promise<void> {
  if (deps.transcription) {
    await enqueue(deps.db, VOICE_TRANSCRIBE_JOB, { mediaId });
    return;
  }
  const r = await deps.db.query(`UPDATE voice_clips SET transcript_status = 'unavailable' WHERE media_id = $1 AND transcript_status = 'pending'`, [mediaId]);
  if (r.rowCount) await afterTranscript(deps, mediaId);
}

/** The Yaps (and only those) of a post just published: start each one's transcript. */
export async function startPostTranscripts(deps: VoiceDeps, postId: string): Promise<void> {
  const { rows } = await deps.db.query<{ media_id: string }>(
    `SELECT vc.media_id FROM post_media pm JOIN posts p ON p.id = pm.post_id JOIN voice_clips vc ON vc.media_id = pm.media_id
     WHERE pm.post_id = $1 AND p.format = 'yap' AND vc.transcript_status = 'pending'`,
    [postId],
  );
  for (const r of rows) await startTranscript(deps, r.media_id);
}

/** Where a clip is used: the Yap or comment (with its post), or the profile it introduces. */
async function attachmentOf(db: Q, mediaId: string) {
  const { rows } = await db.query<{ post_id: string | null; comment_id: string | null; comment_post_id: string | null; intro_of: string | null }>(
    `SELECT (SELECT pm.post_id FROM post_media pm JOIN posts p ON p.id = pm.post_id WHERE pm.media_id = $1 AND p.deleted_at IS NULL LIMIT 1) AS post_id,
            (SELECT cm.id FROM comments cm WHERE cm.voice_media_id = $1 AND cm.deleted_at IS NULL LIMIT 1) AS comment_id,
            (SELECT cm.post_id FROM comments cm WHERE cm.voice_media_id = $1 AND cm.deleted_at IS NULL LIMIT 1) AS comment_post_id,
            (SELECT pr.user_id FROM profiles pr WHERE pr.voice_intro_media_id = $1 LIMIT 1) AS intro_of`,
    [mediaId],
  );
  return rows[0]!;
}

/** The stricter of two moderation states. */
function worse(a: string, b: string): string {
  const order = ['normal', 'review', 'restricted', 'removed'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * Check a transcript's words like a post's (lib/moderation.ts). Words that put someone at risk
 * remove the Yap or reply; others that need a look hold it for review or restrict it, with a case
 * for a moderator naming the transcript. A voice intro whose words don't pass comes off the profile.
 */
async function screenTranscript(deps: VoiceDeps, mediaId: string, ownerId: string, text: string): Promise<void> {
  const analysis = analyzeText(text);
  if (analysis.risk === 'normal') {
    await deps.db.query(`UPDATE voice_clips SET screened = 'passed' WHERE media_id = $1`, [mediaId]);
    return;
  }
  await deps.db.query(`UPDATE voice_clips SET screened = 'held' WHERE media_id = $1`, [mediaId]);
  const status = analysis.risk === 'escalate' ? 'removed' : statusForRisk(analysis.risk);
  const at = await attachmentOf(deps.db, mediaId);
  const target = at.post_id
    ? { type: 'post', id: at.post_id }
    : at.comment_id
      ? { type: 'comment', id: at.comment_id }
      : at.intro_of
        ? { type: 'user', id: at.intro_of }
        : null;
  if (!target) return;
  if (at.post_id) {
    const cur = (await deps.db.query<{ s: string }>(`SELECT moderation_status AS s FROM posts WHERE id = $1`, [at.post_id])).rows[0]?.s ?? 'normal';
    await deps.db.query(`UPDATE posts SET moderation_status = $2 WHERE id = $1`, [at.post_id, worse(cur, status)]);
  } else if (at.comment_id) {
    const cur = (await deps.db.query<{ s: string }>(`SELECT moderation_status AS s FROM comments WHERE id = $1`, [at.comment_id])).rows[0]?.s ?? 'normal';
    await deps.db.query(`UPDATE comments SET moderation_status = $2 WHERE id = $1`, [at.comment_id, worse(cur, status)]);
    if (at.comment_post_id) await syncCommentCounts(deps.db, at.comment_post_id);
  } else if (at.intro_of) {
    await deps.db.query(`UPDATE profiles SET voice_intro_media_id = NULL WHERE user_id = $1 AND voice_intro_media_id = $2`, [at.intro_of, mediaId]);
  }
  await deps.db.query(
    `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ($1, $2, $3, 'automated', $4, $5)
     ON CONFLICT (target_type, target_id) WHERE status = 'open' DO NOTHING`,
    [target.type, target.id, ownerId, analysis.risk, { signals: [...analysis.signals, 'voice_transcript'], mediaId }],
  );
}

/** A clip's words are settled (ready and checked, unavailable or failed): a Yap that may now be suggested gets its fair start. */
async function afterTranscript(deps: VoiceDeps, mediaId: string): Promise<void> {
  const at = await attachmentOf(deps.db, mediaId);
  if (!at.post_id) return;
  const p = (
    await deps.db.query<{ format: string; status: string; moderation_status: string }>(`SELECT format, status, moderation_status FROM posts WHERE id = $1`, [
      at.post_id,
    ])
  ).rows[0];
  if (p?.format === 'yap' && p.status === 'published' && p.moderation_status === 'normal') await enrollFairStart(deps.db, at.post_id, deps.config.SPAM_CHECKS);
}

/**
 * The transcription job: the stored clip goes to the speech-to-text provider (it's already small,
 * so it's sent as it is), without a language so the provider hears which one is spoken. The words,
 * their timed lines and their language are kept, then checked. A failure is final ('failed'): the
 * Yap stays up, and moderation relies on reports, as without a provider.
 */
export async function transcribeVoice(deps: VoiceDeps & Pick<AppContext, 'storage'> & { log?: { warn: (o: object, msg: string) => void } }, mediaId: string) {
  const { rows } = await deps.db.query<{ owner_id: string; transcript_status: string; storage_key: string | null }>(
    `SELECT vc.owner_id, vc.transcript_status, m.storage_key FROM voice_clips vc JOIN media m ON m.id = vc.media_id WHERE vc.media_id = $1`,
    [mediaId],
  );
  const v = rows[0];
  if (!v || v.transcript_status !== 'pending') return;
  const settle = async (status: 'unavailable' | 'failed') => {
    await deps.db.query(`UPDATE voice_clips SET transcript_status = $2, transcribed_at = now() WHERE media_id = $1 AND transcript_status = 'pending'`, [
      mediaId,
      status,
    ]);
    await afterTranscript(deps, mediaId);
  };
  if (!deps.transcription) return settle('unavailable');
  if (!v.storage_key) return settle('failed');
  const provider = deps.transcription;
  const started = Date.now();
  // In the AI audit log like a voice message's transcript (lib/voice-transcripts.ts): who, which service, how long.
  const audit = (status: 'ok' | 'error') =>
    deps.db
      .query(`INSERT INTO ai_tool_calls (user_id, task, provider, model, context_scopes, status, latency_ms) VALUES ($1,'transcribe',$2,'',$3,$4,$5)`, [
        v.owner_id,
        provider.name,
        [`voice:${mediaId}`],
        status,
        Date.now() - started,
      ])
      .catch(() => {});
  try {
    const audio = await deps.storage.read(v.storage_key);
    if (audio.length > MAX_TRANSCRIBE_AUDIO_BYTES) return settle('failed');
    const vtt = await provider.transcribe({ audio, filename: 'voice.m4a', mime: 'audio/mp4' });
    await audit('ok');
    const segments = parseVtt(vtt)
      .map((c) => ({
        start: c.start,
        end: c.end,
        text: decodeCueText(c.text.replace(/<[^>]*>/g, ''))
          .replace(/\s+/g, ' ')
          .trim(),
      }))
      .filter((c) => c.text);
    const text = segments
      .map((c) => c.text)
      .join(' ')
      .trim();
    if (!text) return settle('failed');
    const done = await deps.db.query(
      `UPDATE voice_clips SET transcript_status = 'ready', transcript = $2, segments = $3, lang = $4, transcribed_at = now()
       WHERE media_id = $1 AND transcript_status = 'pending'`,
      [mediaId, text, JSON.stringify(segments), langOf(text)],
    );
    if (!done.rowCount) return;
    await screenTranscript(deps, mediaId, v.owner_id, text);
    await afterTranscript(deps, mediaId);
  } catch (err) {
    // What the provider said stays in the logs.
    deps.log?.warn({ mediaId, err: String((err as Error).message).slice(0, 500) }, 'voice transcript failed');
    await audit('error');
    await settle('failed');
  }
}

/**
 * Clips that just stopped being used (a Yap or voice reply deleted, an intro changed or removed):
 * their audio is deleted now, unless something about where they were is still being looked at
 * (an open report or moderation case); then the usual retention erases it later.
 */
export async function forgetVoice(deps: Pick<AppContext, 'db' | 'storage' | 'config'>, mediaIds: string[], target?: { type: 'post' | 'comment'; id: string }) {
  if (!mediaIds.length) return;
  if (target) {
    const open = await deps.db.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM reports WHERE target_type = $1 AND target_id = $2 AND status <> 'closed')
                  OR EXISTS (SELECT 1 FROM moderation_cases WHERE target_type = $1 AND target_id = $2 AND status = 'open')`,
      [target.type, target.id],
    );
    if (open.rowCount) return;
  }
  const voices = await deps.db.query<{ media_id: string }>(`SELECT media_id FROM voice_clips WHERE media_id = ANY($1::uuid[])`, [mediaIds]);
  await purgeMedia(
    deps,
    await unusedMedia(
      deps.db,
      voices.rows.map((r) => r.media_id),
    ),
  );
}
