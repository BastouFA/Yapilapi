import { withTransaction } from '@yapilapi/database';
import type { FastifyRequest } from 'fastify';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { localMinutes } from '../../lib/notification-policy.js';
import { shouldDeliver } from '../../lib/notification-policy.js';
import { createPost } from '../content/service.js';
import { deleteMediaById } from '../media/service.js';
import { realVisibleSql } from './access.js';
import {
  CLOCK_TOLERANCE_MS,
  computeAuthenticity,
  noneAttestationVerifier,
  type AttestationVerifier,
} from './authenticity.js';
import {
  CAPTURE_TOKEN_TTL_MS,
  captureSigningKey,
  hashDeviceId,
  signCaptureToken,
  verifyCaptureToken,
} from './token.js';
import { screenOwnText } from './screen.js';
import { CAPTURE_FROM, CAPTURE_SELECT, captureView } from './views.js';

export const REAL_VISIBILITIES = [
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
  'private',
] as const;
export type RealVisibility = (typeof REAL_VISIBILITIES)[number];
export interface RealUser {
  userId: string;
  ageBand: 'teen' | 'adult';
}

// ------------------------------------------------------------------------------------------------ runtime (attestation plug-in point)
const verifiers = new WeakMap<AppContext, AttestationVerifier>();
/** Deployments with platform credentials install an App Attest / Play Integrity verifier here. Default: `none` (device_attested stays false). */
export const setAttestationVerifier = (ctx: AppContext, v: AttestationVerifier): void =>
  void verifiers.set(ctx, v);
export const getAttestationVerifier = (ctx: AppContext): AttestationVerifier =>
  verifiers.get(ctx) ?? noneAttestationVerifier;

const tokenFailure = (reason: string, message: string) =>
  new AppError('unprocessable', message, { reason: `capture_token_${reason}` });

// ------------------------------------------------------------------------------------------------ capture sessions
export async function issueCaptureSession(
  ctx: AppContext,
  userId: string,
  input: { deviceId: string; clientTime?: number | undefined },
  now = Date.now(),
) {
  const deviceHash = hashDeviceId(userId, input.deviceId);
  const skew = input.clientTime === undefined ? null : now - input.clientTime;
  const expires = new Date(now + CAPTURE_TOKEN_TTL_MS);
  const { rows } = await ctx.db.query<{ id: string; issued_at: Date }>(
    `INSERT INTO real_capture_sessions (user_id, device_hash, clock_skew_ms, issued_at, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, issued_at`,
    [userId, deviceHash, skew, new Date(now), expires],
  );
  const token = signCaptureToken(captureSigningKey(ctx.config.dataEncryptionKey), {
    sid: rows[0]!.id,
    uid: userId,
    dev: deviceHash,
    iat: now,
    exp: expires.getTime(),
    skew,
  });
  const attest = getAttestationVerifier(ctx);
  return {
    token,
    expiresAt: expires.toISOString(),
    ttlSec: CAPTURE_TOKEN_TTL_MS / 1000,
    method: 'in_app_token' as const,
    // Honest capability report: hardware attestation is only offered when a verifier other than `none` is installed.
    attestation: { available: attest.provider !== 'none', provider: attest.provider },
    clockSkewMs: skew,
  };
}

// ------------------------------------------------------------------------------------------------ create
export interface CreateCaptureInput {
  captureToken: string;
  deviceId: string;
  frontMediaId?: string | undefined;
  rearMediaId?: string | undefined;
  caption: string;
  capturedAt: Date;
  latitude?: number | undefined;
  longitude?: number | undefined;
  visibility: RealVisibility;
  circleId?: string | undefined;
  audience?: string[] | undefined;
  edits?: string[] | undefined;
  attestation?: string | undefined;
}

