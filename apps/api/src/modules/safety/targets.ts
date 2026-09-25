import type { Queryable } from '@yapilapi/database';
import { AppError } from '@yapilapi/shared';
import { momentVisibleSql, loadVisiblePost } from '../../lib/visibility.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { eventVisibleSql } from '../events/access.js';
import { loadAccess } from '../messaging/access.js';
import { loadCommunity } from '../communities/service.js';
import type { DbRow } from '../../lib/db-row.js';

export const REPORT_TARGET_TYPES = [
  'user',
  'post',
  'comment',
  'moment',
  'message',
  'community',
  'event',
  'product',
  'place',
  'business',
  'live_session',
  'review',
] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export interface TargetInfo {
  subjectUserId: string | null;
  snapshot: Record<string, unknown>;
}

const clip = (s: unknown, n = 2000): string | null =>
  typeof s === 'string' ? s.slice(0, n) : null;

interface Spec {
  /** Staff-scope loader: no visibility rules. `$1` = target id. */
  sql: string;
  subject(r: DbRow): string | null;
  snapshot(r: DbRow): Record<string, unknown>;
}

const SPECS: Record<ReportTargetType, Spec> = {
  user: {
    sql: `SELECT u.id, u.status, p.username, p.display_name, p.bio, u.created_at FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.deleted_at IS NULL`,
    subject: (r) => r.id,
    snapshot: (r) => ({
      username: r.username,
      displayName: r.display_name,
      bio: clip(r.bio, 500),
      accountStatus: r.status,
    }),
  },
  post: {
    sql: `SELECT id, author_id, kind, body, visibility, moderation_status, created_at, deleted_at FROM posts WHERE id = $1`,
    subject: (r) => r.author_id,
    snapshot: (r) => ({
      kind: r.kind,
      text: clip(r.body),
      visibility: r.visibility,
      moderationStatus: r.moderation_status,
      createdAt: r.created_at,
      deleted: Boolean(r.deleted_at),
    }),
  },
  comment: {
    sql: `SELECT id, post_id, author_id, body, moderation_status, created_at, deleted_at FROM comments WHERE id = $1`,
    subject: (r) => r.author_id,
    snapshot: (r) => ({
      text: clip(r.body),
      postId: r.post_id,
      moderationStatus: r.moderation_status,
      createdAt: r.created_at,
      deleted: Boolean(r.deleted_at),
    }),
  },
  moment: {
    sql: `SELECT id, author_id, kind, body, visibility, moderation_status, created_at, deleted_at FROM moments WHERE id = $1`,
    subject: (r) => r.author_id,
    snapshot: (r) => ({
      kind: r.kind,
      text: clip(r.body),
      visibility: r.visibility,
      moderationStatus: r.moderation_status,
      createdAt: r.created_at,
      deleted: Boolean(r.deleted_at),
    }),
  },
  message: {
    // Only the reported message itself: staff never get a conversation dump through this path.
    sql: `SELECT m.id, m.sender_id, m.kind, m.body, m.moderation_status, m.created_at, m.deleted_at, c.kind AS conversation_kind FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1`,
    subject: (r) => r.sender_id,
    snapshot: (r) => ({
      kind: r.kind,
      text: clip(r.body, 4000),
      conversationKind: r.conversation_kind,
      moderationStatus: r.moderation_status,
      createdAt: r.created_at,
      deleted: Boolean(r.deleted_at),
    }),
  },
  review: {
    sql: `SELECT id, author_id, target_type, target_id, rating, body, moderation_status, created_at, deleted_at FROM reviews WHERE id = $1`,
    subject: (r) => r.author_id,
    snapshot: (r) => ({
      text: clip(r.body),
      rating: r.rating,
      reviewOf: `${r.target_type}:${r.target_id}`,
      moderationStatus: r.moderation_status,
      createdAt: r.created_at,
      deleted: Boolean(r.deleted_at),
    }),
  },
  community: {
    sql: `SELECT id, created_by, name, description, visibility, created_at, deleted_at FROM communities WHERE id = $1`,
    subject: (r) => r.created_by,
    snapshot: (r) => ({
      name: r.name,
      description: clip(r.description, 1000),
      visibility: r.visibility,
      deleted: Boolean(r.deleted_at),
    }),
  },
  event: {
    sql: `SELECT id, host_id, title, description, status, visibility, created_at, deleted_at FROM events WHERE id = $1`,
    subject: (r) => r.host_id,
    snapshot: (r) => ({
      title: r.title,
      description: clip(r.description, 1000),
      status: r.status,
      visibility: r.visibility,
      deleted: Boolean(r.deleted_at),
    }),
  },
  product: {
    sql: `SELECT p.id, COALESCE(p.seller_user_id, b.owner_id) AS owner_id, p.title, p.description, p.status, p.created_at, p.deleted_at
            FROM products p LEFT JOIN businesses b ON b.id = p.business_id WHERE p.id = $1`,
    subject: (r) => r.owner_id,
    snapshot: (r) => ({
      title: r.title,
      description: clip(r.description, 1000),
      status: r.status,
      deleted: Boolean(r.deleted_at),
    }),
  },
  place: {
    sql: `SELECT id, created_by, name, description, created_at, deleted_at FROM places WHERE id = $1`,
    subject: (r) => r.created_by,
    snapshot: (r) => ({
      name: r.name,
      description: clip(r.description, 1000),
      deleted: Boolean(r.deleted_at),
    }),
  },
  business: {
    sql: `SELECT id, owner_id, name, description, status, created_at, deleted_at FROM businesses WHERE id = $1`,
    subject: (r) => r.owner_id,
    snapshot: (r) => ({
      name: r.name,
      description: clip(r.description, 1000),
      status: r.status,
      deleted: Boolean(r.deleted_at),
    }),
  },
  live_session: {
    sql: `SELECT id, host_id, title, description, status, visibility, created_at FROM live_sessions WHERE id = $1`,
    subject: (r) => r.host_id,
    snapshot: (r) => ({
      title: r.title,
      description: clip(r.description, 1000),
      status: r.status,
      visibility: r.visibility,
    }),
  },
};

