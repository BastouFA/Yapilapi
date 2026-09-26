import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import {
  ACCEPT_WINDOW_DAYS,
  announceReferral,
  applyReferral,
  ensureInviteCode,
  inviterByCode,
  MAX_REFERRAL_REWARDS,
  qualifyReferral,
  REFERRALS_PER_REWARD,
} from '../lib/invites.ts';
import { PLUS_DAYS } from '../lib/plus.ts';
import { PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/**
 * Invites: everyone has a stable code and a /join/<code> link. People who
 * sign up with it follow the inviter (and the inviter follows them back).
 * Every 3 who confirm their email earn the inviter 30 days of Plus.
 */
export default async function invitesModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const webOrigin = ctx.config.WEB_ORIGIN.split(',')[0]!.replace(/\/$/, '');

  app.get('/v1/invites', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const code = await ensureInviteCode(db, u.id);
    const [people, rewards] = await Promise.all([
      db.query(
        `SELECT ${PUBLIC_USER_COLS}, r.created_at AS joined_at, r.qualified_at
         FROM referrals r JOIN profiles pr ON pr.user_id = r.invitee_id JOIN users us ON us.id = r.invitee_id
         WHERE r.inviter_id = $1 AND us.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 200`,
        [u.id],
      ),
      db.query(`SELECT count(*) AS n FROM plus_grants WHERE user_id = $1 AND source = 'referral'`, [u.id]),
    ]);
    const counts = (
      await db.query(
        `SELECT count(*) AS joined, count(*) FILTER (WHERE qualified_at IS NOT NULL) AS confirmed,
                (NOT EXISTS (SELECT 1 FROM referrals WHERE invitee_id = $1)
                 AND (SELECT created_at FROM users WHERE id = $1) > now() - make_interval(days => $2)) AS can_enter_code
         FROM referrals WHERE inviter_id = $1`,
        [u.id, ACCEPT_WINDOW_DAYS],
      )
    ).rows[0];
    const confirmed = Number(counts.confirmed);
    const earned = Number(rewards.rows[0].n);
    const maxed = earned >= MAX_REFERRAL_REWARDS;
    return {
      code,
      link: `${webOrigin}/join/${code}`,
      joined: Number(counts.joined),
      confirmed,
      reward: { perPeople: REFERRALS_PER_REWARD, days: PLUS_DAYS, max: MAX_REFERRAL_REWARDS, earned },
      // Confirmed people still needed for the next free month (null once the limit is reached).
      toNextReward: maxed ? null : REFERRALS_PER_REWARD - (confirmed % REFERRALS_PER_REWARD),
      // A new account that joined without a code can still enter a friend's code for a while.
      canEnterCode: counts.can_enter_code === true,
      enterCodeDays: ACCEPT_WINDOW_DAYS,
      people: people.rows.map((r) => ({
        user: toPublicUser(r as PublicUserRow),
        joinedAt: (r.joined_at as Date).toISOString(),
        confirmed: !!r.qualified_at,
      })),
    };
  });

  /** Who a code belongs to, for the /join page. Public: the invite link is meant to be shared. */
  app.get('/v1/invites/:code', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = parse(z.object({ code: z.string().max(32) }), req.params);
    const inviter = await inviterByCode(db, code);
    if (!inviter) throw notFound('That invite');
    const { rows } = await db.query(`SELECT ${PUBLIC_USER_COLS} FROM profiles pr WHERE pr.user_id = $1`, [inviter.id]);
    return { code: code.trim().toLowerCase(), inviter: toPublicUser(rows[0] as PublicUserRow) };
  });

  /**
   * Enter a friend's code after signing up (for example when signing up with a
   * passkey or on another device). Only for new accounts, once.
   */
  app.post('/v1/invites/accept', { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(32) }), req.body);
    const acct = (
      await db.query(`SELECT created_at, birth_date, email_verified_at, now() - created_at > make_interval(days => $2) AS too_old FROM users WHERE id = $1`, [
        u.id,
        ACCEPT_WINDOW_DAYS,
      ])
    ).rows[0];
    if ((await db.query(`SELECT 1 FROM referrals WHERE invitee_id = $1`, [u.id])).rowCount)
      throw new AppError(409, 'conflict', 'You already joined with an invite.');
    if (acct.too_old) throw new AppError(409, 'conflict', `Invite codes can be entered in the first ${ACCEPT_WINDOW_DAYS} days after joining.`);
    const inviter = await inviterByCode(db, code);
    if (!inviter)
      throw new AppError(400, 'invalid_invite', "That invite code doesn't work. Check it and try again.", {
        fields: { code: "That invite code doesn't work." },
      });
    await tx(db, async (c) => {
      await applyReferral(c, { id: u.id, email: u.email, birthDate: acct.birth_date, createdAt: acct.created_at }, inviter);
      if (acct.email_verified_at) await qualifyReferral(c, ctx.realtime, u.id);
    });
    await announceReferral(db, ctx.realtime, u.id, inviter.id);
    const { rows } = await db.query(`SELECT ${PUBLIC_USER_COLS} FROM profiles pr WHERE pr.user_id = $1`, [inviter.id]);
    return { inviter: toPublicUser(rows[0] as PublicUserRow) };
  });
}
