import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
} from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { classifyText } from '@yapilapi/moderation';
import { eventVisibleSql } from '../events/access.js';
import { listEventAttendeesForMemory } from '../events/service.js';
import { authenticityIndicators } from '../real/authenticity.js';
import { screenOwnText } from '../real/screen.js';
import { mediaCols, mediaLite } from '../real/views.js';
import { insertMemory } from '../memory/service.js';
import { contributionVisibleSql, experienceVisibleSql } from './access.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw pg rows
type Row = Record<string, any>;
export interface Actor {
  userId: string;
  ageBand: 'teen' | 'adult';
}
export const MAX_MEMBERS = 50;
export const MAX_CONTRIBUTIONS_PER_MEMBER = 200;
export const EXPERIENCE_VISIBILITIES = ['private', 'friends', 'public'] as const;
export type ExperienceVisibility = (typeof EXPERIENCE_VISIBILITIES)[number];
export const REINVITE_AFTER_DECLINE_DAYS = 30;

// ------------------------------------------------------------------------------------------------ loading
interface ExperienceRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  event_id: string | null;
  place_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: string;
  visibility: string;
  deleted_at: Date | null;
}

/** The experience if the viewer may see it, else 404. */
async function loadVisible(
  db: Queryable,
  viewerId: string | null,
  id: string,
): Promise<ExperienceRow> {
  const { rows } = await db.query<ExperienceRow>(
    `SELECT e.* FROM shared_experiences e WHERE e.id = $2 AND ${experienceVisibleSql('$1::uuid')}`,
    [viewerId, id],
  );
  if (!rows[0]) throw notFound('Experience');
  return rows[0];
}

async function memberOf(
  db: Queryable,
  id: string,
  userId: string,
): Promise<{ role: string; status: string } | null> {
  const { rows } = await db.query<{ role: string; status: string }>(
    'SELECT role, status FROM shared_experience_members WHERE experience_id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Owner-only actions: 404 for anyone who cannot see the experience, 403 for members without the right. */
async function loadAsOwner(
  db: Queryable,
  actorId: string,
  id: string,
  opts: { allowArchived?: boolean } = {},
): Promise<ExperienceRow> {
  const e = await loadVisible(db, actorId, id);
  if (e.owner_id !== actorId) throw forbidden('Only the owner can do that');
  if (e.status === 'archived' && !opts.allowArchived) throw conflict('This experience is archived');
  return e;
}

// ------------------------------------------------------------------------------------------------ create / update / status / delete
export interface CreateExperienceInput {
  title: string;
  description: string;
  eventId?: string | undefined;
  placeId?: string | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
  visibility: ExperienceVisibility;
}

/** Titles and descriptions are screened before they are stored; risky text is refused rather than held (there is no review queue for experience headers). */
function assertTextAllowed(...texts: Array<string | undefined>): void {
  const joined = texts.filter(Boolean).join(' ').trim();
  if (joined && classifyText(joined).status !== 'approved')
    throw new AppError('unprocessable', 'That text cannot be used. Please rephrase it.');
}

async function assertLinks(
  ctx: AppContext,
  actor: Actor,
  i: {
    eventId?: string | undefined | null;
    placeId?: string | undefined | null;
    startsAt?: Date | null | undefined;
    endsAt?: Date | null | undefined;
  },
) {
  if (i.startsAt && i.endsAt && i.endsAt <= i.startsAt)
    throw invalid('endsAt must be after startsAt');
  if (i.eventId) {
    const e = await ctx.db.query(
      `SELECT 1 FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1::uuid')}`,
      [actor.userId, i.eventId],
    );
    if (!e.rowCount) throw notFound('Event');
  }
  if (i.placeId) {
    const p = await ctx.db.query('SELECT 1 FROM places WHERE id = $1 AND deleted_at IS NULL', [
      i.placeId,
    ]);
    if (!p.rowCount) throw notFound('Place');
  }
}

async function assertPublicAllowed(ctx: AppContext, actor: Actor, visibility: string) {
  if (visibility !== 'public') return;
  if (actor.ageBand === 'teen')
    throw new AppError('unprocessable', 'Accounts under 18 cannot make shared experiences public');
  const p = await ctx.db.query<{ is_private: boolean }>(
    'SELECT is_private FROM profiles WHERE user_id = $1',
    [actor.userId],
  );
  if (p.rows[0]?.is_private)
    throw new AppError(
      'unprocessable',
      'Private accounts share experiences with friends or invited people only',
    );
}

export async function createExperience(
  ctx: AppContext,
  actor: Actor,
  i: CreateExperienceInput,
  req?: FastifyRequest,
): Promise<string> {
  assertTextAllowed(i.title, i.description);
  await assertLinks(ctx, actor, i);
  await assertPublicAllowed(ctx, actor, i.visibility);
  const id = await withTransaction(ctx.db, async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO shared_experiences (owner_id, title, description, event_id, place_id, starts_at, ends_at, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        actor.userId,
        i.title.trim(),
        i.description.trim(),
        i.eventId ?? null,
        i.placeId ?? null,
        i.startsAt ?? null,
        i.endsAt ?? null,
        i.visibility,
      ],
    );
    const eid = ins.rows[0]!.id;
    await tx.query(
      `INSERT INTO shared_experience_members (experience_id, user_id, role, status, joined_at) VALUES ($1,$2,'owner','joined', now())`,
      [eid, actor.userId],
    );
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'together.created',
        targetType: 'shared_experience',
        targetId: eid,
        metadata: { visibility: i.visibility },
      },
      req,
      tx,
    );
    return eid;
  });
  ctx.metrics.events.inc({ name: 'together_created' });
  return id;
}

