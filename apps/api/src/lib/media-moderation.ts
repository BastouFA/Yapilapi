import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import { signV4 } from './sigv4.ts';
import { audit, notify } from './services.ts';

type Q = Pool | PoolClient;

/**
 * ok: shown normally. sensitive: blurred for everyone until they choose to view
 * it, and never sent to people under 18. blocked: not shown to anyone, the
 * content it's in is removed and a moderator reviews it.
 */
export type MediaVerdict = 'ok' | 'sensitive' | 'blocked';

export interface ModerationLabel {
  name: string;
  parent?: string | null;
  confidence: number;
}

export interface MediaModerationResult {
  verdict: MediaVerdict;
  labels: ModerationLabel[];
}

/** One still image to check: a photo, or a frame from a video (its poster plus a few sampled frames). */
export interface MediaFrame {
  data: Buffer;
  mime: 'image/jpeg' | 'image/png';
  /** "image", "poster", "frame@12.5s": shown to moderators next to the labels. */
  label: string;
}

export interface ModerationHints {
  mediaId: string;
  kind: 'image' | 'video';
  /** The name the file had on the uploader's device, when known. */
  filename?: string | null;
}

export interface MediaModerator {
  readonly name: string;
  moderate(frames: MediaFrame[], hints: ModerationHints): Promise<MediaModerationResult>;
}

/** Shown when someone tries to share media the automated check blocked. Plain and calm: it may be a mistake. */
export const MEDIA_BLOCKED_MESSAGE =
  'This photo or video can’t be shared because it looks like it goes against our community rules. Someone on our team will check it, and you’ll get a notification either way.';

const rank: Record<MediaVerdict, number> = { ok: 0, sensitive: 1, blocked: 2 };
export const worst = (a: MediaVerdict, b: MediaVerdict): MediaVerdict => (rank[a] >= rank[b] ? a : b);

/**
 * Development and tests: deterministic, offline rules on the original file
 * name. A name containing "blocked" is blocked; "sensitive" or "nsfw" is
 * sensitive; anything else is ok.
 */
export function devMediaModerator(): MediaModerator {
  return {
    name: 'dev',
    async moderate(_frames, hints) {
      const name = (hints.filename ?? '').toLowerCase();
      if (name.includes('blocked')) return { verdict: 'blocked', labels: [{ name: 'Test: blocked', confidence: 100 }] };
      if (name.includes('sensitive') || name.includes('nsfw')) return { verdict: 'sensitive', labels: [{ name: 'Test: sensitive', confidence: 100 }] };
      return { verdict: 'ok', labels: [] };
    },
  };
}

// Rekognition moderation taxonomy (v6 and v7 names). Labels in BLOCK are removed at
// high confidence; everything in BLOCK or SENSITIVE is blurred at lower confidence.
const BLOCK = new Set([
  'Explicit Nudity',
  'Explicit',
  'Graphic Male Nudity',
  'Graphic Female Nudity',
  'Sexual Activity',
  'Explicit Sexual Activity',
  'Illustrated Explicit Nudity',
  'Exposed Male Genitalia',
  'Exposed Female Genitalia',
  'Exposed Buttocks or Anus',
  'Adult Toys',
  'Sex Toys',
  'Graphic Violence Or Gore',
  'Graphic Violence',
  'Blood & Gore',
  'Hate Symbols',
  'Nazi Party',
  'White Supremacy',
  'Extremist',
]);
const SENSITIVE = new Set([
  'Suggestive',
  'Non-Explicit Nudity',
  'Non-Explicit Nudity of Intimate parts and Kissing',
  'Partial Nudity',
  'Implied Nudity',
  'Obstructed Intimate Parts',
  'Kissing on the Lips',
  'Violence',
  'Physical Violence',
  'Weapon Violence',
  'Visually Disturbing',
  'Emaciated Bodies',
  'Corpses',
  'Hanging',
  'Self-Harm',
  'Self Injury',
  'Air Crash',
  'Explosions and Blasts',
]);

export function verdictForLabels(labels: ModerationLabel[], thresholds = { block: 80, sensitive: 60 }): MediaVerdict {
  let v: MediaVerdict = 'ok';
  for (const l of labels) {
    const names = [l.name, l.parent ?? ''];
    if (names.some((n) => BLOCK.has(n)) && l.confidence >= thresholds.block) return 'blocked';
    if (names.some((n) => BLOCK.has(n) || SENSITIVE.has(n)) && l.confidence >= thresholds.sensitive) v = worst(v, 'sensitive');
  }
  return v;
}

export interface RekognitionOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * AWS Rekognition DetectModerationLabels, one call per frame, signed with
 * SigV4. The verdict is the most severe across frames. Errors throw, so the
 * media job retries rather than letting unchecked media through as "ok".
 */
export function rekognitionModerator(opts: RekognitionOptions): MediaModerator {
  const f = opts.fetch ?? fetch;
  const url = `https://rekognition.${opts.region}.amazonaws.com/`;
  return {
    name: 'rekognition',
    async moderate(frames) {
      const labels: ModerationLabel[] = [];
      let verdict: MediaVerdict = 'ok';
      for (const frame of frames) {
        const body = JSON.stringify({ Image: { Bytes: frame.data.toString('base64') }, MinConfidence: 50 });
        const headers = signV4({
          method: 'POST',
          url,
          region: opts.region,
          service: 'rekognition',
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
          sessionToken: opts.sessionToken || undefined,
          headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'RekognitionService.DetectModerationLabels' },
          body,
          now: opts.now?.(),
        });
        const res = await f(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        if (!res.ok) throw new Error(`rekognition ${res.status}: ${text.slice(0, 200)}`);
        const json = JSON.parse(text) as { ModerationLabels?: { Name: string; ParentName?: string; Confidence: number }[] };
        const found = (json.ModerationLabels ?? []).map((l) => ({
          name: l.Name,
          parent: l.ParentName || null,
          confidence: Math.round(l.Confidence * 10) / 10,
        }));
        labels.push(...found);
        verdict = worst(verdict, verdictForLabels(found));
        if (verdict === 'blocked') break;
      }
      return { verdict, labels };
    },
  };
}

