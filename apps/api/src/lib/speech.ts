import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.ts';
import { AppError } from './errors.ts';
import type { MediaStorage } from './storage.ts';

type Q = Pool | PoolClient;

/**
 * Text-to-speech, the third part of the speech engine (docs/product/speech-engine.md), next to
 * speech-to-text (transcription.ts) and translation (translation.ts). Like transcription, there
 * is no built-in or fake voice: when no provider is configured, listening is simply unavailable
 * and the apps don't offer it. Voices are generic synthetic ones, never anyone's own.
 */
export interface SpeechProvider {
  name: string;
  model: string;
  /** The voice used for a language (TTS_VOICES, else TTS_VOICE). */
  voiceFor(lang: string): string;
  synthesize(input: { text: string; voice: string; lang: string }): Promise<{ audio: Buffer; mime: string; ext: string }>;
}

/** The longest text spoken in one clip (hosted services cap a request at about 4,096 characters). */
export const MAX_SPEECH_CHARS = 4000;

/** "fr=nova,ar=onyx" → { fr: 'nova', ar: 'onyx' }. */
export function parseVoices(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(',')) {
    const [lang, voice] = part.split('=').map((s) => s.trim());
    if (lang && voice) out[lang.toLowerCase()] = voice;
  }
  return out;
}

/**
 * Any service that implements the OpenAI-compatible POST {base}/audio/speech endpoint
 * (OpenAI tts-1 and gpt-4o-mini-tts, and others that copy it). MP3 plays everywhere (iPhone
 * home-screen web apps included) and speech at the services' default rate is small.
 */
export function openAiCompatibleSpeech(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  voices?: Record<string, string>;
}): SpeechProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    name: 'openai-compatible',
    model: opts.model,
    voiceFor: (lang) => opts.voices?.[lang.toLowerCase()] ?? opts.voice,
    async synthesize({ text, voice }) {
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({ model: opts.model, voice, input: text, response_format: 'mp3' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Speech service returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', ext: 'mp3' };
    },
  };
}

/** The configured provider, or null when listening isn't set up. */
export function speechFromConfig(config: Config): SpeechProvider | null {
  if (config.TTS_PROVIDER === 'openai-compatible' && config.TTS_API_URL)
    return openAiCompatibleSpeech({
      baseUrl: config.TTS_API_URL,
      apiKey: config.TTS_API_KEY,
      model: config.TTS_MODEL,
      voice: config.TTS_VOICE,
      voices: parseVoices(config.TTS_VOICES),
    });
  return null;
}

export interface SpeechDeps {
  db: Pool;
  storage: MediaStorage;
  speech: SpeechProvider | null;
  config: Pick<Config, 'TTS_DAILY_CHAR_LIMIT' | 'TTS_PER_HOUR'>;
}

/** What a spoken clip is for: it is deleted with the last thing it's for (forgetSpeech, then sweepSpeech). */
export interface SpeechSource {
  kind: string;
  id: string;
}

export interface SpokenClip {
  url: string;
  mime: string;
  /** Made before, for anyone. */
  cached: boolean;
}

const unavailable = () => new AppError(503, 'speech_unavailable', 'Listening isn’t available right now. Try again later.');

// Two listeners asking for the same new clip at the same moment share one call to the service.
const making = new Map<string, Promise<SpokenClip>>();

/**
 * `text` read out in `lang` by a plain synthetic voice: the address of an audio clip. One clip
 * per text, language, voice and model, kept in storage and shared by everyone who listens
 * (cached clips are free). A new clip counts against the speaker's hourly cap (`userId`,
 * TTS_PER_HOUR) and the day's budget for everyone (TTS_DAILY_CHAR_LIMIT); past either, or with
 * no provider, it's "Listening isn't available right now". Every clip is for something
 * (`source`), and goes when the last thing it's for does (forgetSpeech). The caller checks who
 * may hear the text. Each new clip, and each cached answer, is in the AI audit log (task "speak").
 */
