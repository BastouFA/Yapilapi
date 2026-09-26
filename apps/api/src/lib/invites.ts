import { randomInt } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError } from './errors.ts';
import { grantPlus, PLUS_DAYS } from './plus.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify, track } from './services.ts';
import { ageOf } from './users.ts';

type Q = Pool | PoolClient;

/** Every this many friends who join and confirm their email earn the inviter a month of Plus. */
export const REFERRALS_PER_REWARD = 3;
/** At most this many free months from invites, per person. */
export const MAX_REFERRAL_REWARDS = 12;
/** An account can still enter an invite code this long after signing up. */
export const ACCEPT_WINDOW_DAYS = 14;

// No 0/o, 1/l/i: codes are read aloud and typed by hand.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const INVITE_CODE_RE = /^[a-z0-9]{8}$/;

export function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** Normalize a code someone typed or followed a link with. */
export function normalizeInviteCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * One mailbox, one key: lowercased, without a +tag, and without dots for Gmail
 * (which ignores them). Used so aliases of the same inbox count once.
 */
export function emailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  let local = e.slice(0, at).split('+')[0] ?? '';
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

/** Your invite code, created the first time you ask for it and never changed after. */
export async function ensureInviteCode(db: Q, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const existing = await db.query<{ code: string }>(`SELECT code FROM invite_codes WHERE user_id = $1`, [userId]);
    if (existing.rows[0]) return existing.rows[0].code;
    const ins = await db.query<{ code: string }>(`INSERT INTO invite_codes (user_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code`, [
      userId,
      newInviteCode(),
    ]);
    if (ins.rows[0]) return ins.rows[0].code;
  }
  throw new Error('could not allocate an invite code');
}

export interface Inviter {
  id: string;
  email: string;
  createdAt: Date;
}

/** The active account behind a code, or null. */
export async function inviterByCode(db: Q, code: string): Promise<Inviter | null> {
  const c = normalizeInviteCode(code);
  if (!INVITE_CODE_RE.test(c)) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.created_at FROM invite_codes ic JOIN users u ON u.id = ic.user_id
     WHERE ic.code = $1 AND u.status = 'active' AND u.deleted_at IS NULL`,
    [c],
  );
  return rows[0] ? { id: rows[0].id, email: rows[0].email, createdAt: rows[0].created_at } : null;
}

const codeError = (message: string) => new AppError(400, 'invalid_invite', message, { fields: { inviteCode: message } });

/**
 * Record that `invitee` joined with `inviter`'s code and make them follow each
 * other. Refuses your own code (including another address of your own inbox)
 * and a code from an account newer than yours. Call inside a transaction.
 */
export async function applyReferral(
  c: PoolClient,
  invitee: { id: string; email: string; birthDate: Date | string | null; createdAt: Date },
  inviter: Inviter,
): Promise<void> {
  if (inviter.id === invitee.id || emailKey(inviter.email) === emailKey(invitee.email)) throw codeError("You can't use your own invite code.");
  if (inviter.createdAt > invitee.createdAt) throw codeError('Invite codes are for people who joined after the person who invited them.');
  const blocked = await c.query(`SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`, [
    inviter.id,
    invitee.id,
  ]);
  if (blocked.rowCount) throw codeError("That invite code doesn't work. Check it, or leave it empty.");
  const ins = await c.query(`INSERT INTO referrals (invitee_id, inviter_id, email_key) VALUES ($1, $2, $3) ON CONFLICT (invitee_id) DO NOTHING`, [
    invitee.id,
    inviter.id,
    emailKey(invitee.email),
  ]);
  if (!ins.rowCount) throw new AppError(409, 'conflict', 'You already joined with an invite.');
  // Follow each other, so the new person starts with someone they know. Teens choose who they follow themselves.
  const age = ageOf(invitee.birthDate);
  if (age === null || age >= 18)
    await c.query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`, [invitee.id, inviter.id]);
}

/** Tell the inviter someone joined with their code. Outside the signup transaction, after it commits. */
export async function announceReferral(db: Q, realtime: RealtimeHub, inviteeId: string, inviterId: string): Promise<void> {
  await notify(db, realtime, { userId: inviterId, category: 'friends', type: 'invite_joined', actorId: inviteeId, entityType: 'user', entityId: inviteeId });
  track(db, inviterId, 'invite_joined', { invitee: inviteeId });
}

/**
 * The invitee confirmed their email: their referral now counts. Every
 * REFERRALS_PER_REWARD counted referrals grant the inviter 30 days of Plus,
 * each batch exactly once. Another address of a mailbox that already counted
 * for the same inviter doesn't count again. Call inside a transaction.
 */
export async function qualifyReferral(c: PoolClient, realtime: RealtimeHub, inviteeId: string): Promise<void> {
  const r = await c.query<{ inviter_id: string }>(
    `UPDATE referrals r SET qualified_at = now()
     WHERE r.invitee_id = $1 AND r.qualified_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM referrals o WHERE o.inviter_id = r.inviter_id AND o.email_key = r.email_key AND o.qualified_at IS NOT NULL)
     RETURNING r.inviter_id`,
    [inviteeId],
  );
  const inviterId = r.rows[0]?.inviter_id;
  if (!inviterId) return;
  // Serialize reward checks per inviter.
  await c.query(`SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE`, [inviterId]);
  const counts = await c.query<{ qualified: string; rewarded: number | null }>(
    `SELECT (SELECT count(*) FROM referrals WHERE inviter_id = $1 AND qualified_at IS NOT NULL) AS qualified,
            (SELECT max(referral_batch) FROM plus_grants WHERE user_id = $1 AND source = 'referral') AS rewarded`,
    [inviterId],
  );
  const due = Math.min(Math.floor(Number(counts.rows[0]!.qualified) / REFERRALS_PER_REWARD), MAX_REFERRAL_REWARDS);
  for (let batch = (counts.rows[0]!.rewarded ?? 0) + 1; batch <= due; batch++) {
    const until = await grantPlus(c, inviterId, 'referral', { referralBatch: batch }, PLUS_DAYS);
    if (until)
      await notify(c, realtime, {
        userId: inviterId,
        category: 'system',
        type: 'plus_referral_reward',
        entityType: 'plus',
        data: { days: PLUS_DAYS, until: until.toISOString() },
      });
  }
}