export interface UpdateExperienceInput {
  title?: string | undefined;
  description?: string | undefined;
  eventId?: string | null | undefined;
  placeId?: string | null | undefined;
  startsAt?: Date | null | undefined;
  endsAt?: Date | null | undefined;
  visibility?: ExperienceVisibility | undefined;
}

export async function updateExperience(
  ctx: AppContext,
  actor: Actor,
  id: string,
  i: UpdateExperienceInput,
  req?: FastifyRequest,
): Promise<void> {
  assertTextAllowed(i.title, i.description);
  const e = await loadAsOwner(ctx.db, actor.userId, id);
  const startsAt = i.startsAt === undefined ? e.starts_at : i.startsAt;
  const endsAt = i.endsAt === undefined ? e.ends_at : i.endsAt;
  await assertLinks(ctx, actor, { eventId: i.eventId, placeId: i.placeId, startsAt, endsAt });
  if (i.visibility && i.visibility !== e.visibility)
    await assertPublicAllowed(ctx, actor, i.visibility);
  await ctx.db.query(
    `UPDATE shared_experiences SET title = COALESCE($2, title), description = COALESCE($3, description),
            event_id = CASE WHEN $4::boolean THEN $5::uuid ELSE event_id END, place_id = CASE WHEN $6::boolean THEN $7::uuid ELSE place_id END,
            starts_at = $8, ends_at = $9, visibility = COALESCE($10, visibility)
      WHERE id = $1`,
    [
      id,
      i.title?.trim() ?? null,
      i.description?.trim() ?? null,
      i.eventId !== undefined,
      i.eventId ?? null,
      i.placeId !== undefined,
      i.placeId ?? null,
      startsAt,
      endsAt,
      i.visibility ?? null,
    ],
  );
  if (i.visibility && i.visibility !== e.visibility) {
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'together.visibility_changed',
        targetType: 'shared_experience',
        targetId: id,
        metadata: { from: e.visibility, to: i.visibility },
      },
      req,
    );
  }
}

export async function setExperienceStatus(
  ctx: AppContext,
  actor: Actor,
  id: string,
  to: 'open' | 'closed' | 'archived',
  req?: FastifyRequest,
): Promise<void> {
  const e = await loadAsOwner(ctx.db, actor.userId, id, { allowArchived: true });
  if (e.status === to) return;
  await ctx.db.query(
    `UPDATE shared_experiences SET status = $2, closed_at = CASE WHEN $2 = 'open' THEN NULL ELSE COALESCE(closed_at, now()) END, archived_at = CASE WHEN $2 = 'archived' THEN now() ELSE NULL END WHERE id = $1`,
    [id, to],
  );
  await audit(
    ctx,
    {
      actorId: actor.userId,
      action: `together.${to === 'open' ? 'reopened' : to}`,
      targetType: 'shared_experience',
      targetId: id,
    },
    req,
  );
}