/** Staff-scope load (no visibility rules): the target's owner and an evidence snapshot, or null if it does not exist. */
export async function loadTargetForStaff(
  db: Queryable,
  type: ReportTargetType,
  id: string,
): Promise<(TargetInfo & { row: DbRow }) | null> {
  const spec = SPECS[type];
  const { rows } = await db.query(spec.sql, [id]);
  const row = rows[0];
  return row ? { subjectUserId: spec.subject(row), snapshot: spec.snapshot(row), row } : null;
}

/**
 * Can `viewerId` SEE this target right now? Reuses the central visibility predicates so that nobody can use the
 * report form to probe for content they may not access. Returns null (callers answer 404) when not visible.
 */
export async function loadTargetForViewer(
  db: Queryable,
  viewerId: string,
  type: ReportTargetType,
  id: string,
): Promise<TargetInfo | null> {
  const spec = SPECS[type];
  const staff = async () => {
    const { rows } = await db.query(spec.sql, [id]);
    return rows[0] as DbRow | undefined;
  };
  const wrap = (row: DbRow | undefined): TargetInfo | null =>
    row ? { subjectUserId: spec.subject(row), snapshot: spec.snapshot(row) } : null;
  const blockedByOwner = async (owner: string | null) =>
    Boolean(owner && owner !== viewerId && (await isBlockedEitherWay(db, viewerId, owner)));

  switch (type) {
    case 'user': {
      const r = await staff();
      if (!r || !['active', 'pending_deletion'].includes(r.status)) return null;
      // Someone who blocked the reporter is invisible to them; the reporter may still report a user they blocked.
      const b = await db.query(
        'SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
        [id, viewerId],
      );
      return b.rowCount ? null : wrap(r);
    }
    case 'post': {
      const p = await loadVisiblePost(db, viewerId, id);
      return p ? wrap(await staff()) : null;
    }
    case 'comment': {
      const r = await staff();
      if (!r || r.deleted_at || r.moderation_status !== 'approved') return null;
      if (!(await loadVisiblePost(db, viewerId, r.post_id))) return null;
      const hidden = await db.query(
        'SELECT hidden_by_restriction, (SELECT author_id FROM posts WHERE id = c.post_id) AS post_author FROM comments c WHERE id = $1',
        [id],
      );
      if (hidden.rows[0]?.hidden_by_restriction && hidden.rows[0].post_author !== viewerId)
        return null;
      return (await blockedByOwner(r.author_id)) ? null : wrap(r);
    }
    case 'moment': {
      const { rows } = await db.query(
        `SELECT m.id FROM moments m WHERE m.id = $2 AND ${momentVisibleSql('$1::uuid', 'm')}`,
        [viewerId, id],
      );
      return rows[0] ? wrap(await staff()) : null;
    }
    case 'message': {
      const r = await staff();
      if (!r || r.deleted_at || r.moderation_status === 'removed') return null;
      const conv = await db.query<{ conversation_id: string }>(
        'SELECT conversation_id FROM messages WHERE id = $1',
        [id],
      );
      const access = await loadAccess(db, conv.rows[0]!.conversation_id, viewerId);
      if (!access) return null;
      if (access.joinedAt && new Date(r.created_at) < access.joinedAt) return null; // history before joining a group is not visible
      return wrap(r);
    }
    case 'review': {
      const r = await staff();
      if (!r || r.deleted_at || r.moderation_status !== 'approved') return null;
      return (await blockedByOwner(r.author_id)) ? null : wrap(r);
    }
    case 'community': {
      try {
        await loadCommunity(db, id, viewerId);
      } catch (e) {
        if (e instanceof AppError && e.status === 404) return null;
        throw e;
      }
      return wrap(await staff());
    }
    case 'event': {
      const { rows } = await db.query(
        `SELECT e.id FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1::uuid')}`,
        [viewerId, id],
      );
      return rows[0] ? wrap(await staff()) : null;
    }
    case 'product': {
      const r = await staff();
      if (!r || r.deleted_at || !['active', 'sold_out'].includes(r.status)) return null;
      return (await blockedByOwner(r.owner_id)) ? null : wrap(r);
    }
    case 'place': {
      const r = await staff();
      return r && !r.deleted_at ? wrap(r) : null;
    }
    case 'business': {
      const r = await staff();
      return r && !r.deleted_at && r.status === 'active' ? wrap(r) : null;
    }
    case 'live_session': {
      const r = await staff();
      if (!r || r.status === 'cancelled') return null;
      if (r.visibility !== 'public' && r.host_id !== viewerId) return null;
      return (await blockedByOwner(r.host_id)) ? null : wrap(r);
    }
  }
}