export async function createCapture(
  ctx: AppContext,
  user: RealUser,
  input: CreateCaptureInput,
): Promise<string> {
  const { frontMediaId, rearMediaId } = input;
  if (!frontMediaId && !rearMediaId) throw invalid('A Real needs a front or rear photo or video');
  if (frontMediaId && frontMediaId === rearMediaId)
    throw invalid('Front and rear media must be different files');
  if ((input.latitude === undefined) !== (input.longitude === undefined))
    throw invalid('Provide both latitude and longitude');
  if (user.ageBand === 'teen') {
    if (input.visibility === 'public')
      throw new AppError('unprocessable', 'Accounts under 18 cannot share Reals publicly');
    if (input.latitude !== undefined)
      throw new AppError('unprocessable', 'Accounts under 18 cannot attach a location to Reals');
  }
  if (input.visibility === 'circle' && !input.circleId)
    throw invalid('circleId is required for circle visibility');
  if (input.visibility !== 'circle' && input.circleId)
    throw invalid('circleId is only valid with circle visibility');
  const audience = [...new Set(input.audience ?? [])].filter((id) => id !== user.userId);
  if (input.visibility === 'selected' && !audience.length)
    throw invalid('Choose who can see this Real');
  if (input.visibility !== 'selected' && input.audience?.length)
    throw invalid('audience is only valid with selected visibility');
  if (input.visibility === 'public') {
    const p = await ctx.db.query<{ is_private: boolean }>(
      'SELECT is_private FROM profiles WHERE user_id = $1',
      [user.userId],
    );
    if (p.rows[0]?.is_private)
      throw new AppError(
        'unprocessable',
        'Private accounts share Reals with followers, friends, a circle or selected people',
      );
  }
  if (input.circleId) {
    const c = await ctx.db.query('SELECT 1 FROM circles WHERE id = $1 AND owner_id = $2', [
      input.circleId,
      user.userId,
    ]);
    if (!c.rowCount) throw notFound('Circle');
  }
  for (const uid of audience)
    if (await isBlockedEitherWay(ctx.db, user.userId, uid))
      throw invalid('Your audience includes someone you cannot share with');
  if (audience.length) {
    const ok = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND status = 'active'`,
      [audience],
    );
    if (ok.rows[0]!.n !== audience.length)
      throw invalid('Your audience includes someone who is unavailable');
  }

  // 1. Token: signature, expiry, user and device binding (pure). Replay is decided by consuming the session row below.
  const now = Date.now();
  const verdict = verifyCaptureToken(
    captureSigningKey(ctx.config.dataEncryptionKey),
    input.captureToken,
    { userId: user.userId, deviceHash: hashDeviceId(user.userId, input.deviceId) },
    now,
  );
  if (!verdict.ok)
    throw tokenFailure(
      verdict.reason,
      `The capture token is not valid (${verdict.reason.replace('_', ' ')})`,
    );
  const attest = await getAttestationVerifier(ctx).verify({
    userId: user.userId,
    deviceId: input.deviceId,
    payload: input.attestation,
  });

  const captureId = await withTransaction(ctx.db, async (tx) => {
    // 2. Consume the single-use session. If this fails the token was already used (replay) or the session is gone.
    const s = await tx.query<{ issued_at: Date; clock_skew_ms: string | null }>(
      `UPDATE real_capture_sessions SET used_at = now() WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING issued_at, clock_skew_ms`,
      [verdict.payload.sid, user.userId],
    );
    if (!s.rows[0]) {
      const seen = await tx.query<{ used_at: Date | null }>(
        'SELECT used_at FROM real_capture_sessions WHERE id = $1 AND user_id = $2',
        [verdict.payload.sid, user.userId],
      );
      throw tokenFailure(
        seen.rows[0]?.used_at ? 'replayed' : 'unknown_session',
        seen.rows[0]?.used_at
          ? 'This capture token was already used'
          : 'This capture session does not exist or has expired',
      );
    }
    const session = s.rows[0];

    // 3. Media: owned by the user, live, not attached anywhere else, image or video only. Locked so two captures cannot claim one file.
    const ids = [frontMediaId, rearMediaId].filter((x): x is string => Boolean(x));
    const m = await tx.query<{ id: string; created_at: Date }>(
      `SELECT m.id, m.created_at FROM media m
        WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready') AND m.kind IN ('image','video') AND m.purpose = 'attachment'
          AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.media_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.media_id = m.id AND mo.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM real_captures rc WHERE (rc.front_media_id = m.id OR rc.rear_media_id = m.id) AND rc.deleted_at IS NULL)
        FOR UPDATE`,
      [ids, user.userId],
    );
    if (m.rows.length !== ids.length) throw invalid('One or more media files are unavailable');

    const authenticity = computeAuthenticity({
      capturedAtMs: input.capturedAt.getTime(),
      receivedAtMs: now,
      sessionIssuedAtMs: session.issued_at.getTime(),
      clockSkewMs: session.clock_skew_ms === null ? null : Number(session.clock_skew_ms),
      mediaCreatedAtMs: m.rows.map((r) => r.created_at.getTime()),
      declaredEdits: [...new Set(input.edits ?? [])],
      serverEditOps: [],
      attested: attest.attested,
      tokenVerified: true,
    });

    const ins = await tx.query<{ id: string }>(
      `INSERT INTO real_captures (author_id, front_media_id, rear_media_id, caption, latitude, longitude, captured_at, received_at, authenticity, visibility, circle_id, capture_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        user.userId,
        frontMediaId ?? null,
        rearMediaId ?? null,
        input.caption.trim(),
        input.latitude ?? null,
        input.longitude ?? null,
        input.capturedAt,
        new Date(now),
        JSON.stringify(authenticity),
        input.visibility,
        input.circleId ?? null,
        verdict.payload.sid,
      ],
    );
    const id = ins.rows[0]!.id;
    if (audience.length)
      await tx.query(
        'INSERT INTO real_capture_audience (capture_id, user_id) SELECT $1, unnest($2::uuid[])',
        [id, audience],
      );
    await tx.query('UPDATE real_capture_sessions SET capture_id = $2 WHERE id = $1', [
      verdict.payload.sid,
      id,
    ]);
    await screenOwnText(ctx, tx, {
      type: 'real_capture',
      id,
      authorId: user.userId,
      text: input.caption,
    });
    return id;
  });
  ctx.metrics.events.inc({ name: 'real_created' });
  return captureId;
}