export async function deleteExperience(
  ctx: AppContext,
  actor: Actor,
  id: string,
  req?: FastifyRequest,
): Promise<void> {
  await loadAsOwner(ctx.db, actor.userId, id, { allowArchived: true });
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE shared_experiences SET deleted_at = now(), title = '', description = '', cover_contribution_id = NULL WHERE id = $1`,
      [id],
    );
    // Deletion propagates: every perspective goes with the experience, and memories that pointed at it lose the item.
    await tx.query(
      `UPDATE shared_experience_contributions SET deleted_at = COALESCE(deleted_at, now()), body = '' WHERE experience_id = $1`,
      [id],
    );
    await tx.query(`DELETE FROM memory_items WHERE item_type = 'experience' AND item_id = $1`, [
      id,
    ]);
    await tx.query(`DELETE FROM memory_links WHERE entity_type = 'experience' AND entity_id = $1`, [
      id,
    ]);
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'together.deleted',
        targetType: 'shared_experience',
        targetId: id,
      },
      req,
      tx,
    );
  });
}

// ------------------------------------------------------------------------------------------------ members
export async function inviteMember(
  ctx: AppContext,
  actor: Actor,
  id: string,
  target: { userId: string; role: 'contributor' | 'viewer' },
  req?: FastifyRequest,
): Promise<{ status: string }> {
  const e = await loadAsOwner(ctx.db, actor.userId, id);
  if (e.status !== 'open') throw conflict('Reopen the experience to invite people');
  if (target.userId === actor.userId) throw invalid('You are already the owner');
  // Only your friends can be invited. Anything else answers the same way so this cannot be used to probe accounts or blocks.
  const ok = await ctx.db.query(
    `SELECT 1 FROM users u WHERE u.id = $2 AND u.deleted_at IS NULL AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($1::uuid, u.id) AND fr.user_high = GREATEST($1::uuid, u.id) AND fr.status = 'accepted')
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))`,
    [actor.userId, target.userId],
  );
  if (!ok.rowCount) throw invalid('You can only invite your friends');
  const count = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM shared_experience_members WHERE experience_id = $1 AND status IN ('joined','invited')`,
    [id],
  );
  const existing = await ctx.db.query<{ status: string; invited_at: Date }>(
    'SELECT status, invited_at FROM shared_experience_members WHERE experience_id = $1 AND user_id = $2',
    [id, target.userId],
  );
  const cur = existing.rows[0];
  if (cur?.status === 'joined') throw conflict('Already a member');
  if (
    cur?.status === 'declined' &&
    Date.now() - cur.invited_at.getTime() < REINVITE_AFTER_DECLINE_DAYS * 86_400_000
  )
    throw conflict('This person declined an invitation recently');
  if (cur?.status !== 'invited' && count.rows[0]!.n >= MAX_MEMBERS)
    throw conflict(`An experience can have at most ${MAX_MEMBERS} members`);
  await ctx.db.query(
    `INSERT INTO shared_experience_members (experience_id, user_id, role, status, invited_by, invited_at) VALUES ($1,$2,$3,'invited',$4, now())
     ON CONFLICT (experience_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'invited', invited_by = EXCLUDED.invited_by, invited_at = CASE WHEN shared_experience_members.status = 'invited' THEN shared_experience_members.invited_at ELSE now() END, joined_at = NULL`,
    [id, target.userId, target.role, actor.userId],
  );
  if (cur?.status !== 'invited')
    await notify(ctx, {
      userId: target.userId,
      kind: 'together_invite',
      actorId: actor.userId,
      targetType: 'shared_experience',
      targetId: id,
      data: { role: target.role },
    });
  await audit(
    ctx,
    {
      actorId: actor.userId,
      action: 'together.member_invited',
      targetType: 'shared_experience',
      targetId: id,
      metadata: { userId: target.userId, role: target.role },
    },
    req,
  );
  return { status: 'invited' };
}

