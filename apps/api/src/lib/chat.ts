import type { Pool, PoolClient } from 'pg';
import type { MessagePreview, MessageReaction } from '@yapilapi/shared';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import type { MediaStorage } from './storage.ts';
import { endViewOnce } from './view-once.ts';
import { usersByIds } from './users.ts';

type Q = Pool | PoolClient;

/**
 * Chat helpers shared by the messaging module and the job worker: reply and pin
 * previews, reaction counts, taking back access to the files of an unsent or
 * expired message, and deleting disappearing messages once they expire.
 */
export interface ChatDeps {
  db: Pool;
  config: Config;
  storage: MediaStorage;
  realtime?: RealtimeHub;
}

// ─── Previews and reactions ─────────────────────────────────────────────

/** How each message looks as a quote (a reply's original, or a pinned message) to one reader. */
export async function messagePreviews(db: Q, ids: string[], readerId: string): Promise<Map<string, MessagePreview>> {
  const out = new Map<string, MessagePreview>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const { rows } = await db.query(
    `SELECT m.id, m.sender_id, left(m.body, 200) AS body, m.attachments->0->>'kind' AS attachment_kind, m.created_at, m.deleted_at, m.unsent_at,
            m.moderation_status, m.kind,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = m.sender_id) AS blocked
     FROM messages m WHERE m.id = ANY($1::uuid[])`,
    [unique, readerId],
  );
  const users = await usersByIds(
    db,
    rows.map((r) => r.sender_id as string),
  );
  const gone = (id: string): MessagePreview => ({ id, available: false, sender: null, body: '', attachmentKind: null, createdAt: null });
  for (const id of unique) out.set(id, gone(id));
  for (const r of rows) {
    const visible = !r.blocked && (r.moderation_status === 'normal' || r.sender_id === readerId) && r.kind !== 'system';
    if (!visible || (r.deleted_at && !r.unsent_at)) continue;
    const base = { id: r.id, available: true, sender: users.get(r.sender_id) ?? null, createdAt: r.created_at.toISOString() };
    out.set(
      r.id,
      r.unsent_at ? { ...base, unsent: true, body: '', attachmentKind: null } : { ...base, body: r.body, attachmentKind: r.attachment_kind ?? null },
    );
  }
  return out;
}

/** Reactions on each message, counted by emoji, with whether the reader is one of them. */
export async function reactionSummaries(db: Q, ids: string[], readerId: string): Promise<Map<string, MessageReaction[]>> {
  const out = new Map<string, MessageReaction[]>();
  if (!ids.length) return out;
  const { rows } = await db.query<{ message_id: string; emoji: string; count: number; mine: boolean }>(
    `SELECT r.message_id, r.emoji, count(*)::int AS count, bool_or(r.user_id = $2) AS mine
     FROM message_reactions r
     WHERE r.message_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = r.user_id)
     GROUP BY r.message_id, r.emoji ORDER BY count(*) DESC, min(r.emoji)`,
    [ids, readerId],
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, mine: r.mine });
    out.set(r.message_id, list);
  }
  return out;
}

// ─── Files ──────────────────────────────────────────────────────────────

/** The storage keys behind a media row's public addresses (…/media/<key>). */
function storedKeys(row: {
  url: string | null;
  poster_url: string | null;
  hls_url: string | null;
  variants: Record<string, string> | null;
  storage_key: string | null;
}) {
  const keys = new Set<string>();
  if (row.storage_key) keys.add(row.storage_key);
  for (const u of [row.url, row.poster_url, row.hls_url, ...Object.values(row.variants ?? {})]) {
    if (typeof u !== 'string') continue;
    const at = u.indexOf('/media/');
    if (at >= 0) keys.add(u.slice(at + '/media/'.length).split('?')[0]!);
  }
  return [...keys].filter((k) => /^[\w/.-]+$/.test(k) && !k.includes('..') && !k.startsWith('private/'));
}

/**
 * Take back access to the files of an unsent or expired message: each one the sender
 * uploaded that isn't used anywhere else (a post, a story, another message) is deleted
 * from storage, so its address stops working for everyone. Returns how many were removed.
 */
export async function revokeChatMedia(deps: Pick<ChatDeps, 'db' | 'storage'>, ownerId: string, mediaIds: string[]): Promise<number> {
  const ids = [...new Set(mediaIds.filter(Boolean))];
  if (!ids.length) return 0;
  const { rows } = await deps.db.query(
    `SELECT m.id, m.url, m.poster_url, m.hls_url, m.variants, m.storage_key FROM media m
     WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND m.deleted_at IS NULL AND NOT m.private
       AND NOT EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM moments mo WHERE mo.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.deleted_at IS NULL AND x.attachments @> jsonb_build_array(jsonb_build_object('mediaId', m.id::text)))`,
    [ids, ownerId],
  );
  for (const r of rows) {
    for (const key of storedKeys(r)) await deps.storage.remove?.(key).catch(() => {});
    await deps.db.query(`UPDATE media SET deleted_at = now(), storage_key = NULL WHERE id = $1`, [r.id]);
  }
  return rows.length;
}

/** The media ids of a message's attachments. */
export const mediaIdsOf = (attachments: { mediaId?: string }[] | null | undefined): string[] =>
  (attachments ?? []).map((a) => a.mediaId).filter((x): x is string => !!x);

// ─── Disappearing messages ──────────────────────────────────────────────

/**
 * Delete messages whose disappearing time has passed, with their files, reactions,
 * pins and edit history. Everyone in the chat gets `message.deleted`. Returns how many.
 */
export async function expireMessages(deps: ChatDeps, limit = 200): Promise<number> {
  const { db } = deps;
  const { rows } = await db.query<{ id: string; conversation_id: string; sender_id: string; attachments: { mediaId?: string }[]; view_once: boolean }>(
    `SELECT id, conversation_id, sender_id, attachments, view_once FROM messages WHERE expires_at <= now() ORDER BY expires_at LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const m of rows) {
    // A view-once file is private: delete it the way view once does.
    if (m.view_once) await endViewOnce(deps, m.id, 'deleted').catch(() => false);
    const done = await db.query(`DELETE FROM messages WHERE id = $1 AND expires_at <= now() RETURNING id`, [m.id]);
    if (!done.rowCount) continue;
    n++;
    await revokeChatMedia(deps, m.sender_id, mediaIdsOf(m.attachments)).catch(() => 0);
    if (deps.realtime) {
      const members = (
        await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [m.conversation_id])
      ).rows.map((r) => r.user_id);
      await deps.realtime.publish(members, { type: 'message.deleted', data: { id: m.id, conversationId: m.conversation_id, reason: 'expired' } });
    }
  }
  return n;
}

export function chatJobHandlers(deps: ChatDeps) {
  return {
    /** Queued for each disappearing message at its expiry; deletes every message that is due. */
    'messages.expire': async () => {
      await expireMessages(deps);
    },
  };
}