/** No automated checks: media stays "pending" (not checked) and is shown normally. */
export function noMediaModerator(): MediaModerator {
  return {
    name: 'none',
    async moderate() {
      return { verdict: 'ok', labels: [] };
    },
  };
}

export function mediaModeratorFromConfig(config: Config): MediaModerator {
  if (config.MEDIA_MODERATION_PROVIDER === 'rekognition')
    return rekognitionModerator({
      region: config.REKOGNITION_REGION,
      accessKeyId: config.REKOGNITION_ACCESS_KEY_ID,
      secretAccessKey: config.REKOGNITION_SECRET_ACCESS_KEY,
      sessionToken: config.REKOGNITION_SESSION_TOKEN,
    });
  if (config.MEDIA_MODERATION_PROVIDER === 'dev') return devMediaModerator();
  return noMediaModerator();
}

/**
 * Store a verdict. Blocked media takes the posts it's in down, opens a
 * moderation case and tells the uploader in plain words. Stories and chat
 * attachments read the verdict when they're loaded, so they follow it too.
 */
export async function recordVerdict(
  db: Pool,
  realtime: RealtimeHub | undefined,
  media: { id: string; ownerId: string; kind: string },
  provider: string,
  result: MediaModerationResult,
): Promise<void> {
  await tx(db, async (c) => {
    const prev = await c.query<{ moderation: string }>(`SELECT moderation FROM media WHERE id = $1 FOR UPDATE`, [media.id]);
    await c.query(`UPDATE media SET moderation = $2, moderation_labels = $3, moderation_provider = $4, moderated_at = now() WHERE id = $1`, [
      media.id,
      result.verdict,
      JSON.stringify(result.labels),
      provider,
    ]);
    if (result.verdict !== 'blocked' || prev.rows[0]?.moderation === 'blocked') return;
    await blockMedia(c, realtime, media, provider, result.labels);
  });
}

async function blockMedia(
  c: Q,
  realtime: RealtimeHub | undefined,
  media: { id: string; ownerId: string; kind: string },
  provider: string,
  labels: ModerationLabel[],
) {
  const posts = await c.query<{ id: string }>(
    `UPDATE posts p SET moderation_status = 'removed' FROM post_media pm
     WHERE pm.post_id = p.id AND pm.media_id = $1 AND p.moderation_status <> 'removed' RETURNING p.id`,
    [media.id],
  );
  const stories = await c.query<{ id: string }>(`SELECT id FROM moments WHERE media_id = $1 AND deleted_at IS NULL`, [media.id]);
  const messages = await c.query<{ id: string }>(`SELECT id FROM messages WHERE sender_id = $1 AND deleted_at IS NULL AND attachments @> $2::jsonb`, [
    media.ownerId,
    JSON.stringify([{ mediaId: media.id }]),
  ]);
  const signals = {
    media: { kind: media.kind, provider, labels },
    posts: posts.rows.map((r) => r.id),
    stories: stories.rows.map((r) => r.id),
    messages: messages.rows.map((r) => r.id),
  };
  const kase = await c.query<{ id: string }>(
    `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('media', $1, $2, 'automated', 'restrict', $3)
     ON CONFLICT (target_type, target_id) WHERE status = 'open' DO UPDATE SET signals = EXCLUDED.signals RETURNING id`,
    [media.id, media.ownerId, signals],
  );
  await audit(c, { actorId: null, action: 'media.blocked', entityType: 'media', entityId: media.id, metadata: { provider, posts: signals.posts } });
  if (realtime)
    await notify(c, realtime, {
      userId: media.ownerId,
      category: 'moderation',
      type: 'media_blocked',
      entityType: 'moderation_case',
      entityId: kase.rows[0]!.id,
      data: { kind: media.kind },
    });
}

/**
 * A moderator's decision on a media case. "no_action" puts back what the
 * automated check took down; "restrict" keeps it up but blurred; "remove"
 * keeps it blocked. Only posts this case removed are restored.
 */
export async function applyMediaDecision(
  c: Q,
  realtime: RealtimeHub,
  mc: { target_id: string; subject_user_id: string | null; signals: { posts?: string[] } },
  decision: string,
): Promise<void> {
  if (decision === 'remove' || decision === 'suspend_user') {
    await c.query(`UPDATE media SET moderation = 'blocked', moderated_at = now() WHERE id = $1`, [mc.target_id]);
    return;
  }
  if (decision !== 'no_action' && decision !== 'restrict') return;
  await c.query(`UPDATE media SET moderation = $2, moderated_at = now() WHERE id = $1`, [mc.target_id, decision === 'restrict' ? 'sensitive' : 'ok']);
  const posts = mc.signals?.posts ?? [];
  if (posts.length) await c.query(`UPDATE posts SET moderation_status = 'normal' WHERE id = ANY($1::uuid[]) AND moderation_status = 'removed'`, [posts]);
  // "restrict" reaches the uploader as an enforcement notification; "no_action" means we got it wrong, so say so.
  if (decision === 'no_action' && mc.subject_user_id)
    await notify(c, realtime, { userId: mc.subject_user_id, category: 'moderation', type: 'media_restored', entityType: 'media', entityId: mc.target_id });
}