/** Withdraw everything a person contributed (used when they leave, decline or are removed) and their cover vote. */
async function withdrawContributions(tx: Queryable, id: string, userId: string): Promise<void> {
  await tx.query(
    `UPDATE shared_experience_contributions SET deleted_at = now(), body = '' WHERE experience_id = $1 AND contributor_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  await tx.query(
    'DELETE FROM shared_experience_cover_votes WHERE experience_id = $1 AND user_id = $2',
    [id, userId],
  );
}

export async function respondToInvite(
  ctx: AppContext,
  actor: Actor,
  id: string,
  accept: boolean,
): Promise<{ status: string }> {
  const e = await loadVisible(ctx.db, actor.userId, id);
  const upd = await ctx.db.query(
    `UPDATE shared_experience_members SET status = $3, joined_at = CASE WHEN $3 = 'joined' THEN now() ELSE joined_at END WHERE experience_id = $1 AND user_id = $2 AND status = 'invited' AND role <> 'owner'`,
    [id, actor.userId, accept ? 'joined' : 'declined'],
  );
  if (!upd.rowCount) throw conflict('There is no pending invitation');
  if (accept)
    await notify(ctx, {
      userId: e.owner_id,
      kind: 'together_joined',
      actorId: actor.userId,
      targetType: 'shared_experience',
      targetId: id,
    });
  return { status: accept ? 'joined' : 'declined' };
}

export async function leaveExperience(
  ctx: AppContext,
  actor: Actor,
  id: string,
  keepContributions: boolean,
): Promise<void> {
  const e = await loadVisible(ctx.db, actor.userId, id);
  if (e.owner_id === actor.userId)
    throw conflict('The owner cannot leave: delete the experience or archive it');
  await withTransaction(ctx.db, async (tx) => {
    const upd = await tx.query(
      `UPDATE shared_experience_members SET status = 'left', show_on_profile = false WHERE experience_id = $1 AND user_id = $2 AND status = 'joined'`,
      [id, actor.userId],
    );
    if (!upd.rowCount) throw conflict('You are not a member');
    if (!keepContributions) await withdrawContributions(tx, id, actor.userId);
    else
      await tx.query(
        'DELETE FROM shared_experience_cover_votes WHERE experience_id = $1 AND user_id = $2',
        [id, actor.userId],
      );
    await tx.query(
      `DELETE FROM memory_items WHERE item_type = 'experience' AND item_id = $1 AND memory_id IN (SELECT id FROM memories WHERE owner_id = $2)`,
      [id, actor.userId],
    );
  });
}

export async function removeMember(
  ctx: AppContext,
  actor: Actor,
  id: string,
  userId: string,
  req?: FastifyRequest,
): Promise<void> {
  await loadAsOwner(ctx.db, actor.userId, id);
  if (userId === actor.userId) throw conflict('The owner cannot be removed');
  await withTransaction(ctx.db, async (tx) => {
    const del = await tx.query(
      'DELETE FROM shared_experience_members WHERE experience_id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!del.rowCount) throw notFound('Member');
    await withdrawContributions(tx, id, userId);
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'together.member_removed',
        targetType: 'shared_experience',
        targetId: id,
        metadata: { userId },
      },
      req,
      tx,
    );
  });
}

export async function setMemberRole(
  ctx: AppContext,
  actor: Actor,
  id: string,
  userId: string,
  role: 'contributor' | 'viewer',
  req?: FastifyRequest,
): Promise<void> {
  await loadAsOwner(ctx.db, actor.userId, id);
  if (userId === actor.userId) throw conflict('The owner keeps the owner role');
  const upd = await ctx.db.query(
    `UPDATE shared_experience_members SET role = $3 WHERE experience_id = $1 AND user_id = $2 AND status IN ('joined','invited')`,
    [id, userId, role],
  );
  if (!upd.rowCount) throw notFound('Member');
  await audit(
    ctx,
    {
      actorId: actor.userId,
      action: 'together.member_role_changed',
      targetType: 'shared_experience',
      targetId: id,
      metadata: { userId, role },
    },
    req,
  );
}

export async function setProfileOptIn(
  ctx: AppContext,
  actor: Actor,
  id: string,
  show: boolean,
): Promise<void> {
  const upd = await ctx.db.query(
    `UPDATE shared_experience_members SET show_on_profile = $3 WHERE experience_id = $1 AND user_id = $2 AND status = 'joined'`,
    [id, actor.userId, show],
  );
  if (!upd.rowCount) throw notFound('Experience');
}

export async function listMembers(ctx: AppContext, viewerId: string, id: string) {
  const e = await loadVisible(ctx.db, viewerId, id);
  const isOwner = e.owner_id === viewerId;
  const { rows } = await ctx.db.query(
    `SELECT m.user_id, m.role, m.status, m.joined_at, m.invited_at, pr.username, pr.display_name, pr.avatar_url
       FROM shared_experience_members m JOIN profiles pr ON pr.user_id = m.user_id JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE m.experience_id = $1 AND (m.status = 'joined' OR ($3::boolean AND m.status = 'invited'))
        AND (m.user_id = $2 OR NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = m.user_id) OR (b.blocker_id = m.user_id AND b.blocked_id = $2)))
      ORDER BY (m.role = 'owner') DESC, m.joined_at NULLS LAST, m.user_id`,
    [id, viewerId, isOwner],
  );
  return {
    items: rows.map((r) => ({
      user: {
        id: r.user_id,
        username: r.username,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
      },
      role: r.role,
      status: r.status,
      joinedAt: r.joined_at ? new Date(r.joined_at).toISOString() : null,
    })),
  };
}

// ------------------------------------------------------------------------------------------------ contributions
export interface ContributionInput {
  mediaId?: string | undefined;
  realCaptureId?: string | undefined;
  body: string;
  takenAt?: Date | undefined;
}

export async function addContribution(
  ctx: AppContext,
  actor: Actor,
  id: string,
  i: ContributionInput,
): Promise<string> {
  const e = await loadVisible(ctx.db, actor.userId, id);
  const m = await memberOf(ctx.db, id, actor.userId);
  if (!m || m.status !== 'joined') throw forbidden('Join this experience to contribute');
  if (m.role === 'viewer') throw forbidden('Viewers cannot contribute');
  if (e.status !== 'open') throw conflict('This experience is not accepting contributions');
  const body = i.body.trim();
  if (!i.mediaId && !i.realCaptureId && !body)
    throw invalid('A contribution needs media, a Real or text');
  if (actor.ageBand === 'teen' && e.visibility === 'public')
    throw new AppError(
      'unprocessable',
      'Accounts under 18 cannot contribute to public experiences',
    );
  const n = await ctx.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM shared_experience_contributions WHERE experience_id = $1 AND contributor_id = $2 AND deleted_at IS NULL',
    [id, actor.userId],
  );
  if (n.rows[0]!.n >= MAX_CONTRIBUTIONS_PER_MEMBER) throw conflict('Contribution limit reached');

  return withTransaction(ctx.db, async (tx) => {
    let takenAt = i.takenAt ?? null;
    if (i.mediaId) {
      const r = await tx.query(
        `SELECT 1 FROM media m WHERE m.id = $1 AND m.owner_id = $2 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready') AND m.kind IN ('image','video','audio') AND m.purpose = 'attachment' FOR UPDATE`,
        [i.mediaId, actor.userId],
      );
      if (!r.rowCount) throw invalid('That media is unavailable');
    }
    if (i.realCaptureId) {
      const r = await tx.query<{ captured_at: Date }>(
        `SELECT captured_at FROM real_captures WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL AND moderation_status = 'approved'`,
        [i.realCaptureId, actor.userId],
      );
      if (!r.rows[0]) throw invalid('That Real is unavailable');
      takenAt ??= r.rows[0].captured_at;
    }
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO shared_experience_contributions (experience_id, contributor_id, media_id, real_capture_id, body, taken_at) VALUES ($1,$2,$3,$4,$5, COALESCE($6, now())) RETURNING id`,
      [id, actor.userId, i.mediaId ?? null, i.realCaptureId ?? null, body, takenAt],
    );
    const cid = ins.rows[0]!.id;
    await screenOwnText(ctx, tx, {
      type: 'experience_contribution',
      id: cid,
      authorId: actor.userId,
      text: body,
    });
    return cid;
  }).then(async (cid) => {
    if (e.owner_id !== actor.userId)
      await notify(ctx, {
        userId: e.owner_id,
        kind: 'together_contribution',
        actorId: actor.userId,
        targetType: 'shared_experience',
        targetId: id,
      });
    return cid;
  });
}

export async function removeContribution(
  ctx: AppContext,
  actor: Actor,
  id: string,
  contributionId: string,
  req?: FastifyRequest,
): Promise<void> {
  const e = await loadVisible(ctx.db, actor.userId, id);
  const { rows } = await ctx.db.query<{ contributor_id: string }>(
    'SELECT contributor_id FROM shared_experience_contributions WHERE id = $1 AND experience_id = $2 AND deleted_at IS NULL',
    [contributionId, id],
  );
  const c = rows[0];
  // A contribution you could not see does not exist for you.
  if (!c || (c.contributor_id !== actor.userId && e.owner_id !== actor.userId))
    throw notFound('Contribution');
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE shared_experience_contributions SET deleted_at = now(), body = '' WHERE id = $1`,
      [contributionId],
    );
    await tx.query('DELETE FROM shared_experience_cover_votes WHERE contribution_id = $1', [
      contributionId,
    ]);
    if (c.contributor_id !== actor.userId)
      await audit(
        ctx,
        {
          actorId: actor.userId,
          action: 'together.contribution_removed_by_owner',
          targetType: 'shared_experience',
          targetId: id,
          metadata: { contributionId, contributorId: c.contributor_id },
        },
        req,
        tx,
      );
  });
}

