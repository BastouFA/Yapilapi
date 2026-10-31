import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { freeNowSchema, planAnswerSchema, planCreateSchema, planEditSchema, planExpenseSchema, planInviteSchema, planSettlementSchema } from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { featureDisabled, parse } from '../lib/errors.ts';
import {
  addExpense,
  answerOf,
  answerPlan,
  cancelPlan,
  clearFree,
  createPlan,
  editPlan,
  freeFriends,
  inviteToPlan,
  markPaidBack,
  ownFree,
  planCandidates,
  planCards,
  planFor,
  removeExpense,
  setFree,
  undoPaidBack,
} from '../lib/plans.ts';
import { isEnabled, track } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const expenseParam = z.object({ id: z.string().uuid(), expenseId: z.string().uuid() });
const settlementParam = z.object({ id: z.string().uuid(), settlementId: z.string().uuid() });

/**
 * Go out together (lib/plans.ts, docs/product/go-out-together.md): "I'm free", plans with friends
 * and their answers, and the cost split. A plan's chat is an ordinary group conversation (polls in
 * it are chat polls). Everything about a plan is for the people in it; anyone else gets "not found".
 */
export default async function plansModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };
  const on = async () => {
    if (!(await isEnabled(db, 'GO_OUT'))) throw featureDisabled('Go out together');
  };

  // ── I'm free ─────────────────────────────────────────────────────────

  /** Yours, and your friends who said they're free (newest first). */
  app.get('/v1/free', { preHandler: requireAuth }, async (req) => {
    if (!(await isEnabled(db, 'GO_OUT'))) return { mine: null, friends: [] };
    const u = me(req);
    return { mine: await ownFree(db, u.id), friends: await freeFriends(db, u.id) };
  });

  /** Say you're free now or tonight (until a time, with a few words). Only friends see it; it ends by itself. */
  app.put('/v1/me/free', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const free = await setFree(db, u.id, parse(freeNowSchema, req.body));
    track(db, u.id, 'free_now_set', {});
    return { free };
  });

  app.delete('/v1/me/free', { preHandler: requireAuth }, async (req) => {
    await clearFree(db, me(req).id);
    return { free: null };
  });

  // ── Plans ────────────────────────────────────────────────────────────

  /** Your plans: coming up, then earlier. */
  app.get('/v1/plans', { preHandler: requireAuth }, async (req) => {
    if (!(await isEnabled(db, 'GO_OUT'))) return { upcoming: [], past: [] };
    return planCards(db, me(req).id);
  });

  /** Make a plan and invite friends (or a squad you're in). Its group chat is made with it. */
  app.post('/v1/plans', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const made = await createPlan(deps, u.id, parse(planCreateSchema, req.body));
    track(db, u.id, 'plan_created', { invited: made.invited.length });
    reply.code(201);
    return { plan: await planFor(db, made.id, u.id) };
  });

  /** Friends you could invite, for a new plan or this one (`planId`: people not in it yet). */
  app.get('/v1/plans/candidates', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const q = parse(z.object({ planId: z.string().uuid().optional(), q: z.string().trim().max(60).optional() }), req.query);
    if (q.planId) await answerOf(db, q.planId, u.id);
    return { items: await planCandidates(db, u.id, q.planId ?? null, q.q || null) };
  });

  app.get('/v1/plans/:id', { preHandler: requireAuth }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    return { plan: await planFor(db, id, me(req).id) };
  });

  /** The maker changes what, when, where or the details. */
  app.patch('/v1/plans/:id', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await editPlan(deps, id, u.id, parse(planEditSchema, req.body));
    return { plan: await planFor(db, id, u.id) };
  });

  /** The maker cancels it. */
  app.post('/v1/plans/:id/cancel', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await cancelPlan(deps, id, u.id);
    return { plan: await planFor(db, id, u.id) };
  });

  /** I'm in, Maybe or Can't. In and Maybe are in the plan's chat; Can't is out of it. */
  app.post('/v1/plans/:id/answer', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await answerPlan(deps, id, u.id, parse(planAnswerSchema, req.body).answer);
    return { plan: await planFor(db, id, u.id) };
  });

  /** Invite more friends, or a squad (the maker, and anyone who said I'm in or Maybe). */
  app.post('/v1/plans/:id/invites', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const invited = await inviteToPlan(deps, id, u.id, parse(planInviteSchema, req.body));
    return { invited: invited.length, plan: await planFor(db, id, u.id) };
  });

  // ── Cost split (a record only: no money moves through YAPILAPI) ──────

  app.post('/v1/plans/:id/expenses', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await addExpense(deps, id, u.id, parse(planExpenseSchema, req.body));
    reply.code(201);
    return { plan: await planFor(db, id, u.id) };
  });

  app.delete('/v1/plans/:id/expenses/:expenseId', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const { id, expenseId } = parse(expenseParam, req.params);
    await removeExpense(deps, id, u.id, expenseId);
    return { plan: await planFor(db, id, u.id) };
  });

  /** Mark that someone paid someone back (one of the two marks it). */
  app.post('/v1/plans/:id/paid-back', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await markPaidBack(deps, id, u.id, parse(planSettlementSchema, req.body));
    reply.code(201);
    return { plan: await planFor(db, id, u.id) };
  });

  app.delete('/v1/plans/:id/paid-back/:settlementId', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const { id, settlementId } = parse(settlementParam, req.params);
    await undoPaidBack(deps, id, u.id, settlementId);
    return { plan: await planFor(db, id, u.id) };
  });
}