// ------------------------------------------------------------------------------------------------ delete
export async function deleteCapture(
  ctx: AppContext,
  userId: string,
  id: string,
  req?: FastifyRequest,
): Promise<void> {
  const mediaToDrop: string[] = [];
  await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<{
      front_media_id: string | null;
      rear_media_id: string | null;
      shared_post_id: string | null;
    }>(
      `UPDATE real_captures SET deleted_at = now(), caption = '', latitude = NULL, longitude = NULL
        WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL RETURNING front_media_id, rear_media_id, shared_post_id`,
      [id, userId],
    );
    const r = rows[0];
    if (!r) throw notFound('Real');
    await tx.query('DELETE FROM real_capture_audience WHERE capture_id = $1', [id]);
    await tx.query('DELETE FROM real_reactions WHERE capture_id = $1', [id]);
    // Deletion propagates: perspectives in shared experiences and items in memories that pointed at it disappear with it.
    await tx.query(
      'UPDATE shared_experience_contributions SET deleted_at = now() WHERE real_capture_id = $1 AND deleted_at IS NULL',
      [id],
    );
    await tx.query(`DELETE FROM memory_items WHERE item_type = 'real_capture' AND item_id = $1`, [
      id,
    ]);
    // A post the owner created from it is a separate act of publication: it stays, and keeps its media.
    const live = r.shared_post_id
      ? await tx.query('SELECT 1 FROM posts WHERE id = $1 AND deleted_at IS NULL', [
          r.shared_post_id,
        ])
      : null;
    if (!live?.rowCount)
      for (const mid of [r.front_media_id, r.rear_media_id]) if (mid) mediaToDrop.push(mid);
    await audit(
      ctx,
      { actorId: userId, action: 'real.deleted', targetType: 'real_capture', targetId: id },
      req,
      tx,
    );
  });
  for (const mid of mediaToDrop) await deleteMediaById(ctx, mid);
}

// ------------------------------------------------------------------------------------------------ reactions
export async function reactToCapture(
  ctx: AppContext,
  userId: string,
  id: string,
  kind: string,
): Promise<{ reactionCount: number }> {
  const { rows } = await ctx.db.query<{ author_id: string }>(
    `SELECT r.author_id FROM real_captures r WHERE r.id = $2 AND ${realVisibleSql('$1::uuid')}`,
    [userId, id],
  );
  if (!rows[0]) throw notFound('Real');
  const count = await withTransaction(ctx.db, async (tx) => {
    const ins = await tx.query(
      'INSERT INTO real_reactions (capture_id, user_id, kind) VALUES ($1,$2,$3) ON CONFLICT (capture_id, user_id) DO UPDATE SET kind = EXCLUDED.kind RETURNING (xmax = 0) AS inserted',
      [id, userId, kind],
    );
    if (ins.rows[0]!.inserted)
      await tx.query('UPDATE real_captures SET reaction_count = reaction_count + 1 WHERE id = $1', [
        id,
      ]);
    return (
      await tx.query<{ reaction_count: number }>(
        'SELECT reaction_count FROM real_captures WHERE id = $1',
        [id],
      )
    ).rows[0]!.reaction_count;
  });
  await notify(ctx, {
    userId: rows[0].author_id,
    kind: 'real_reaction',
    actorId: userId,
    targetType: 'real_capture',
    targetId: id,
    data: { reaction: kind },
  });
  return { reactionCount: count };
}