// ------------------------------------------------------------------------------------------------ timeline
const CONTRIB_SELECT = `
  c.id, c.contributor_id, c.body, c.taken_at, c.created_at, c.moderation_status, c.media_id, c.real_capture_id,
  pr.username, pr.display_name, pr.avatar_url,
  ${mediaCols('cm', 'm')}, ${mediaCols('rfm', 'f')}, ${mediaCols('rrm', 'b')},
  rc.caption AS rc_caption, rc.captured_at AS rc_captured_at, rc.authenticity AS rc_authenticity`;
const CONTRIB_FROM = `shared_experience_contributions c
  JOIN shared_experiences e ON e.id = c.experience_id
  JOIN profiles pr ON pr.user_id = c.contributor_id
  LEFT JOIN media cm ON cm.id = c.media_id AND cm.deleted_at IS NULL
  LEFT JOIN real_captures rc ON rc.id = c.real_capture_id AND rc.deleted_at IS NULL
  LEFT JOIN media rfm ON rfm.id = rc.front_media_id AND rfm.deleted_at IS NULL
  LEFT JOIN media rrm ON rrm.id = rc.rear_media_id AND rrm.deleted_at IS NULL`;

function contributionView(ctx: AppContext, r: Row, viewerId: string) {
  const auth = r.rc_authenticity ?? null;
  return {
    id: r.id,
    contributor: {
      id: r.contributor_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
    },
    text: r.body,
    media: mediaLite(ctx, r, 'm'),
    // The Real's own location is deliberately not exposed here: adding a Real to an experience shares the picture, not where it was taken.
    real:
      r.real_capture_id && (r.f_id || r.b_id || auth)
        ? {
            id: r.real_capture_id,
            front: mediaLite(ctx, r, 'f'),
            rear: mediaLite(ctx, r, 'b'),
            caption: r.rc_caption ?? '',
            capturedAt: r.rc_captured_at ? new Date(r.rc_captured_at).toISOString() : null,
            authenticity: auth,
            indicators: authenticityIndicators(auth),
          }
        : null,
    takenAt: new Date(r.taken_at).toISOString(),
    addedAt: new Date(r.created_at).toISOString(),
    ...(r.contributor_id === viewerId
      ? { mine: true, moderationStatus: r.moderation_status }
      : { mine: false }),
  };
}

export async function loadTimeline(
  ctx: AppContext,
  viewerId: string | null,
  id: string,
  o: {
    cursor?: string | undefined;
    limit?: number | undefined;
    order: 'asc' | 'desc';
    contributorId?: string | undefined;
  },
) {
  await loadVisible(ctx.db, viewerId, id);
  const limit = clampLimit(o.limit);
  const cur = decodeCursor<{ t: string; id: string }>(o.cursor);
  const op = o.order === 'asc' ? '>' : '<'; // constant, never user input
  const dir = o.order === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await ctx.db.query(
    `SELECT ${CONTRIB_SELECT} FROM ${CONTRIB_FROM}
      WHERE c.experience_id = $2 AND ${contributionVisibleSql('$1::uuid')}
        AND ($3::uuid IS NULL OR c.contributor_id = $3)
        AND ($4::timestamptz IS NULL OR (c.taken_at, c.id) ${op} ($4::timestamptz, $5::uuid))
      ORDER BY c.taken_at ${dir}, c.id ${dir} LIMIT $6`,
    [viewerId, id, o.contributorId ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => contributionView(ctx, r, viewerId ?? '')),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: (last.taken_at as Date).toISOString(), id: last.id })
        : null,
  };
}

