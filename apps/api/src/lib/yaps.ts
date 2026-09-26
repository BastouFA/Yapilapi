import type { Pool, PoolClient } from 'pg';
import { activeControls } from './family.ts';
import { ageOf } from './users.ts';

type Q = Pool | PoolClient;

/**
 * Yaps: hold-to-talk voice clips that play out loud when they arrive, like a
 * walkie-talkie. A yap is kept in the chat as a voice message; whether it also
 * plays right away is decided here, per recipient, on the server.
 */
export const YAP_MAX_MS = 60_000;
/** Recorders round a little; a clip this much over 60 seconds still counts as 60. */
export const YAP_LENGTH_SLACK_MS = 500;
/** Yaps work in one-to-one chats and small groups. */
export const YAP_MAX_MEMBERS = 12;
/** Per sender, across every chat. */
export const YAP_PER_MINUTE = 30;

/**
 * Why a yap does or doesn't play out loud for someone:
 * - ok: it plays.
 * - blocked: one of them blocked the other. If the recipient blocked the sender it isn't delivered at all.
 * - minor: an adult and someone under 18 who aren't friends (or linked through family).
 * - family: a supervised teen's family settings limit who can reach them.
 * - quiet: a supervised teen's quiet hours.
 * - paused: the recipient paused Yaps everywhere.
 * - focus: the recipient is in focus mode.
 * - off: "Let Yaps play out loud" is off in this chat (the default for people who aren't friends).
 */
export type YapReason = 'ok' | 'blocked' | 'minor' | 'family' | 'quiet' | 'paused' | 'focus' | 'off';

export interface YapRecipient {
  userId: string;
  /** Whether the yap event goes to them at all (the message itself follows the usual rules). */
  deliver: boolean;
  autoplay: boolean;
  reason: YapReason;
}

/** Decide, for each recipient, whether a yap from `senderId` in this chat plays out loud. */
export async function planYap(db: Q, senderId: string, conversationId: string, recipientIds: string[]): Promise<YapRecipient[]> {
  if (!recipientIds.length) return [];
  const sender = (await db.query<{ birth_date: Date | null }>(`SELECT birth_date FROM users WHERE id = $1`, [senderId])).rows[0];
  const senderAge = ageOf(sender?.birth_date ?? null);
  const { rows } = await db.query(
    `SELECT u.id, u.birth_date, cm.yaps_out_loud, coalesce(p.yaps_paused, false) AS paused, coalesce(p.focus_mode, false) AS focus,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $1) AS blocked_sender,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = u.id) AS blocked_by_sender,
            EXISTS (SELECT 1 FROM friendships f WHERE f.user_a = LEAST(u.id, $1::uuid) AND f.user_b = GREATEST(u.id, $1::uuid)) AS friends,
            EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
                    AND ((fl.guardian_id = $1 AND fl.teen_id = u.id) OR (fl.guardian_id = u.id AND fl.teen_id = $1))) AS family
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE cm.conversation_id = $2 AND cm.left_at IS NULL AND cm.user_id = ANY($3::uuid[]) AND cm.user_id <> $1`,
    [senderId, conversationId, recipientIds],
  );
  const out: YapRecipient[] = [];
  for (const r of rows) {
    const silent = (reason: YapReason, deliver = true) => out.push({ userId: r.id, deliver, autoplay: false, reason });
    if (r.blocked_sender) {
      silent('blocked', false);
      continue;
    }
    if (r.blocked_by_sender) {
      silent('blocked');
      continue;
    }
    const age = ageOf(r.birth_date);
    const minorInvolved = (age !== null && age < 18) !== (senderAge !== null && senderAge < 18);
    const close = r.friends || r.family;
    if (minorInvolved && !close) {
      silent('minor');
      continue;
    }
    const controls = await activeControls(db, r.id);
    if (controls && !controls.guardianIds.includes(senderId)) {
      if (controls.messagesFrom === 'nobody' || !r.friends) {
        silent('family');
        continue;
      }
    }
    if (controls?.quietNow) {
      silent('quiet');
      continue;
    }
    if (r.paused) {
      silent('paused');
      continue;
    }
    if (r.focus) {
      silent('focus');
      continue;
    }
    const outLoud = r.yaps_out_loud ?? close;
    if (!outLoud) {
      silent('off');
      continue;
    }
    out.push({ userId: r.id, deliver: true, autoplay: true, reason: 'ok' });
  }
  return out;
}

/** How many yaps someone sent in the last minute, across every chat. */
export async function recentYaps(db: Q, senderId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE sender_id = $1 AND kind = 'yap' AND created_at > now() - interval '1 minute'`,
    [senderId],
  );
  return rows[0]?.n ?? 0;
}
