import type { Pool, PoolClient } from 'pg';
import type { RealtimeHub } from './realtime.ts';
import { messagePreviews } from './chat.ts';
import type { RecentMessage } from './push.ts';
import { activeControls } from './family.ts';
import { isEnabled, notify } from './services.ts';
import { ageOf } from './users.ts';

type Q = Pool | PoolClient;

/**
 * More messages in a chat join the push that's already there (it's still unread), and each one
 * updates it ("Ada: 3 new messages", with the newest under it). It rings or buzzes again once the
 * last time it did is this old; sooner, it changes quietly, so a quick run of messages buzzes once.
 */
export const MESSAGE_ALERT_AGAIN_SECONDS = 20;

/** A push for several messages shows at most this many of the newest under the count. */
export const PUSH_RECENT_MESSAGES = 3;

/** A voice message's push says at most this much of what was said (its transcript). */
export const PUSH_TRANSCRIPT_CHARS = 80;

/** The first words of a transcript, cut between words: "See you at six, and bring…". */
export function firstWords(text: string, max = PUSH_TRANSCRIPT_CHARS): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A new message pushes, like a messenger, to everyone in the chat who isn't connected right now
 * (people who are see it arrive): "Ada: See you at six", "Ada in Family: Photo". One notification
 * per chat while it's unread ("Ada: 3 new messages"); reading the chat clears it
 * (POST /v1/conversations/:id/read). It never shows in the Activity list (PUSH_ONLY_TYPES).
 *
 * Messages people write, of any sort (text, photos, voice notes, replies, polls, lists, games,
 * mixes, a place sent once); not lines the server writes (calls, who joined, game results), Yaps
 * (they push as yap_received), live locations (location_shared), Market cards and offers (their own
 * pushes), messages held for a check (until a moderator lets them through) or community chats.
 *
 * notify applies the person's own settings: the Messages category, blocks and muted people, a
 * pause, focus mode and quiet hours (theirs, and a supervised teen's). Here: only active accounts,
 * the minor-safety rule and family settings (like Yaps, lib/yaps.ts), and a message request (someone
 * who isn't a friend writing first in a one-to-one chat) pushes for its first message only, until
 * they write back. The text says only what the recipient would see in the chat, and a disappearing
 * message only what it is (lib/push.ts, messageText). A voice note with a transcript says its first
 * words (lib/voice-transcripts.ts sends its push once the words are ready); view-once and
 * disappearing ones are never transcribed.
 */
export async function pushNewMessage(deps: { db: Q; realtime: RealtimeHub }, messageId: string): Promise<void> {
  const { db, realtime } = deps;
  const m = (
    await db.query<{
      id: string;
      conversation_id: string;
      sender_id: string;
      expires_at: Date | null;
      chat_kind: string;
      title: string | null;
      created_by: string;
      sender_birth: Date | null;
      wrote_before: boolean;
      transcript: string | null;
    }>(
      `SELECT m.id, m.conversation_id, m.sender_id, m.expires_at, c.kind AS chat_kind, c.title, c.created_by, u.birth_date AS sender_birth,
              (SELECT t.body FROM message_transcripts t WHERE t.message_id = m.id AND t.status = 'ready' AND NOT m.view_once AND m.expires_at IS NULL) AS transcript,
              EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = m.conversation_id AND x.sender_id = m.sender_id AND x.kind <> 'system'
                      AND x.moderation_status = 'normal' AND (x.created_at, x.id) < (m.created_at, m.id)) AS wrote_before
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1 AND m.kind = 'message' AND m.deleted_at IS NULL AND m.moderation_status = 'normal' AND (m.expires_at IS NULL OR m.expires_at > now())`,
      [messageId],
    )
  ).rows[0];
  if (!m || m.chat_kind === 'community') return;
  const { rows } = await db.query<{ id: string; birth_date: Date | null; friends: boolean; family: boolean; wrote: boolean; last_read_at: Date }>(
    `SELECT u.id, u.birth_date, cm.last_read_at,
            EXISTS (SELECT 1 FROM friendships f WHERE f.user_a = LEAST(u.id, $2::uuid) AND f.user_b = GREATEST(u.id, $2::uuid)) AS friends,
            EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
                    AND ((fl.guardian_id = $2 AND fl.teen_id = u.id) OR (fl.guardian_id = u.id AND fl.teen_id = $2))) AS family,
            EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = $1 AND x.sender_id = u.id AND x.kind <> 'system') AS wrote
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND cm.user_id <> $2 AND u.status = 'active'`,
    [m.conversation_id, m.sender_id],
  );
  const senderAge = ageOf(m.sender_birth);
  const transcript = m.transcript && (await isEnabled(db, 'VOICE_TRANSCRIPTS')) ? firstWords(m.transcript) : null;
  for (const r of rows) {
    if (realtime.isOnline(r.id)) continue;
    const age = ageOf(r.birth_date);
    const close = r.friends || r.family;
    if ((age !== null && age < 18) !== (senderAge !== null && senderAge < 18) && !close) continue;
    const controls = await activeControls(db, r.id);
    if (controls && !controls.guardianIds.includes(m.sender_id) && (controls.messagesFrom === 'nobody' || !r.friends)) continue;
    // A message request: one push, for the first message, until they write back.
    if (m.chat_kind === 'direct' && !close && !r.wrote && m.created_by !== r.id && m.wrote_before) continue;
    // The message as they see it (nothing when they can't, for example from someone they blocked).
    const preview = (await messagePreviews(db, [m.id], r.id)).get(m.id);
    if (!preview?.available) continue;
    const recent = await recentUnread(db, m.conversation_id, r.id, r.last_read_at);
    await notify(db, realtime, {
      userId: r.id,
      category: 'messages',
      type: 'message',
      actorId: m.sender_id,
      entityType: 'conversation',
      entityId: m.conversation_id,
      group: m.conversation_id,
      messages: { alertAgainSeconds: MESSAGE_ALERT_AGAIN_SECONDS },
      pushData: {
        preview: { ...preview, sender: null },
        recent,
        private: !!m.expires_at,
        chat: m.chat_kind === 'group' ? m.title : null,
        ...(transcript && preview.attachmentKind === 'audio' ? { transcript } : {}),
      },
    });
  }
}

/**
 * The newest messages someone hasn't read in a chat (oldest first), as they'd see them, for a push
 * about several: only ones that push (lib/push.ts says a disappearing one's kind, never its words).
 */
async function recentUnread(db: Q, conversationId: string, readerId: string, since: Date): Promise<RecentMessage[]> {
  const { rows } = await db.query<{ id: string; private: boolean; name: string | null }>(
    `SELECT m.id, m.expires_at IS NOT NULL AS private, p.display_name AS name
     FROM messages m LEFT JOIN profiles p ON p.user_id = m.sender_id
     WHERE m.conversation_id = $1 AND m.sender_id <> $2 AND m.kind = 'message' AND m.created_at > $3
       AND m.deleted_at IS NULL AND m.moderation_status = 'normal' AND (m.expires_at IS NULL OR m.expires_at > now())
     ORDER BY m.created_at DESC, m.id DESC LIMIT $4`,
    [conversationId, readerId, since, PUSH_RECENT_MESSAGES],
  );
  const previews = await messagePreviews(
    db,
    rows.map((r) => r.id),
    readerId,
  );
  return rows.reverse().flatMap((r) => {
    const p = previews.get(r.id);
    return p?.available ? [{ preview: { ...p, sender: null }, private: r.private, name: r.name }] : [];
  });
}

/** Reading a chat: its message push is done with, and a Yap's notification is read. */
export async function clearMessagePushes(db: Q, userId: string, conversationId: string): Promise<void> {
  await db.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'message' AND entity_type = 'conversation' AND entity_id = $2`, [
    userId,
    conversationId,
  ]);
  await db.query(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND type = 'yap_received' AND entity_type = 'conversation' AND entity_id = $2 AND read_at IS NULL`,
    [userId, conversationId],
  );
}