export async function getContribution(
  ctx: AppContext,
  viewerId: string,
  id: string,
  contributionId: string,
) {
  const { rows } = await ctx.db.query(
    `SELECT ${CONTRIB_SELECT} FROM ${CONTRIB_FROM} WHERE c.id = $3 AND c.experience_id = $2 AND ${contributionVisibleSql('$1::uuid')}`,
    [viewerId, id, contributionId],
  );
  if (!rows[0]) throw notFound('Contribution');
  return contributionView(ctx, rows[0], viewerId);
}

// ------------------------------------------------------------------------------------------------ cover
export async function loadCover(ctx: AppContext, viewerId: string | null, id: string) {
  const { rows } = await ctx.db.query(
    `SELECT ${CONTRIB_SELECT}, (e.cover_contribution_id = c.id) AS pinned, (SELECT count(*) FROM shared_experience_cover_votes v WHERE v.contribution_id = c.id)::int AS votes
       FROM ${CONTRIB_FROM}
      WHERE c.experience_id = $2 AND ${contributionVisibleSql('$1::uuid')}
        AND ((cm.id IS NOT NULL AND cm.kind = 'image') OR (rrm.id IS NOT NULL AND rrm.kind = 'image') OR (rfm.id IS NOT NULL AND rfm.kind = 'image'))
      ORDER BY (e.cover_contribution_id = c.id) DESC NULLS LAST, votes DESC, c.taken_at ASC, c.id LIMIT 1`,
    [viewerId, id],
  );
  const r = rows[0];
  if (!r) return null;
  const media =
    [mediaLite(ctx, r, 'm'), mediaLite(ctx, r, 'b'), mediaLite(ctx, r, 'f')].find(
      (m) => m && m.kind === 'image',
    ) ?? null;
  return {
    contributionId: r.id,
    media,
    contributor: { id: r.contributor_id, username: r.username, displayName: r.display_name },
    pinned: Boolean(r.pinned),
    votes: r.votes,
  };
}

/** Owner pins the cover (or clears the pin); any other joined contributor votes for one (or clears their vote). Returns what the caller now sees. */
export async function setCover(
  ctx: AppContext,
  actor: Actor,
  id: string,
  contributionId: string | null,
) {
  const e = await loadVisible(ctx.db, actor.userId, id);
  const m = await memberOf(ctx.db, id, actor.userId);
  if (!m || m.status !== 'joined' || m.role === 'viewer')
    throw forbidden('Only owners and contributors choose the cover');
  if (contributionId) {
    const ok = await ctx.db.query(
      `SELECT 1 FROM ${CONTRIB_FROM} WHERE c.id = $2 AND c.experience_id = $3 AND ${contributionVisibleSql('$1::uuid')}
          AND ((cm.id IS NOT NULL AND cm.kind = 'image') OR (rrm.id IS NOT NULL AND rrm.kind = 'image') OR (rfm.id IS NOT NULL AND rfm.kind = 'image'))`,
      [actor.userId, contributionId, id],
    );
    if (!ok.rowCount) throw notFound('Contribution');
  }
  if (e.owner_id === actor.userId) {
    await ctx.db.query('UPDATE shared_experiences SET cover_contribution_id = $2 WHERE id = $1', [
      id,
      contributionId,
    ]);
  } else if (contributionId) {
    await ctx.db.query(
      `INSERT INTO shared_experience_cover_votes (experience_id, user_id, contribution_id) VALUES ($1,$2,$3) ON CONFLICT (experience_id, user_id) DO UPDATE SET contribution_id = EXCLUDED.contribution_id, created_at = now()`,
      [id, actor.userId, contributionId],
    );
  } else {
    await ctx.db.query(
      'DELETE FROM shared_experience_cover_votes WHERE experience_id = $1 AND user_id = $2',
      [id, actor.userId],
    );
  }
  return loadCover(ctx, actor.userId, id);
}

// ------------------------------------------------------------------------------------------------ experience views & lists
const EXP_SELECT = (viewer: string) => `
  e.id, e.owner_id, e.title, e.description, e.event_id, e.place_id, e.starts_at, e.ends_at, e.status, e.visibility, e.created_at, e.updated_at,
  pr.username, pr.display_name, pr.avatar_url,
  (SELECT m.role FROM shared_experience_members m WHERE m.experience_id = e.id AND m.user_id = ${viewer}) AS my_role,
  (SELECT m.status FROM shared_experience_members m WHERE m.experience_id = e.id AND m.user_id = ${viewer}) AS my_status,
  COALESCE((SELECT m.show_on_profile FROM shared_experience_members m WHERE m.experience_id = e.id AND m.user_id = ${viewer}), false) AS my_show,
  (SELECT count(*) FROM shared_experience_members m WHERE m.experience_id = e.id AND m.status = 'joined')::int AS member_count,
  (SELECT count(*) FROM shared_experience_contributions c WHERE c.experience_id = e.id AND ${contributionVisibleSql(viewer)})::int AS contribution_count`;
