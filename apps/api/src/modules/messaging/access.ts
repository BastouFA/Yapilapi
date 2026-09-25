import type { Queryable } from '@yapilapi/database';
import { AppError, forbidden, notFound } from '@yapilapi/shared';
import { getMembership } from '../../lib/community-access.js';
import { isBlockedEitherWay } from '../../lib/users.js';

export type ConvKind = 'direct' | 'group' | 'community_channel';
export type ConvRole = 'owner' | 'admin' | 'member';

export interface ConversationRow {
  id: string;
  kind: ConvKind;
  title: string | null;
  direct_key: string | null;
  community_id: string | null;
  channel_name: string | null;
  channel_kind: 'text' | 'voice' | null;
  created_by: string | null;
  last_message_at: Date | null;
  created_at: Date;
}

export interface ConvAccess {
  conv: ConversationRow;
  /** Group role; null for direct conversations and community channels. */
  role: ConvRole | null;
  /** History before this instant is hidden from the member (groups); null for direct/channels. */
  joinedAt: Date | null;
  /** Same instant with full microsecond precision (JS Dates truncate to ms) for SQL comparisons. */
  joinedAtRaw: string | null;
  /** The other participant of a direct conversation. */
  peerId: string | null;
  canSend: boolean;
  /** Group owner/admin: rename, add and remove members. */
  canManage: boolean;
}

export const CONV_COLS =
  'id, kind, title, direct_key, community_id, channel_name, channel_kind, created_by, last_message_at, created_at';

/**
 * THE conversation access rule. Returns null (callers answer 404, never 403) unless the user may read the
 * conversation right now:
 *  - direct/group: an ACTIVE member (left_at IS NULL); direct conversations additionally vanish when either
 *    participant has blocked the other.
 *  - community_channel: derived from ACTIVE community membership (banned/left/pending are denied); sending needs
 *    the community permission 'post'.
 */
export async function loadAccess(
  db: Queryable,
  conversationId: string,
  userId: string,
): Promise<ConvAccess | null> {
  const { rows } = await db.query<ConversationRow>(
    `SELECT ${CONV_COLS} FROM conversations WHERE id = $1`,
    [conversationId],
  );
  const conv = rows[0];
  if (!conv) return null;

  if (conv.kind === 'community_channel') {
    const m = await getMembership(db, conv.community_id!, userId);
    if (!m) return null;
    return {
      conv,
      role: null,
      joinedAt: null,
      joinedAtRaw: null,
      peerId: null,
      canSend: m.permissions.includes('post'),
      canManage: false,
    };
  }

  const mem = await db.query<{ role: ConvRole; joined_at: Date; joined_raw: string }>(
    'SELECT role, joined_at, joined_at::text AS joined_raw FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
    [conversationId, userId],
  );
  const me = mem.rows[0];
  if (!me) return null;

  if (conv.kind === 'direct') {
    const peer = await db.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2',
      [conversationId, userId],
    );
    const peerId = peer.rows[0]?.user_id ?? null;
    if (peerId && (await isBlockedEitherWay(db, userId, peerId))) return null;
    return {
      conv,
      role: null,
      joinedAt: null,
      joinedAtRaw: null,
      peerId,
      canSend: true,
      canManage: false,
    };
  }
  return {
    conv,
    role: me.role,
    joinedAt: me.joined_at,
    joinedAtRaw: me.joined_raw,
    peerId: null,
    canSend: true,
    canManage: me.role === 'owner' || me.role === 'admin',
  };
}

export async function requireAccess(
  db: Queryable,
  conversationId: string,
  userId: string,
): Promise<ConvAccess> {
  const a = await loadAccess(db, conversationId, userId);
  if (!a) throw notFound('Conversation');
  return a;
}

export type DenialReason = 'recipient_unavailable' | 'recipient_preference' | 'teen_friends_only';

interface PolicyUser {
  id: string;
  status: string;
  age_band: 'teen' | 'adult';
  who: 'everyone' | 'followers' | 'friends' | 'nobody';
}

async function policyUsers(db: Queryable, ids: string[]): Promise<Map<string, PolicyUser>> {
  const { rows } = await db.query<PolicyUser>(
    `SELECT u.id, u.status, u.age_band, COALESCE(up.who_can_message, 'everyone') AS who
       FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function areFriends(db: Queryable, a: string, b: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM friendships WHERE user_low = LEAST($1::uuid, $2::uuid) AND user_high = GREATEST($1::uuid, $2::uuid) AND status = 'accepted'`,
    [a, b],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * May `senderId` start/continue contact with `recipientId`? Returns a machine-readable reason when not.
 * (Block state is handled by loadAccess/resolution so it never leaks through this path.)
 *  - recipient must be an active account
 *  - teens (either side) may only exchange messages with ACCEPTED friends
 *  - recipient's who_can_message: everyone | followers (sender follows recipient) | friends | nobody
 */
export async function contactDenial(
  db: Queryable,
  senderId: string,
  recipientId: string,
): Promise<DenialReason | null> {
  const users = await policyUsers(db, [senderId, recipientId]);
  const s = users.get(senderId);
  const r = users.get(recipientId);
  if (!s || !r || !['active', 'pending_deletion'].includes(r.status))
    return 'recipient_unavailable';
  const friends = await areFriends(db, senderId, recipientId);
  if ((s.age_band === 'teen' || r.age_band === 'teen') && !friends) return 'teen_friends_only';
  switch (r.who) {
    case 'nobody':
      return 'recipient_preference';
    case 'friends':
      return friends ? null : 'recipient_preference';
    case 'followers': {
      if (friends) return null;
      const f = await db.query(
        `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2 AND status = 'active'`,
        [senderId, recipientId],
      );
      return f.rowCount ? null : 'recipient_preference';
    }
    default:
      return null;
  }
}

export function denialError(reason: DenialReason): AppError {
  const message =
    reason === 'teen_friends_only'
      ? 'Accounts for people under 18 can only message accepted friends'
      : reason === 'recipient_unavailable'
        ? 'This person is not available to message'
        : 'This person is not accepting messages from you';
  return new AppError('forbidden', message, { reason });
}

/** Sending into a direct conversation re-applies the contact rules (preferences may have changed since it was created). */
export async function assertCanContactPeer(
  db: Queryable,
  access: ConvAccess,
  userId: string,
): Promise<void> {
  if (access.conv.kind !== 'direct' || !access.peerId) return;
  const reason = await contactDenial(db, userId, access.peerId);
  if (reason) throw denialError(reason);
}

/**
 * Group composition rules for teens: every pair that involves a newly added member and a teen must be
 * accepted friends. `all` = final membership, `added` = the members being added now.
 */
export async function teenGroupDenial(
  db: Queryable,
  all: string[],
  added: string[],
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM users t
       JOIN unnest($1::uuid[]) o(id) ON o.id <> t.id
      WHERE t.id = ANY($1::uuid[]) AND t.age_band = 'teen' AND (t.id = ANY($2::uuid[]) OR o.id = ANY($2::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_low = LEAST(t.id, o.id) AND f.user_high = GREATEST(t.id, o.id) AND f.status = 'accepted')
      LIMIT 1`,
    [all, added],
  );
  return (rowCount ?? 0) > 0;
}

export function requireSend(access: ConvAccess): void {
  if (!access.canSend) throw forbidden('You do not have permission to post in this conversation');
}

export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
