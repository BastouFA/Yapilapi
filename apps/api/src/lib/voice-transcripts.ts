import type { Pool, PoolClient } from 'pg';
import type { VoiceTranscript } from '@yapilapi/shared';
import { enqueue } from './jobs.ts';
import { pushNewMessage } from './message-push.ts';
import { analyzeText } from './moderation.ts';
import type { RealtimeHub } from './realtime.ts';
import { isEnabled } from './services.ts';
import { ALLOWED_MIME, type MediaStorage } from './storage.ts';
import { MAX_TRANSCRIBE_AUDIO_BYTES, type TranscriptionProvider } from './transcription.ts';
import { langOf } from './translation.ts';
import { seesSensitiveSql } from './interactions.ts';
import { parseVtt } from './webvtt.ts';

type Q = Pool | PoolClient;

/**
 * Voice messages everyone understands (docs/product/speech-engine.md): a voice note or a Yap in a
 * chat is transcribed by the speech-to-text provider in a job, and members read the words under
 * it ("Show text"), translated like a message when they don't understand the language
 * (translation kind 'transcript'). Never for view-once or disappearing messages, never when the
 * sender turned "Transcribe my voice messages" off, and only while VOICE_TRANSCRIPTS is on and a
 * provider is configured. Deleting, unsending or expiring the message deletes the transcript, and
 * with it its translations and spoken clips (database triggers, 0089).
 */
export interface VoiceDeps {
  db: Pool;
  storage: MediaStorage;
  transcription: TranscriptionProvider | null;
  realtime: RealtimeHub;
  log?: { warn: (obj: object, msg: string) => void };
}

/** A voice message's push waits this long for its transcript (then goes without it). */
export const VOICE_PUSH_WAIT_MS = 15_000;

type SentRow = { id: string; kind: string; view_once: boolean; expires_at: Date | null; attachments: { kind?: string; mediaId?: string }[] | null };

/** A voice note or a Yap: one voice clip, not view once and not disappearing. */
export function isTranscribable(m: SentRow): boolean {
  const a = m.attachments ?? [];
  return (m.kind === 'message' || m.kind === 'yap') && !m.view_once && !m.expires_at && a.length === 1 && a[0]!.kind === 'audio' && !!a[0]!.mediaId;
}

/**
 * A message just sent: when it's a voice message that gets a transcript, queue it and say so.
 * With `push`, the job sends the message's push once the transcript is ready (or after
 * VOICE_PUSH_WAIT_MS), so it can say the first words; the caller doesn't push.
 */
export async function queueTranscript(
  db: Q,
  transcription: TranscriptionProvider | null,
  senderId: string,
  m: SentRow,
  opts: { push: boolean },
): Promise<boolean> {
  if (!transcription || !isTranscribable(m) || !(await isEnabled(db, 'VOICE_TRANSCRIPTS'))) return false;
  if (!(await transcribesVoice(db, senderId))) return false;
  const made = await db.query(`INSERT INTO message_transcripts (message_id) VALUES ($1) ON CONFLICT DO NOTHING`, [m.id]);
  if (!made.rowCount) return false;
  await enqueue(db, 'voice.transcribe', { messageId: m.id, push: opts.push });
  return true;
}

/** "Transcribe my voice messages" (on unless turned off). */
export async function transcribesVoice(db: Q, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ on: boolean }>(`SELECT transcribe_voice AS on FROM user_preferences WHERE user_id = $1`, [userId]);
  return rows[0]?.on ?? true;
}

/** Ready transcripts of these messages, by message id. */
export async function transcriptsFor(db: Q, ids: string[]): Promise<Map<string, VoiceTranscript>> {
  const out = new Map<string, VoiceTranscript>();
  if (!ids.length) return out;
  const { rows } = await db.query<{ message_id: string; body: string; lang: string | null }>(
    `SELECT message_id, body, lang FROM message_transcripts WHERE message_id = ANY($1::uuid[]) AND status = 'ready'`,
    [ids],
  );
  for (const r of rows) out.set(r.message_id, { text: r.body, lang: r.lang });
  return out;
}

/** The extension speech-to-text services recognise for a voice clip's type. */
const extOf = (mime: string) => (mime === 'audio/webm' ? 'webm' : (ALLOWED_MIME[mime]?.ext ?? 'm4a'));