const EXP_FROM = `shared_experiences e JOIN profiles pr ON pr.user_id = e.owner_id`;

function experienceView(r: Row, viewerId: string | null) {
  const joined = r.my_status === 'joined';
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    owner: {
      id: r.owner_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
    },
    eventId: r.event_id,
    placeId: r.place_id,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    status: r.status,
    visibility: r.visibility,
    counts: { members: r.member_count, contributions: r.contribution_count },
    viewer: {
      membership: r.my_status ?? null,
      role: r.my_role ?? null,
      isOwner: viewerId !== null && r.owner_id === viewerId,
      canContribute: joined && r.my_role !== 'viewer' && r.status === 'open',
      showOnProfile: r.my_show,
    },
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function getExperienceView(ctx: AppContext, viewerId: string | null, id: string) {
  const { rows } = await ctx.db.query(
    `SELECT ${EXP_SELECT('$1::uuid')} FROM ${EXP_FROM} WHERE e.id = $2 AND ${experienceVisibleSql('$1::uuid')}`,
    [viewerId, id],
  );
  if (!rows[0]) throw notFound('Experience');
  return { ...experienceView(rows[0], viewerId), cover: await loadCover(ctx, viewerId, id) };
}

export async function listMine(
  ctx: AppContext,
  userId: string,
  o: {
    membership: 'joined' | 'invited';
    includeArchived: boolean;
    cursor?: string | undefined;
    limit?: number | undefined;
  },
) {
  const limit = clampLimit(o.limit);
  const cur = decodeCursor<{ t: string; id: string }>(o.cursor);
  const { rows } = await ctx.db.query(
    `SELECT ${EXP_SELECT('$1::uuid')} FROM ${EXP_FROM}
      WHERE EXISTS (SELECT 1 FROM shared_experience_members mm WHERE mm.experience_id = e.id AND mm.user_id = $1 AND mm.status = $2)
        AND ($3::boolean OR e.status <> 'archived') AND ${experienceVisibleSql('$1::uuid')}
        AND ($4::timestamptz IS NULL OR (e.created_at, e.id) < ($4::timestamptz, $5::uuid))
      ORDER BY e.created_at DESC, e.id DESC LIMIT $6`,
    [userId, o.membership, o.includeArchived, cur?.t ?? null, cur?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => experienceView(r, userId)),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
        : null,
  };
}

/** Experiences a person chose to show on their profile (they opted in per experience), limited to what the viewer may see. */
export async function listProfileExperiences(
  ctx: AppContext,
  viewerId: string | null,
  targetId: string,
  o: { cursor?: string | undefined; limit?: number | undefined },
) {
  const limit = clampLimit(o.limit);
  const cur = decodeCursor<{ t: string; id: string }>(o.cursor);
  const { rows } = await ctx.db.query(
    `SELECT ${EXP_SELECT('$1::uuid')} FROM ${EXP_FROM}
      WHERE EXISTS (SELECT 1 FROM shared_experience_members mm WHERE mm.experience_id = e.id AND mm.user_id = $2 AND mm.status = 'joined' AND mm.show_on_profile)
        AND e.status <> 'archived' AND ${experienceVisibleSql('$1::uuid')}
        AND ($3::timestamptz IS NULL OR (e.created_at, e.id) < ($3::timestamptz, $4::uuid))
      ORDER BY e.created_at DESC, e.id DESC LIMIT $5`,
    [viewerId, targetId, cur?.t ?? null, cur?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => experienceView(r, viewerId)),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: (last.created_at as Date).toISOString(), id: last.id })
        : null,
  };
}

// ------------------------------------------------------------------------------------------------ suggestions & memory export
export async function suggestInvites(ctx: AppContext, actor: Actor, id: string) {
  const e = await loadAsOwner(ctx.db, actor.userId, id);
  if (!e.event_id) return { suggestions: [], reason: 'no_linked_event' as const };
  // Only friends of the owner who also attended, with blocks already removed, and only when the owner attended (the events module enforces both).
  const res = await listEventAttendeesForMemory(ctx, { eventId: e.event_id, userId: actor.userId });
  if (!res) return { suggestions: [], reason: 'not_attended' as const };
  const taken = await ctx.db.query<{ user_id: string }>(
    `SELECT user_id FROM shared_experience_members WHERE experience_id = $1 AND (status IN ('joined','invited') OR (status = 'declined' AND invited_at > now() - interval '${REINVITE_AFTER_DECLINE_DAYS} days'))`,
    [id],
  );
  const skip = new Set(taken.rows.map((r) => r.user_id));
  return { suggestions: res.attendees.filter((a) => !skip.has(a.userId)), reason: null };
}

