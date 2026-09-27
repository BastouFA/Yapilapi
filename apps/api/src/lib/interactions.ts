import type { Pool, PoolClient } from 'pg';
import type { InteractionSettings } from '@yapilapi/shared';

type Q = Pool | PoolClient;

/**
 * Settings > Privacy and Notifications: who can message, comment on and mention you, notification
 * quiet hours, and how sensitive photos and videos are shown. Friends always get through the
 * "who can" settings. Stored on user_preferences; an account without a row has the defaults.
 */

const pref = (col: string, user: string, fallback: string) => `coalesce((SELECT up.${col} FROM user_preferences up WHERE up.user_id = ${user}), '${fallback}')`;
const friendsSql = (a: string, b: string) =>
  `EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${a} AND fr.user_b = ${b}) OR (fr.user_a = ${b} AND fr.user_b = ${a}))`;
const followsSql = (follower: string, followee: string) => `EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${follower} AND f.followee_id = ${followee})`;

/**
 * Whether `sender` may message `recipient` under the recipient's "Who can message you": everyone,
 * people they follow, or friends only. Friends always can, and so can someone the recipient has
 * already written to in a one-to-one chat (so a chat the recipient started can always be answered).
 */
export function messagesAllowedSql(sender: string, recipient: string): string {
  const setting = pref('messages_from', recipient, 'everyone');
  return `(${setting} = 'everyone'
    OR ${friendsSql(sender, recipient)}
    OR (${setting} = 'following' AND ${followsSql(recipient, sender)})
    OR EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.kind = 'direct'
               JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ${sender}
               WHERE m.sender_id = ${recipient} AND m.deleted_at IS NULL))`;
}

export async function messagesAllowed(db: Q, sender: string, recipient: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(`SELECT ${messagesAllowedSql('$1::uuid', '$2::uuid')} AS ok`, [sender, recipient]);
  return !!rows[0]?.ok;
}

/**
 * The author's account-wide "Who can comment on your posts" for post `p` and viewer `v`: everyone,
 * people the author follows, or the author's followers. The author and their friends always can.
 * Each post's own comment setting applies on top.
 */
export function accountCommentsAllowedSql(v: string): string {
  const setting = pref('comments_from', 'p.author_id', 'everyone');
  return `(p.author_id = ${v}
    OR ${setting} = 'everyone'
    OR ${friendsSql(v, 'p.author_id')}
    OR (${setting} = 'following' AND ${followsSql('p.author_id', v)})
    OR (${setting} = 'followers' AND ${followsSql(v, 'p.author_id')}))`;
}

/** Whether an @mention by `actor` reaches `recipient` under the recipient's "Who can mention you". */
export function mentionAllowedSql(actor: string, recipient: string): string {
  const setting = pref('mentions_from', recipient, 'everyone');
  return `(${setting} = 'everyone'
    OR (${setting} = 'following' AND (${followsSql(recipient, actor)} OR ${friendsSql(actor, recipient)})))`;
}

/** Whether `user` is inside their own notification quiet hours right now (pushes wait until they end). */
export async function inQuietHours(db: Q, user: string): Promise<boolean> {
  const { rows } = await db.query<{ quiet: boolean }>(
    `SELECT CASE
       WHEN quiet_start IS NULL OR quiet_end IS NULL THEN false
       WHEN quiet_start <= quiet_end THEN (now() AT TIME ZONE quiet_timezone)::time >= quiet_start AND (now() AT TIME ZONE quiet_timezone)::time < quiet_end
       ELSE (now() AT TIME ZONE quiet_timezone)::time >= quiet_start OR (now() AT TIME ZONE quiet_timezone)::time < quiet_end
     END AS quiet
     FROM user_preferences WHERE user_id = $1`,
    [user],
  );
  return !!rows[0]?.quiet;
}

/**
 * Whether viewer `v` gets media the automated check marked sensitive (covered until they choose
 * to see it): adults, unless they chose to see less of it. Never people under 18 or of unknown age.
 */
export function seesSensitiveSql(v: string): string {
  return `coalesce((SELECT uv.birth_date <= current_date - interval '18 years' AND ${pref('sensitive_media', 'uv.id', 'standard')} = 'standard'
                    FROM users uv WHERE uv.id = ${v}), false)`;
}

export async function seesSensitiveMedia(db: Q, viewer: string | null | undefined): Promise<boolean> {
  if (!viewer) return false;
  const { rows } = await db.query<{ ok: boolean }>(`SELECT ${seesSensitiveSql('$1::uuid')} AS ok`, [viewer]);
  return !!rows[0]?.ok;
}

export async function interactionSettings(db: Q, user: string): Promise<InteractionSettings> {
  const { rows } = await db.query(
    `SELECT coalesce(up.messages_from, 'everyone') AS messages_from, coalesce(up.comments_from, 'everyone') AS comments_from,
            coalesce(up.mentions_from, 'everyone') AS mentions_from, to_char(up.quiet_start, 'HH24:MI') AS quiet_start,
            to_char(up.quiet_end, 'HH24:MI') AS quiet_end, coalesce(up.quiet_timezone, 'UTC') AS quiet_timezone,
            coalesce(up.sensitive_media, 'standard') AS sensitive_media,
            NOT coalesce(u.birth_date <= current_date - interval '18 years', false) AS minor
     FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
    [user],
  );
  const r = rows[0] ?? {};
  return {
    messagesFrom: r.messages_from ?? 'everyone',
    commentsFrom: r.comments_from ?? 'everyone',
    mentionsFrom: r.mentions_from ?? 'everyone',
    quietHours: r.quiet_start && r.quiet_end ? { start: r.quiet_start, end: r.quiet_end, timezone: r.quiet_timezone } : null,
    sensitiveMedia: r.minor ? 'less' : (r.sensitive_media ?? 'standard'),
    sensitiveLocked: !!r.minor,
  };
}