export async function removeReaction(ctx: AppContext, userId: string, id: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const del = await tx.query(
      'DELETE FROM real_reactions WHERE capture_id = $1 AND user_id = $2',
      [id, userId],
    );
    if (del.rowCount)
      await tx.query(
        'UPDATE real_captures SET reaction_count = GREATEST(reaction_count - 1, 0) WHERE id = $1',
        [id],
      );
  });
}

// ------------------------------------------------------------------------------------------------ share to profile (explicit action)
export interface ShareInput {
  visibility: 'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private';
  circleId?: string | undefined;
  audience?: string[] | undefined;
  body?: string | undefined;
  include: 'both' | 'front' | 'rear';
  includeLocation: boolean;
}

export async function shareCaptureToProfile(
  ctx: AppContext,
  user: RealUser,
  id: string,
  input: ShareInput,
  req?: FastifyRequest,
): Promise<string> {
  const { rows } = await ctx.db.query<Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `SELECT r.* FROM real_captures r WHERE r.id = $1 AND r.author_id = $2 AND r.deleted_at IS NULL AND r.moderation_status = 'approved'`,
    [id, user.userId],
  );
  const cap = rows[0];
  if (!cap) throw notFound('Real');
  if (cap.shared_post_id) {
    const live = await ctx.db.query('SELECT 1 FROM posts WHERE id = $1 AND deleted_at IS NULL', [
      cap.shared_post_id,
    ]);
    if (live.rowCount) throw conflict('This Real is already on your profile');
    await ctx.db.query('DELETE FROM post_media WHERE post_id = $1', [cap.shared_post_id]); // the earlier post was deleted: free its media for a new share
  }
  const mediaIds = [
    input.include !== 'front' ? cap.rear_media_id : null,
    input.include !== 'rear' ? cap.front_media_id : null,
  ].filter((x): x is string => Boolean(x));
  if (!mediaIds.length) throw invalid('That Real has no media for the chosen side');
  const postId = await createPost(ctx, user, {
    body: (input.body ?? cap.caption ?? '').trim(),
    visibility: input.visibility,
    circleId: input.circleId,
    audience: input.audience,
    mediaIds,
    ...(input.includeLocation && cap.latitude !== null
      ? { latitude: cap.latitude, longitude: cap.longitude }
      : {}),
    metadata: {
      real: {
        captureId: id,
        capturedAt: new Date(cap.captured_at).toISOString(),
        authenticity: cap.authenticity,
      },
    },
  });
  await ctx.db.query('UPDATE real_captures SET shared_post_id = $2 WHERE id = $1', [id, postId]);
  await audit(
    ctx,
    {
      actorId: user.userId,
      action: 'real.shared_to_profile',
      targetType: 'real_capture',
      targetId: id,
      metadata: { postId, visibility: input.visibility },
    },
    req,
  );
  return postId;
}

// ------------------------------------------------------------------------------------------------ tray
/** Friends' recent Reals, grouped per author. No unread counts, no "who has not posted": the tray only shows what exists. */
export async function loadTray(ctx: AppContext, viewerId: string, limit: number) {
  const { rows } = await ctx.db.query(
    `SELECT ${CAPTURE_SELECT('$1::uuid')}
       FROM ${CAPTURE_FROM}
      WHERE r.captured_at > now() - interval '48 hours'
        AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($1::uuid, r.author_id) AND fr.user_high = GREATEST($1::uuid, r.author_id) AND fr.status = 'accepted')
        AND NOT EXISTS (SELECT 1 FROM user_mutes um WHERE um.muter_id = $1 AND um.muted_id = r.author_id)
        AND r.author_id <> $1 AND ${realVisibleSql('$1::uuid')}
      ORDER BY r.captured_at DESC, r.id DESC LIMIT 300`,
    [viewerId],
  );
  const groups = new Map<
    string,
    { author: unknown; latestAt: string; count: number; items: unknown[] }
  >();
  for (const r of rows) {
    const v = captureView(ctx, r, viewerId);
    const g = groups.get(r.author_id) ?? {
      author: v.author,
      latestAt: v.capturedAt,
      count: 0,
      items: [],
    };
    g.count++;
    if (g.items.length < 3) g.items.push(v);
    groups.set(r.author_id, g);
  }
  return { items: [...groups.values()].slice(0, limit) };
}