/** Each member's own copy: a private memory holding a reference to the experience plus the member's OWN contributions (never other people's). */
export async function exportAsMemory(
  ctx: AppContext,
  actor: Actor,
  id: string,
  req?: FastifyRequest,
): Promise<string> {
  const e = await loadVisible(ctx.db, actor.userId, id);
  const m = await memberOf(ctx.db, id, actor.userId);
  if (!m || m.status !== 'joined') throw forbidden('Only members can keep a copy');
  const dup = await ctx.db.query(
    `SELECT mem.id FROM memories mem JOIN memory_links ml ON ml.memory_id = mem.id AND ml.entity_type = 'experience' AND ml.entity_id = $2
      WHERE mem.owner_id = $1 AND mem.source = 'experience_export' AND mem.deleted_at IS NULL`,
    [actor.userId, id],
  );
  if (dup.rowCount)
    throw conflict('You already saved this experience as a memory', { memoryId: dup.rows[0]!.id });
  const mine = await ctx.db.query<{
    media_id: string | null;
    real_capture_id: string | null;
    taken_at: Date;
  }>(
    `SELECT c.media_id, c.real_capture_id, c.taken_at FROM shared_experience_contributions c
      WHERE c.experience_id = $1 AND c.contributor_id = $2 AND c.deleted_at IS NULL AND c.moderation_status = 'approved' ORDER BY c.taken_at, c.id`,
    [id, actor.userId],
  );
  const items: Array<{ type: 'experience' | 'real_capture' | 'media'; id: string }> = [
    { type: 'experience', id },
  ];
  for (const c of mine.rows) {
    if (c.real_capture_id) items.push({ type: 'real_capture', id: c.real_capture_id });
    else if (c.media_id) items.push({ type: 'media', id: c.media_id });
  }
  const times = [e.starts_at, e.ends_at, ...mine.rows.map((c) => c.taken_at)]
    .filter((d): d is Date => Boolean(d))
    .map((d) => d.getTime());
  const attended = e.event_id
    ? (
        await ctx.db.query(
          `SELECT 1 FROM event_attendees a WHERE a.event_id = $1 AND a.user_id = $2 AND a.status IN ('attended','going')`,
          [e.event_id, actor.userId],
        )
      ).rowCount
    : 0;
  const memoryId = await withTransaction(ctx.db, async (tx) => {
    const mid = await insertMemory(tx, {
      ownerId: actor.userId,
      kind: 'collection',
      title: e.title,
      summary: '',
      dateStart: times.length ? new Date(Math.min(...times)) : null,
      dateEnd: times.length ? new Date(Math.max(...times)) : null,
      privacy: 'private',
      source: 'experience_export',
      items,
      links: [
        { type: 'experience', id },
        ...(e.place_id ? [{ type: 'place' as const, id: e.place_id }] : []),
        ...(attended && e.event_id ? [{ type: 'event' as const, id: e.event_id }] : []),
      ],
    });
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'together.exported_as_memory',
        targetType: 'shared_experience',
        targetId: id,
        metadata: { memoryId: mid },
      },
      req,
      tx,
    );
    return mid;
  });
  return memoryId;
}

// ------------------------------------------------------------------------------------------------ account deletion
/** Hand experiences to their longest-standing contributor (or delete them if nobody else is in), then withdraw the person's perspectives. */
export async function releaseUserFromExperiences(
  ctx: AppContext,
  tx: Queryable,
  userId: string,
): Promise<void> {
  const owned = await tx.query<{ id: string }>(
    'SELECT id FROM shared_experiences WHERE owner_id = $1 AND deleted_at IS NULL FOR UPDATE',
    [userId],
  );
  for (const { id } of owned.rows) {
    const next = await tx.query<{ user_id: string }>(
      `SELECT m.user_id FROM shared_experience_members m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL AND u.status = 'active'
        WHERE m.experience_id = $1 AND m.user_id <> $2 AND m.status = 'joined' AND m.role = 'contributor' ORDER BY m.joined_at, m.user_id LIMIT 1`,
      [id, userId],
    );
    if (next.rows[0]) {
      await tx.query(
        `UPDATE shared_experience_members SET role = 'contributor' WHERE experience_id = $1 AND user_id = $2 AND role = 'owner'`,
        [id, userId],
      );
      await tx.query(
        `UPDATE shared_experience_members SET role = 'owner' WHERE experience_id = $1 AND user_id = $2`,
        [id, next.rows[0].user_id],
      );
      await tx.query('UPDATE shared_experiences SET owner_id = $2 WHERE id = $1', [
        id,
        next.rows[0].user_id,
      ]);
    } else {
      await tx.query(
        `UPDATE shared_experiences SET deleted_at = now(), title = '', description = '' WHERE id = $1`,
        [id],
      );
      await tx.query(
        `UPDATE shared_experience_contributions SET deleted_at = COALESCE(deleted_at, now()), body = '' WHERE experience_id = $1`,
        [id],
      );
      await tx.query(`DELETE FROM memory_items WHERE item_type = 'experience' AND item_id = $1`, [
        id,
      ]);
    }
  }
  await tx.query(
    `UPDATE shared_experience_contributions SET deleted_at = COALESCE(deleted_at, now()), body = '' WHERE contributor_id = $1`,
    [userId],
  );
  await tx.query('DELETE FROM shared_experience_cover_votes WHERE user_id = $1', [userId]);
  await tx.query(`DELETE FROM shared_experience_members WHERE user_id = $1`, [userId]);
  await tx.query(
    `DELETE FROM memory_items WHERE item_type = 'experience' AND memory_id IN (SELECT id FROM memories WHERE owner_id = $1)`,
    [userId],
  );
  void ctx;
}