export async function speak(deps: SpeechDeps, req: { text: string; lang: string; source: SpeechSource; userId?: string }): Promise<SpokenClip> {
  const p = deps.speech;
  const text = req.text.trim();
  if (!p || !text || text.length > MAX_SPEECH_CHARS) throw unavailable();
  const voice = p.voiceFor(req.lang);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  const started = Date.now();
  const log = (scopes: string[], status: 'ok' | 'error' | 'denied') =>
    deps.db
      .query(`INSERT INTO ai_tool_calls (user_id, task, provider, model, context_scopes, status, latency_ms) VALUES ($1,'speak',$2,$3,$4,$5,$6)`, [
        req.userId ?? null,
        p.name,
        p.model,
        [`${req.source.kind}:${req.source.id}`, ...scopes],
        status,
        Date.now() - started,
      ])
      .catch(() => {});
  const found = await cachedClip(deps.db, hash, req.lang, voice, p.model, req.source);
  if (found) {
    await log(['cache'], 'ok');
    return { url: found.url, mime: found.mime, cached: true };
  }
  const key = `${hash}:${req.lang}:${voice}:${p.model}`;
  const running = making.get(key);
  if (running) {
    const clip = await running;
    await cachedClip(deps.db, hash, req.lang, voice, p.model, req.source);
    return { ...clip, cached: true };
  }
  const job = (async (): Promise<SpokenClip> => {
    if (req.userId && (await speechLastHour(deps.db, req.userId)) >= deps.config.TTS_PER_HOUR) {
      await log([], 'denied');
      throw new AppError(429, 'speech_limit', 'Listening isn’t available right now. Try again later.');
    }
    if (!(await takeSpeechBudget(deps.db, text.length, deps.config.TTS_DAILY_CHAR_LIMIT))) {
      await log([], 'denied');
      throw unavailable();
    }
    let made: { audio: Buffer; mime: string; ext: string };
    try {
      made = await p.synthesize({ text, voice, lang: req.lang });
      if (!made.audio.length) throw new Error('empty audio');
    } catch {
      await log([], 'error');
      throw unavailable();
    }
    const stored = await deps.storage.put(made.audio, made.ext, made.mime);
    // The clip and what it's for are written together, so the sweep never sees it unused.
    const { rows } = await deps.db.query<{ id: string; url: string; mime: string; storage_key: string }>(
      `WITH c AS (
         INSERT INTO speech_clips (text_hash, lang, voice, model, provider, storage_key, url, mime, chars, size_bytes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (text_hash, lang, voice, model) DO UPDATE SET text_hash = EXCLUDED.text_hash
         RETURNING id, url, mime, storage_key
       ), u AS (INSERT INTO speech_clip_uses (clip_id, kind, item_id) SELECT id, $11, $12 FROM c ON CONFLICT DO NOTHING)
       SELECT id, url, mime, storage_key FROM c`,
      [hash, req.lang, voice, p.model, p.name, stored.key, stored.url, made.mime, text.length, made.audio.length, req.source.kind, req.source.id],
    );
    const row = rows[0]!;
    // Another server made the same clip at the same moment: keep theirs.
    if (row.storage_key !== stored.key) await deps.storage.remove?.(stored.key).catch(() => {});
    await log([], 'ok');
    return { url: row.url, mime: row.mime, cached: false };
  })().finally(() => making.delete(key));
  making.set(key, job);
  return job;
}

/** The clip made before for this text, now also for `source` (in one statement, so the sweep can't take it in between). */
async function cachedClip(db: Q, hash: string, lang: string, voice: string, model: string, source: SpeechSource) {
  const { rows } = await db.query<{ id: string; url: string; mime: string }>(
    `WITH c AS (SELECT id, url, mime FROM speech_clips WHERE text_hash = $1 AND lang = $2 AND voice = $3 AND model = $4 FOR SHARE),
     u AS (INSERT INTO speech_clip_uses (clip_id, kind, item_id) SELECT id, $5, $6 FROM c ON CONFLICT DO NOTHING)
     SELECT id, url, mime FROM c`,
    [hash, lang, voice, model, source.kind, source.id],
  );
  return rows[0] ?? null;
}

/** New clips this person caused in the last hour (cached ones are free). */
export async function speechLastHour(db: Q, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ai_tool_calls
     WHERE user_id = $1 AND task = 'speak' AND created_at > now() - interval '1 hour' AND status = 'ok' AND NOT ('cache' = ANY(context_scopes))`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** Take `chars` of today's (UTC) budget, all or none: false once TTS_DAILY_CHAR_LIMIT would be passed. */
export async function takeSpeechBudget(db: Q, chars: number, limit: number): Promise<boolean> {
  if (chars <= 0) return true;
  if (chars > limit) return false;
  const { rowCount } = await db.query(
    `INSERT INTO speech_budget AS b (day, chars) VALUES ((now() AT TIME ZONE 'utc')::date, $1)
     ON CONFLICT (day) DO UPDATE SET chars = b.chars + $1 WHERE b.chars + $1 <= $2`,
    [chars, limit],
  );
  return !!rowCount;
}

/** The thing these clips were for is gone (database triggers do this for transcripts). sweepSpeech then deletes clips nothing uses. */
export async function forgetSpeech(db: Q, source: SpeechSource): Promise<void> {
  await db.query(`DELETE FROM speech_clip_uses WHERE kind = $1 AND item_id = $2`, [source.kind, source.id]);
}

/** Delete clips nothing is for any more, with their files. Run by the worker every minute. Returns how many. */
export async function sweepSpeech(deps: Pick<SpeechDeps, 'db' | 'storage'>, limit = 200): Promise<number> {
  const { rows } = await deps.db.query<{ id: string; storage_key: string }>(
    `DELETE FROM speech_clips c WHERE c.id IN (
       SELECT id FROM speech_clips x WHERE NOT EXISTS (SELECT 1 FROM speech_clip_uses u WHERE u.clip_id = x.id) LIMIT $1
     ) RETURNING c.id, c.storage_key`,
    [limit],
  );
  for (const r of rows) await deps.storage.remove?.(r.storage_key).catch(() => {});
  return rows.length;
}