// ------------------------------------------------------------------------------------------------ reminders (opt-in, quiet-hours aware)
export interface ReminderSettings {
  enabled: boolean;
  days: number[];
  localMinute: number;
  timezone: string;
}

export async function getReminders(ctx: AppContext, userId: string): Promise<ReminderSettings> {
  const { rows } = await ctx.db.query(
    'SELECT enabled, days, local_minute, timezone FROM real_reminder_settings WHERE user_id = $1',
    [userId],
  );
  const r = rows[0];
  return r
    ? {
        enabled: r.enabled,
        days: (r.days as number[]).map(Number),
        localMinute: r.local_minute,
        timezone: r.timezone,
      }
    : { enabled: false, days: [], localMinute: 18 * 60, timezone: 'UTC' };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function setReminders(
  ctx: AppContext,
  userId: string,
  s: ReminderSettings,
): Promise<ReminderSettings> {
  if (!isValidTimeZone(s.timezone)) throw invalid('Unknown time zone');
  const days = [...new Set(s.days)].sort();
  await ctx.db.query(
    `INSERT INTO real_reminder_settings (user_id, enabled, days, local_minute, timezone) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, days = EXCLUDED.days, local_minute = EXCLUDED.local_minute, timezone = EXCLUDED.timezone, updated_at = now()`,
    [userId, s.enabled, days, s.localMinute, s.timezone],
  );
  return getReminders(ctx, userId);
}

/** Local calendar date (YYYY-MM-DD) and weekday (0 = Sunday) for `now` in `timeZone`. */
export function localDay(now: Date, timeZone: string): { date: string; dow: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, dow };
}

export const REMINDER_GRACE_MINUTES = 60;

/**
 * Deliver due reminders (call from a scheduler about once a minute). Rules that make this a courtesy rather than a hook:
 *  - only users who opted in, on the days and time THEY chose, at most once per local day;
 *  - a reminder more than an hour late is dropped, never queued or repeated;
 *  - skipped when the user already captured a Real in the last 12 hours;
 *  - skipped during the user's quiet hours / pause / focus mode (the same policy every notification uses);
 *  - the text never mentions streaks, misses or friends.
 */
export async function runRealReminders(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<{ considered: number; sent: number }> {
  const { rows } = await ctx.db.query<{
    user_id: string;
    days: number[];
    local_minute: number;
    timezone: string;
    last_sent_on: string | null;
  }>(
    `SELECT s.user_id, s.days, s.local_minute, s.timezone, s.last_sent_on::text AS last_sent_on
       FROM real_reminder_settings s JOIN users u ON u.id = s.user_id AND u.deleted_at IS NULL AND u.status = 'active'
      WHERE s.enabled AND cardinality(s.days) > 0`,
  );
  let sent = 0;
  for (const r of rows) {
    const { date, dow } = localDay(now, r.timezone);
    if (!r.days.map(Number).includes(dow) || r.last_sent_on === date) continue;
    const minute = localMinutes(now, r.timezone);
    if (minute < r.local_minute || minute > r.local_minute + REMINDER_GRACE_MINUTES) continue;
    // Claim the day first so concurrent runners cannot double-send.
    const claim = await ctx.db.query(
      `UPDATE real_reminder_settings SET last_sent_on = $2 WHERE user_id = $1 AND (last_sent_on IS NULL OR last_sent_on <> $2::date)`,
      [r.user_id, date],
    );
    if (!claim.rowCount) continue;
    if (!(await ctx.flags.isEnabled('REAL', r.user_id))) continue;
    const recent = await ctx.db.query(
      `SELECT 1 FROM real_captures WHERE author_id = $1 AND received_at > $2 AND deleted_at IS NULL LIMIT 1`,
      [r.user_id, new Date(now.getTime() - 12 * 3_600_000)],
    );
    if (recent.rowCount) continue;
    const decision = await shouldDeliver(ctx, r.user_id, 'real_reminder', now);
    if (decision.suppressedBy || !decision.inApp) continue;
    await notify(ctx, {
      userId: r.user_id,
      kind: 'real_reminder',
      data: { message: 'Your reminder: capture a Real whenever you like.' },
    });
    sent++;
  }
  return { considered: rows.length, sent };
}

export { CLOCK_TOLERANCE_MS };
