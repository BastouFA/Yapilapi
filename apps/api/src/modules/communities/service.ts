import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError, forbidden, notFound, type CommunityPermission } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';

/** Membership state of a viewer in a community (any status). Permissions are only populated for *active* members. */
export interface Me {
  status: 'active' | 'pending' | 'invited' | 'banned' | 'left';
  roleKey: string;
  rank: number;
  permissions: string[];
}

export interface CommunityRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'public' | 'private' | 'secret';
  join_policy: 'open' | 'request' | 'invite';
  created_by: string | null;
  member_count: number;
  rules: unknown;
  language: string | null;
  is_paid: boolean;
  price_cents: number | null;
  currency: string | null;
  created_at: Date;
}

export const COMMUNITY_COLUMNS = `c.id, c.slug, c.name, c.description, c.visibility, c.join_policy, c.created_by, c.member_count,
  c.rules, c.language, c.is_paid, c.price_cents, c.currency, c.created_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** Slugs that would collide with routes/UI paths or look like ids. */
export const RESERVED_SLUGS = new Set([
  'new',
  'create',
  'mine',
  'search',
  'explore',
  'discover',
  'admin',
  'settings',
  'invitations',
  'yapilapi',
]);

export function can(me: Me | null, ...perms: CommunityPermission[]): boolean {
  return Boolean(me && me.status === 'active' && perms.some((p) => me.permissions.includes(p)));
}

export async function getMe(
  db: Queryable,
  communityId: string,
  userId: string | null,
): Promise<Me | null> {
  if (!userId) return null;
  const { rows } = await db.query<{
    status: Me['status'];
    role_key: string;
    rank: number;
    permissions: string[];
  }>(
    `SELECT m.status, m.role_key, r.rank, r.permissions
       FROM community_members m JOIN community_roles r ON r.community_id = m.community_id AND r.key = m.role_key
      WHERE m.community_id = $1 AND m.user_id = $2`,
    [communityId, userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    status: r.status,
    roleKey: r.role_key,
    rank: r.rank,
    permissions: r.status === 'active' ? r.permissions : [],
  };
}

export interface Loaded {
  c: CommunityRow;
  me: Me | null;
  /** Full detail (rules, resources, feed...) vs. summary only. */
  full: boolean;
}

/**
 * Resolve a community by id or slug for a viewer, applying visibility rules:
 * secret => 404 unless the viewer is an active member or holds a pending invitation; private => summary for
 * non-members; public => full for everyone. Deleted communities are 404.
 */
export async function loadCommunity(
  db: Queryable,
  ref: string,
  viewerId: string | null,
): Promise<Loaded> {
  const { rows } = await db.query<CommunityRow>(
    `SELECT ${COMMUNITY_COLUMNS} FROM communities c WHERE c.deleted_at IS NULL AND ${isUuid(ref) ? 'c.id = $1::uuid' : 'c.slug = $1::citext'}`,
    [ref.toLowerCase()],
  );
  const c = rows[0];
  if (!c) throw notFound('Community');
  const me = await getMe(db, c.id, viewerId);
  const active = me?.status === 'active';
  if (c.visibility === 'secret' && !active && me?.status !== 'invited') throw notFound('Community');
  const full = c.visibility === 'public' || active;
  return { c, me, full };
}

/** Viewer must see the community's full detail (public, or active member). Otherwise 403 (summary is already visible) or 404. */
export async function requireFull(
  db: Queryable,
  ref: string,
  viewerId: string | null,
): Promise<Loaded> {
  const l = await loadCommunity(db, ref, viewerId);
  if (!l.full) throw forbidden('Join this community to see this');
  return l;
}

/** Viewer must be an active member (optionally holding at least one of `perms`). */
export async function requireMember(
  db: Queryable,
  ref: string,
  userId: string,
  ...perms: CommunityPermission[]
): Promise<Loaded & { me: Me }> {
  const l = await loadCommunity(db, ref, userId);
  if (l.me?.status !== 'active') throw forbidden('Only members can do that');
  if (perms.length && !can(l.me, ...perms))
    throw forbidden('You do not have permission to do that');
  return l as Loaded & { me: Me };
}

export async function lockCommunity(tx: Tx, communityId: string): Promise<void> {
  const r = await tx.query(
    'SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [communityId],
  );
  if (!r.rowCount) throw notFound('Community');
}

/** member_count is always recomputed from rows inside the mutating transaction, so it can never drift. */
export async function recountMembers(tx: Queryable, communityId: string): Promise<void> {
  await tx.query(
    `UPDATE communities SET member_count = (SELECT count(*) FROM community_members WHERE community_id = $1 AND status = 'active') WHERE id = $1`,
    [communityId],
  );
}

/** Make `userId` an active member with the base role. Refuses to touch banned users. Caller holds the community lock. */
export async function activateMembership(
  tx: Queryable,
  communityId: string,
  userId: string,
): Promise<void> {
  const r = await tx.query(
    `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'member','active',now())
     ON CONFLICT (community_id, user_id) DO UPDATE SET status = 'active', role_key = 'member', joined_at = now()
       WHERE community_members.status <> 'banned'`,
    [communityId, userId],
  );
  if (!r.rowCount) throw forbidden('You cannot join this community');
  await recountMembers(tx, communityId);
}

export interface TargetMember {
  status: Me['status'];
  roleKey: string;
  rank: number;
}

export async function getTarget(
  db: Queryable,
  communityId: string,
  userId: string,
): Promise<TargetMember | null> {
  const m = await getMe(db, communityId, userId);
  return m ? { status: m.status, roleKey: m.roleKey, rank: m.rank } : null;
}

export function paymentRequired(c: Pick<CommunityRow, 'price_cents' | 'currency'>): AppError {
  return new AppError('payment_required', 'This community requires a paid membership', {
    priceCents: c.price_cents,
    currency: c.currency,
  });
}

export function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  if (s.length < 3) s = `${s}-community`.replace(/^-/, '').slice(0, 50);
  return s;
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function topicsFor(db: Queryable, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const { rows } = await db.query<{ community_id: string; slug: string }>(
    `SELECT ct.community_id, t.slug::text AS slug FROM community_topics ct JOIN topics t ON t.id = ct.topic_id WHERE ct.community_id = ANY($1::uuid[]) ORDER BY t.slug`,
    [ids],
  );
  for (const r of rows) out.set(r.community_id, [...(out.get(r.community_id) ?? []), r.slug]);
  return out;
}

export async function resolveTopicIds(db: Queryable, slugs: string[]): Promise<string[]> {
  const uniq = [...new Set(slugs.map((s) => s.toLowerCase()))];
  if (!uniq.length) return [];
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM topics WHERE slug = ANY($1::citext[])',
    [uniq],
  );
  if (rows.length !== uniq.length)
    throw new AppError('validation_failed', 'One or more topics do not exist');
  return rows.map((r) => r.id);
}

export interface CommunityView {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: string;
  joinPolicy: string;
  memberCount: number;
  language: string | null;
  topics: string[];
  isPaid: boolean;
  priceCents: number | null;
  currency: string | null;
  createdAt: string;
  access: 'full' | 'summary';
  rules?: unknown;
  viewer: {
    status: string;
    roleKey: string | null;
    rank: number | null;
    permissions: string[];
  } | null;
}

export function toView(
  c: CommunityRow,
  topics: string[],
  me: Me | null,
  full: boolean,
): CommunityView {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    visibility: c.visibility,
    joinPolicy: c.join_policy,
    memberCount: c.member_count,
    language: c.language,
    topics,
    isPaid: c.is_paid,
    priceCents: c.price_cents,
    currency: c.currency,
    createdAt: c.created_at.toISOString(),
    access: full ? 'full' : 'summary',
    ...(full ? { rules: c.rules } : {}),
    viewer: me
      ? {
          status: me.status,
          roleKey: me.status === 'active' ? me.roleKey : null,
          rank: me.status === 'active' ? me.rank : null,
          permissions: me.permissions,
        }
      : null,
  };
}

// ------------------------------------------------------------------ exported services

/**
 * Idempotently make a user an active member of a community. This is the ONLY path into a paid community and is meant
 * to be called by the payments module after a payment has succeeded (never from a client-controlled path).
 * Banned users are refused; teens cannot be added to secret communities.
 */
export async function grantCommunityMembership(
  ctx: AppContext,
  communityId: string,
  userId: string,
): Promise<{ status: 'active'; created: boolean }> {
  return withTransaction(ctx.db, async (tx) => {
    await lockCommunity(tx, communityId);
    const u = await tx.query<{ age_band: string }>(
      `SELECT age_band FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
      [userId],
    );
    if (!u.rows[0]) throw notFound('User');
    const cur = await getMe(tx, communityId, userId);
    if (cur?.status === 'banned') throw forbidden('This user is banned from the community');
    if (cur?.status === 'active') return { status: 'active' as const, created: false };
    const c = await tx.query<{ visibility: string }>(
      'SELECT visibility FROM communities WHERE id = $1',
      [communityId],
    );
    if (u.rows[0].age_band === 'teen' && c.rows[0]!.visibility === 'secret')
      throw forbidden('Accounts under 18 cannot join secret communities');
    await activateMembership(tx, communityId, userId);
    return { status: 'active' as const, created: true };
  });
}

