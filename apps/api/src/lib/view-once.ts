import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { NO_METADATA } from './media-formats.ts';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import sharp from 'sharp';
import type { ViewOnceInfo } from '@yapilapi/shared';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import type { MediaStorage } from './storage.ts';
import { putPrivate, readPrivate, removePrivate } from './private-files.ts';
import { probe, run, sampleTimes } from './media-processing.ts';
import { recordVerdict, type MediaFrame, type MediaModerator } from './media-moderation.ts';
import { usersByIds } from './users.ts';

type Q = Pool | PoolClient;

/**
 * View-once photos and videos in chats.
 *
 * - The file is stored privately (under private/, never at a public /media/ address).
 * - Each recipient opens it once: POST /v1/messages/:id/view-once/open gives them a
 *   link that works for a few minutes, only for them. Closing it (…/viewed) marks it
 *   viewed, and from then on the file is never returned to them.
 * - Once every recipient has viewed it, or after 14 days, the job worker deletes the
 *   file from storage and the message shows "Photo, viewed" or "Photo, expired".
 */
export const VIEW_ONCE_DAYS = 14;
/** How long a link to open a view-once photo or video works. */
export const VIEW_TOKEN_TTL_MS = 5 * 60_000;
/** Opened but never closed (the app was closed or crashed): it counts as viewed after this. */
export const OPEN_WINDOW_MINUTES = 10;

// ─── Links ──────────────────────────────────────────────────────────────

function tokenKey(cfg: Config): Buffer {
  return createHash('sha256')
    .update(`view-once:${cfg.MFA_ENCRYPTION_KEY || cfg.PAYMENTS_WEBHOOK_SECRET}`)
    .digest();
}

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
const uuidOf = (b: Buffer) => b.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const macOf = (cfg: Config, body: Buffer) => createHmac('sha256', tokenKey(cfg)).update(body).digest().subarray(0, 16);

/**
 * A short-lived link token naming one message and the one person who may use it:
 * message id, user id and expiry packed in binary, then a MAC (short enough for a URL path).
 */
export function issueViewToken(cfg: Config, messageId: string, userId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const exp = Math.ceil((now + VIEW_TOKEN_TTL_MS) / 1000);
  const body = Buffer.alloc(36);
  uuidBytes(messageId).copy(body, 0);
  uuidBytes(userId).copy(body, 16);
  body.writeUInt32BE(exp, 32);
  return { token: Buffer.concat([body, macOf(cfg, body)]).toString('base64url'), expiresAt: new Date(exp * 1000) };
}

/** The message and person a token names, or null when it is forged or expired. */
export function readViewToken(cfg: Config, token: string, now = Date.now()): { messageId: string; userId: string } | null {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 52) return null;
  const body = raw.subarray(0, 36);
  if (!timingSafeEqual(raw.subarray(36), macOf(cfg, body))) return null;
  if (body.readUInt32BE(32) * 1000 < now) return null;
  return { messageId: uuidOf(body.subarray(0, 16)), userId: uuidOf(body.subarray(16, 32)) };
}

// ─── Upload ─────────────────────────────────────────────────────────────

/**
 * Photos are re-encoded before they are stored, so no location or camera data
 * travels with them (public photos get this from their processed sizes; view-once
 * photos have none). Animated GIFs are kept as they are.
 */
export async function cleanViewOncePhoto(buf: Buffer, mime: string): Promise<{ buf: Buffer; mime: string; ext: string }> {
  if (mime === 'image/gif') return { buf, mime, ext: 'gif' };
  const out = await sharp(buf, { limitInputPixels: 100_000_000 }).rotate().jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { buf: out, mime: 'image/jpeg', ext: 'jpg' };
}

// ─── What people see ────────────────────────────────────────────────────

/** Whether each recipient still counts as not having viewed it (SQL, for message alias m). */
const RECIPIENTS_LEFT = `EXISTS (
  SELECT 1 FROM conversation_members cm
  WHERE cm.conversation_id = m.conversation_id AND cm.left_at IS NULL AND cm.user_id <> m.sender_id
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = m.sender_id)
    AND NOT EXISTS (SELECT 1 FROM message_views v WHERE v.message_id = m.id AND v.user_id = cm.user_id
                    AND (v.viewed_at IS NOT NULL OR v.opened_at < now() - interval '${OPEN_WINDOW_MINUTES} minutes')))`;