async function transcribe(deps: VoiceDeps, messageId: string): Promise<void> {
  const { db } = deps;
  const r = (
    await db.query<{
      status: string;
      sender_id: string;
      conversation_id: string;
      kind: string;
      view_once: boolean;
      expires_at: Date | null;
      deleted_at: Date | null;
      attachments: SentRow['attachments'];
      moderation_status: string;
      storage_key: string | null;
      mime: string | null;
      media_moderation: string | null;
    }>(
      `SELECT t.status, m.sender_id, m.conversation_id, m.kind, m.view_once, m.expires_at, m.deleted_at, m.attachments, m.moderation_status,
              md.storage_key, md.mime, md.moderation AS media_moderation
       FROM message_transcripts t JOIN messages m ON m.id = t.message_id
       LEFT JOIN media md ON md.id = (m.attachments->0->>'mediaId')::uuid AND md.deleted_at IS NULL
       WHERE t.message_id = $1`,
      [messageId],
    )
  ).rows[0];
  if (!r || r.status !== 'pending') return;
  const settle = (status: 'empty' | 'failed') =>
    db.query(`UPDATE message_transcripts SET status = $2, finished_at = now() WHERE message_id = $1 AND status = 'pending'`, [messageId, status]);
  // Things changed since it was sent (the sender's switch, the flag, the provider): no transcript.
  const allowed =
    !!deps.transcription &&
    !r.deleted_at &&
    isTranscribable({ id: messageId, ...r }) &&
    (await isEnabled(db, 'VOICE_TRANSCRIPTS')) &&
    (await transcribesVoice(db, r.sender_id));
  if (!allowed) {
    await db.query(`DELETE FROM message_transcripts WHERE message_id = $1`, [messageId]);
    return;
  }
  if (!r.storage_key || r.media_moderation === 'blocked') return void (await settle('failed'));
  const started = Date.now();
  const audit = (status: 'ok' | 'error' | 'blocked') =>
    db
      .query(`INSERT INTO ai_tool_calls (user_id, task, provider, model, context_scopes, status, latency_ms) VALUES ($1,'transcribe',$2,'',$3,$4,$5)`, [
        r.sender_id,
        deps.transcription!.name,
        [`message:${messageId}`],
        status,
        Date.now() - started,
      ])
      .catch(() => {});
  let text: string;
  try {
    const audio = await deps.storage.read(r.storage_key);
    if (audio.length > MAX_TRANSCRIBE_AUDIO_BYTES) return void (await settle('failed'));
    const mime = r.mime ?? 'audio/mp4';
    const vtt = await deps.transcription!.transcribe({ audio, filename: `voice.${extOf(mime)}`, mime });
    text = parseVtt(vtt)
      .map((c) => c.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (err) {
    // What the provider said stays in the logs.
    deps.log?.warn({ messageId, err: String((err as Error).message).slice(0, 500) }, 'voice transcript failed');
    await audit('error');
    return void (await settle('failed'));
  }
  if (!text) {
    await audit('ok');
    return void (await settle('empty'));
  }
  // The safety layer: words that may put someone at risk are never written out.
  if (analyzeText(text).risk === 'escalate') {
    await audit('blocked');
    return void (await settle('failed'));
  }
  await audit('ok');
  const lang = langOf(text);
  const done = await db.query(
    `UPDATE message_transcripts SET status = 'ready', body = $2, lang = $3, provider = $4, finished_at = now() WHERE message_id = $1 AND status = 'pending'`,
    [messageId, text, lang, deps.transcription!.name],
  );
  if (!done.rowCount) return;
  // Everyone in the chat who sees the message (and its voice clip) gets the words.
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT cm.user_id FROM conversation_members cm
     WHERE cm.conversation_id = $1 AND cm.left_at IS NULL
       AND ($3 = 'normal' OR cm.user_id = $2)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = $2)
       AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = cm.user_id AND h.message_id = $4)
       AND ($5::text IS DISTINCT FROM 'sensitive' OR ${seesSensitiveSql('cm.user_id')})`,
    [r.conversation_id, r.sender_id, r.moderation_status, messageId, r.media_moderation],
  );
  await deps.realtime.publish(
    rows.map((x) => x.user_id),
    { type: 'message.transcript', data: { id: messageId, conversationId: r.conversation_id, transcript: { text, lang } satisfies VoiceTranscript } },
  );
}

/**
 * Transcribe one voice message. With `push`, its push goes out once the words are ready, or after
 * VOICE_PUSH_WAIT_MS without them, and in any case (it never waits on a failure).
 */
export async function transcribeVoiceMessage(deps: VoiceDeps, job: { messageId: string; push?: boolean }): Promise<void> {
  const work = transcribe(deps, job.messageId).catch((err) => {
    deps.log?.warn({ messageId: job.messageId, err: String((err as Error)?.message).slice(0, 500) }, 'voice transcript failed');
    return deps.db.query(`UPDATE message_transcripts SET status = 'failed', finished_at = now() WHERE message_id = $1 AND status = 'pending'`, [job.messageId]);
  });
  if (job.push) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise((r) => (timer = setTimeout(r, VOICE_PUSH_WAIT_MS)))]);
    clearTimeout(timer);
    await pushNewMessage({ db: deps.db, realtime: deps.realtime }, job.messageId).catch(() => {});
  }
  await work;
}

export function voiceJobHandlers(deps: () => VoiceDeps) {
  return {
    'voice.transcribe': (job: { messageId: string; push?: boolean }) => transcribeVoiceMessage(deps(), job),
  };
}