// ---------------------------------------------------------------- effects on the target

export type EffectOp =
  | { op: 'set_status'; table: string; id: string; from: string; to: string; restoreTo: string }
  | { op: 'undelete'; table: string; id: string }
  | {
      op: 'set_column';
      table: string;
      id: string;
      column: string;
      from: string;
      to: string;
      restoreTo: string;
    }
  | { op: 'label'; table: string; id: string };

const STATUS_TABLE: Partial<Record<ReportTargetType, string>> = {
  post: 'posts',
  comment: 'comments',
  moment: 'moments',
  message: 'messages',
  review: 'reviews',
};
const METADATA_TABLE: Partial<Record<ReportTargetType, string>> = {
  post: 'posts',
  message: 'messages',
};

/** Types whose content the decision can change (everything except `user`). */
export const isContentTarget = (t: ReportTargetType) => t !== 'user';

export type ContentAction = 'remove' | 'limit_reach' | 'label' | 'no_action';

/**
 * Apply a moderation decision to the reported content and return what changed (so an overturned appeal can undo it).
 * `table`/`column` names come from the constant maps above, never from input.
 */
export async function applyContentAction(
  tx: Queryable,
  type: ReportTargetType,
  id: string,
  action: ContentAction,
  reason: string,
): Promise<EffectOp[]> {
  const ops: EffectOp[] = [];
  const statusTable = STATUS_TABLE[type];
  if (statusTable) {
    const cur = await tx.query<{ moderation_status: string }>(
      `SELECT moderation_status FROM ${statusTable} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const from = cur.rows[0]?.moderation_status;
    if (!from) return ops;
    // Content removed by someone else (owner, community moderators) is never resurrected by a lighter decision here.
    const RELEASABLE = ['pending_review', 'restricted', 'escalated'];
    let to = from;
    if (action === 'remove') to = 'removed';
    else if (action === 'limit_reach') to = from === 'removed' ? from : 'restricted';
    else if (RELEASABLE.includes(from)) to = 'approved';
    if (from !== to) {
      await tx.query(`UPDATE ${statusTable} SET moderation_status = $2 WHERE id = $1`, [id, to]);
      ops.push({ op: 'set_status', table: statusTable, id, from, to, restoreTo: 'approved' });
    }
    const metaTable = METADATA_TABLE[type];
    if (action === 'label' && metaTable) {
      await tx.query(`UPDATE ${metaTable} SET metadata = metadata || $2::jsonb WHERE id = $1`, [
        id,
        JSON.stringify({
          moderationLabel: { reason: reason.slice(0, 200), at: new Date().toISOString() },
        }),
      ]);
      ops.push({ op: 'label', table: metaTable, id });
    }
    return ops;
  }
  if (action !== 'remove') return ops; // reach/label on non-content targets are recorded as warnings against the owner only
  switch (type) {
    case 'community':
    case 'event':
    case 'place':
    case 'product': {
      const table = {
        community: 'communities',
        event: 'events',
        place: 'places',
        product: 'products',
      }[type];
      const r = await tx.query(
        `UPDATE ${table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (r.rowCount) ops.push({ op: 'undelete', table, id });
      break;
    }
    case 'business': {
      const cur = await tx.query<{ status: string }>(
        `SELECT status FROM businesses WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const from = cur.rows[0]?.status;
      if (from && from !== 'suspended') {
        await tx.query(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [id]);
        ops.push({
          op: 'set_column',
          table: 'businesses',
          id,
          column: 'status',
          from,
          to: 'suspended',
          restoreTo: from,
        });
      }
      break;
    }
    case 'live_session': {
      const cur = await tx.query<{ status: string }>(
        `SELECT status FROM live_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const from = cur.rows[0]?.status;
      if (from && ['scheduled', 'live'].includes(from)) {
        await tx.query(`UPDATE live_sessions SET status = 'cancelled' WHERE id = $1`, [id]);
        ops.push({
          op: 'set_column',
          table: 'live_sessions',
          id,
          column: 'status',
          from,
          to: 'cancelled',
          restoreTo: from,
        });
      }
      break;
    }
    default:
      break;
  }
  return ops;
}

/** Undo the content effects of an overturned decision. Only reverts values still in the state we put them in. */
export async function restoreContent(tx: Queryable, ops: readonly EffectOp[]): Promise<number> {
  let restored = 0;
  const allowedTables = new Set([
    'posts',
    'comments',
    'moments',
    'messages',
    'reviews',
    'communities',
    'events',
    'places',
    'products',
    'businesses',
    'live_sessions',
  ]);
  for (const op of ops) {
    if (!allowedTables.has(op.table)) continue; // effects are stored JSON: never trust them as identifiers blindly
    if (op.op === 'set_status') {
      const r = await tx.query(
        `UPDATE ${op.table} SET moderation_status = $3 WHERE id = $1 AND moderation_status = $2`,
        [op.id, op.to, op.restoreTo],
      );
      restored += r.rowCount ?? 0;
    } else if (op.op === 'undelete') {
      const r = await tx.query(`UPDATE ${op.table} SET deleted_at = NULL WHERE id = $1`, [op.id]);
      restored += r.rowCount ?? 0;
    } else if (op.op === 'set_column' && op.column === 'status') {
      const r = await tx.query(`UPDATE ${op.table} SET status = $3 WHERE id = $1 AND status = $2`, [
        op.id,
        op.to,
        op.restoreTo,
      ]);
      restored += r.rowCount ?? 0;
    } else if (op.op === 'label') {
      await tx.query(
        `UPDATE ${op.table} SET metadata = metadata - 'moderationLabel' WHERE id = $1`,
        [op.id],
      );
    }
  }
  return restored;
}