/** How each view-once message looks to one person. Messages that aren't view once are left out. */
export async function viewOnceFor(db: Q, messageIds: string[], viewerId: string): Promise<Map<string, ViewOnceInfo>> {
  const out = new Map<string, ViewOnceInfo>();
  if (!messageIds.length) return out;
  const { rows } = await db.query(
    `SELECT m.id, m.sender_id, m.created_at, m.view_once_ended_at, m.view_once_end_reason, coalesce(md.kind, m.attachments->0->>'kind', 'image') AS kind,
            v.viewed_at, (v.opened_at IS NOT NULL AND v.viewed_at IS NULL AND v.opened_at < now() - interval '${OPEN_WINDOW_MINUTES} minutes') AS stale
     FROM messages m LEFT JOIN media md ON md.id = m.view_once_media_id
     LEFT JOIN message_views v ON v.message_id = m.id AND v.user_id = $2
     WHERE m.id = ANY($1::uuid[]) AND m.view_once`,
    [messageIds, viewerId],
  );
  const mine = rows.filter((r) => r.sender_id === viewerId).map((r) => r.id as string);
  const opens = mine.length
    ? (
        await db.query(
          `SELECT message_id, user_id, opened_at, viewed_at, screenshot_at FROM message_views WHERE message_id = ANY($1::uuid[]) ORDER BY opened_at`,
          [mine],
        )
      ).rows
    : [];
  const users = await usersByIds(db, [...new Set(opens.map((o) => o.user_id as string))]);
  for (const r of rows) {
    const expiresAt = new Date(r.created_at.getTime() + VIEW_ONCE_DAYS * 86_400_000).toISOString();
    if (r.sender_id === viewerId) {
      out.set(r.id, {
        state: !r.view_once_ended_at ? 'ready' : r.view_once_end_reason === 'expired' ? 'expired' : 'viewed',
        kind: r.kind,
        expiresAt,
        openedBy: opens
          .filter((o) => o.message_id === r.id && users.has(o.user_id))
          .map((o) => ({
            user: users.get(o.user_id)!,
            openedAt: o.opened_at.toISOString(),
            viewedAt: o.viewed_at?.toISOString() ?? null,
            screenshot: !!o.screenshot_at,
          })),
      });
      continue;
    }
    const seen = !!r.viewed_at || r.stale;
    out.set(r.id, { state: seen ? 'viewed' : r.view_once_ended_at ? 'expired' : 'ready', kind: r.kind, expiresAt });
  }
  return out;
}

/** Send each member their own view of a view-once message. */
export async function publishViewOnce(db: Q, realtime: RealtimeHub, messageId: string, userIds: string[]): Promise<void> {
  const conv = (await db.query<{ conversation_id: string }>(`SELECT conversation_id FROM messages WHERE id = $1`, [messageId])).rows[0];
  if (!conv) return;
  for (const userId of new Set(userIds)) {
    const info = (await viewOnceFor(db, [messageId], userId)).get(messageId);
    if (info) await realtime.publish([userId], { type: 'view_once.updated', data: { id: messageId, conversationId: conv.conversation_id, viewOnce: info } });
  }
}

// ─── Deleting the file ──────────────────────────────────────────────────

export interface ViewOnceDeps {
  db: Pool;
  config: Config;
  storage: MediaStorage;
  realtime?: RealtimeHub;
  moderator?: MediaModerator;
}

/** Why a view-once message's file should go now, or null to keep it. */
export async function viewOnceEnding(db: Q, messageId: string): Promise<'viewed' | 'expired' | 'deleted' | null> {
  const { rows } = await db.query(
    `SELECT CASE WHEN m.deleted_at IS NOT NULL THEN 'deleted'
                 WHEN NOT ${RECIPIENTS_LEFT} THEN 'viewed'
                 WHEN m.created_at < now() - interval '${VIEW_ONCE_DAYS} days' THEN 'expired' END AS reason
     FROM messages m WHERE m.id = $1 AND m.view_once AND m.view_once_ended_at IS NULL`,
    [messageId],
  );
  return rows[0]?.reason ?? null;
}

/**
 * Delete the file from storage and mark the message ended. Safe to run twice:
 * deleting a file that is already gone is fine, and only one run marks the message.
 */
export async function endViewOnce(deps: ViewOnceDeps, messageId: string, reason: 'viewed' | 'expired' | 'deleted'): Promise<boolean> {
  const { db } = deps;
  const m = (
    await db.query(
      `SELECT m.conversation_id, md.id AS media_id, md.storage_key FROM messages m LEFT JOIN media md ON md.id = m.view_once_media_id
       WHERE m.id = $1 AND m.view_once AND m.view_once_ended_at IS NULL`,
      [messageId],
    )
  ).rows[0];
  if (!m) return false;
  if (m.storage_key) await removePrivate(deps, m.storage_key);
  if (m.media_id) await db.query(`UPDATE media SET deleted_at = coalesce(deleted_at, now()), storage_key = NULL WHERE id = $1`, [m.media_id]);
  const done = await db.query(
    `UPDATE messages SET view_once_ended_at = now(), view_once_end_reason = $2 WHERE id = $1 AND view_once_ended_at IS NULL RETURNING id`,
    [messageId, reason === 'deleted' ? null : reason],
  );
  if (!done.rowCount) return false;
  if (deps.realtime && reason !== 'deleted') {
    const members = (
      await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [m.conversation_id])
    ).rows.map((r) => r.user_id);
    await publishViewOnce(db, deps.realtime, messageId, members);
  }
  return true;
}