export interface CommunityKnowledge {
  communityId: string;
  rules: unknown;
  resources: Array<{
    id: string;
    title: string;
    url: string | null;
    body: string;
    pinned: boolean;
  }>;
  decisions: Array<{
    id: string;
    kind: string;
    question: string | null;
    body: string;
    createdAt: string;
  }>;
}

/**
 * The human-authored knowledge community AI may quote: rules, resources and decisions/FAQ. Returned ONLY when the
 * viewer is an active member (null otherwise, including for unknown/deleted communities). Community AI must not
 * invent decisions: everything here was written by a person holding `moderate` or `manage_settings`.
 */
export async function listCommunityKnowledge(
  ctx: AppContext,
  communityId: string,
  viewerId: string,
): Promise<CommunityKnowledge | null> {
  const me = await getMe(ctx.db, communityId, viewerId);
  if (me?.status !== 'active') return null;
  const [c, resources, decisions] = await Promise.all([
    ctx.db.query<{ rules: unknown }>(
      'SELECT rules FROM communities WHERE id = $1 AND deleted_at IS NULL',
      [communityId],
    ),
    ctx.db.query(
      `SELECT id, title, url, body, pinned FROM community_resources WHERE community_id = $1 AND deleted_at IS NULL ORDER BY pinned DESC, created_at DESC LIMIT 100`,
      [communityId],
    ),
    ctx.db.query(
      `SELECT id, kind, question, body, created_at FROM community_decisions WHERE community_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`,
      [communityId],
    ),
  ]);
  if (!c.rows[0]) return null;
  return {
    communityId,
    rules: c.rows[0].rules,
    resources: resources.rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      body: r.body,
      pinned: r.pinned,
    })),
    decisions: decisions.rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      question: d.question,
      body: d.body,
      createdAt: (d.created_at as Date).toISOString(),
    })),
  };
}