/** Check one message and delete its file if everyone viewed it, it expired, or it was deleted. */
export async function checkViewOnce(deps: ViewOnceDeps, messageId: string): Promise<'viewed' | 'expired' | 'deleted' | null> {
  const reason = await viewOnceEnding(deps.db, messageId);
  if (reason) await endViewOnce(deps, messageId, reason);
  return reason;
}

/**
 * The periodic sweep: files of view-once messages that everyone has viewed (including
 * people who opened one and never closed it), that are 14 days old, or whose message
 * was deleted. Returns how many files it deleted.
 */
export async function sweepViewOnce(deps: ViewOnceDeps, limit = 200): Promise<number> {
  const { rows } = await deps.db.query<{ id: string; reason: 'viewed' | 'expired' | 'deleted' }>(
    `SELECT id, reason FROM (
       SELECT m.id, CASE WHEN m.deleted_at IS NOT NULL THEN 'deleted'
                         WHEN NOT ${RECIPIENTS_LEFT} THEN 'viewed'
                         WHEN m.created_at < now() - interval '${VIEW_ONCE_DAYS} days' THEN 'expired' END AS reason
       FROM messages m WHERE m.view_once AND m.view_once_ended_at IS NULL
       ORDER BY m.created_at LIMIT $1) x
     WHERE reason IS NOT NULL`,
    [limit],
  );
  let n = 0;
  for (const r of rows) if (await endViewOnce(deps, r.id, r.reason)) n++;
  return n;
}

// ─── Jobs ───────────────────────────────────────────────────────────────

export function viewOnceJobHandlers(deps: ViewOnceDeps) {
  return {
    /** Queued when the last recipient closes it, when a message is deleted, and 14 days after sending. */
    'viewonce.check': async ({ messageId }: { messageId: string }) => {
      await checkViewOnce(deps, messageId);
    },
    /**
     * Private uploads get the automated check like public ones. Videos that aren't MP4 are turned
     * into a web MP4, stored privately too. Nothing public is made: no sizes, poster or preview.
     */
    'media.private': async ({ mediaId, filename }: { mediaId: string; filename?: string | null }) => {
      const r = (await deps.db.query(`SELECT id, owner_id, kind, storage_key, mime FROM media WHERE id = $1 AND private AND deleted_at IS NULL`, [mediaId]))
        .rows[0];
      if (!r?.storage_key) return;
      const data = await readPrivate(deps, r.storage_key);
      if (!data) return;
      const frames: MediaFrame[] = [];
      if (r.kind === 'image') {
        const still = await sharp(data)
          .rotate()
          .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        frames.push({ data: still, mime: 'image/jpeg', label: 'image' });
      } else if (r.kind === 'video') {
        const dir = await mkdtemp(path.join(tmpdir(), 'ypl-private-'));
        try {
          const input = path.join(dir, 'input');
          await writeFile(input, data);
          const info = await probe(input);
          if (r.mime !== 'video/mp4') {
            const web = path.join(dir, 'web.mp4');
            await run([
              '-i',
              input,
              '-vf',
              "scale='min(1280,iw)':-2",
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-crf',
              '23',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              ...NO_METADATA,
              '-movflags',
              '+faststart',
              web,
            ]);
            const key = await putPrivate(deps, await readFile(web), 'mp4', 'video/mp4');
            const swapped = await deps.db.query(
              `UPDATE media SET storage_key = $2, mime = 'video/mp4', size_bytes = $3 WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
              [r.id, key, (await stat(web)).size],
            );
            // Viewed and deleted while this ran: don't leave the new file behind.
            await removePrivate(deps, swapped.rowCount ? r.storage_key : key);
          }
          await deps.db.query(
            `UPDATE media SET duration_ms = coalesce($2, duration_ms), width = coalesce(width, $3), height = coalesce(height, $4) WHERE id = $1`,
            [r.id, info.durationMs, info.width, info.height],
          );
          const times = [1, ...sampleTimes(info.durationMs)];
          for (const [i, t] of times.entries()) {
            const out = path.join(dir, `frame${i}.jpg`);
            const ok = await run(['-ss', String(t), '-i', input, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", '-q:v', '4', out]).then(
              () => true,
              () => false,
            );
            if (ok && (await stat(out).catch(() => null))?.size) frames.push({ data: await readFile(out), mime: 'image/jpeg', label: `frame@${t}s` });
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      if (deps.moderator && deps.moderator.name !== 'none' && frames.length) {
        const result = await deps.moderator.moderate(frames, { mediaId: r.id, kind: r.kind, filename: filename ?? null });
        await recordVerdict(deps.db, deps.realtime, { id: r.id, ownerId: r.owner_id, kind: r.kind }, deps.moderator.name, result);
      }
    },
  };
}