/**
 * Account-deletion hook body: ownerless communities with other active members pass ownership to the highest-ranked
 * member (longest-standing on ties); sole-member communities are soft-deleted; all of the user's membership rows go.
 */
export async function removeUserFromCommunities(tx: Tx, userId: string): Promise<void> {
  const { rows: mine } = await tx.query<{ community_id: string; role_key: string; status: string }>(
    'SELECT community_id, role_key, status FROM community_members WHERE user_id = $1 ORDER BY community_id',
    [userId],
  );
  for (const m of mine) {
    if (m.role_key !== 'owner' || m.status !== 'active') continue;
    const lock = await tx.query(
      'SELECT 1 FROM communities WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [m.community_id],
    );
    if (!lock.rowCount) continue;
    const succ = await tx.query<{ user_id: string }>(
      `SELECT m2.user_id FROM community_members m2
         JOIN community_roles r ON r.community_id = m2.community_id AND r.key = m2.role_key
         JOIN users u ON u.id = m2.user_id AND u.deleted_at IS NULL AND u.status IN ('active','pending_deletion')
        WHERE m2.community_id = $1 AND m2.status = 'active' AND m2.user_id <> $2
        ORDER BY r.rank DESC, m2.joined_at ASC NULLS LAST, m2.user_id LIMIT 1`,
      [m.community_id, userId],
    );
    if (succ.rows[0]) {
      await tx.query(
        `UPDATE community_members SET role_key = 'owner' WHERE community_id = $1 AND user_id = $2`,
        [m.community_id, succ.rows[0].user_id],
      );
    } else {
      await tx.query('UPDATE communities SET deleted_at = now() WHERE id = $1', [m.community_id]);
    }
  }
  await tx.query('DELETE FROM community_members WHERE user_id = $1', [userId]);
  for (const m of mine) await recountMembers(tx, m.community_id);
}
