import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tx } from '@yapilapi/database';
import { CHAIN_RULES, chainEditSchema, chainPassSchema, chainStartSchema } from '@yapilapi/shared';
import type { AppContext } from '../lib/context.ts';
import { AppError, featureDisabled, notFound, parse } from '../lib/errors.ts';
import { assertPromptOk, assertStarter, chainSeenSql, chainsById, liveLinkSql, passTheMic, startChain, visibleLinkSql } from '../lib/chains.ts';
import { fairStartOf, fairStartOffered } from '../lib/fair-start.ts';
import { byOrWithSql } from '../lib/collabs.ts';
import { hydratePosts } from '../lib/posts.ts';
import { seesSensitiveMedia } from '../lib/interactions.ts';
import { audit, isEnabled } from '../lib/services.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Pass the Mic (chains of reels, lib/chains.ts) and Fair start (lib/fair-start.ts):
 * docs/product/pass-the-mic.md. Taking the mic is posting a reel with `chainId`
 * (POST /v1/posts); starting a chain with a new reel is posting it with `chainPrompt`.
 */
export default async function passTheMicModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const on = async () => {
    if (!(await isEnabled(db, 'PASS_THE_MIC'))) throw featureDisabled('Pass the Mic');
  };
  const chainFor = async (id: string, viewer: string | null) => {
    const [chain] = await chainsById(db, [id], viewer, await seesSensitiveMedia(db, viewer));
    if (!chain) throw notFound('That chain');
    return chain;
  };

  /** Start a chain from one of your reels already posted. */
  app.post('/v1/chains', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    await on();
    const u = me(req);
    const input = parse(chainStartSchema, req.body);
    const id = await tx(db, (c) => startChain(c, u.id, input.postId, input.prompt, input.whoCanJoin));
    reply.code(201);
    return { chain: await chainFor(id, u.id) };
  });

  /** Active chains for Wander: a new reel in the last CHAIN_RULES.activeDays days, the busiest first. Squads' chains stay in their squads. */
  app.get('/v1/chains/active', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    if (!(await isEnabled(db, 'PASS_THE_MIC'))) return { items: [] };
    const viewer = req.user?.id ?? null;
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(30).default(12) }), req.query);
    const sensitive = await seesSensitiveMedia(db, viewer);
    const { rows } = await db.query<{ id: string }>(
      `SELECT ch.id FROM reel_chains ch
       WHERE ch.last_link_at > now() - make_interval(days => $3) AND ch.squad_id IS NULL AND ${chainSeenSql('$1')}
         AND EXISTS (SELECT 1 FROM reel_chain_links l WHERE l.chain_id = ch.id AND ${visibleLinkSql('$4')})
       ORDER BY (SELECT count(*) FROM reel_chain_links l WHERE l.chain_id = ch.id AND l.created_at > now() - make_interval(days => $3) AND ${liveLinkSql()}) DESC,
                ch.last_link_at DESC
       LIMIT $2`,
      [viewer, q.limit, CHAIN_RULES.activeDays, sensitive],
    );
    return {
      items: await chainsById(
        db,
        rows.map((r) => r.id),
        viewer,
        sensitive,
      ),
    };
  });

  app.get('/v1/chains/:id', async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    return { chain: await chainFor(id, req.user?.id ?? null) };
  });

  /** The chain's reels you can see, in order (a reel you can't see is left out, never shown). */
  app.get('/v1/chains/:id/links', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ cursor: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(50).default(24) }), req.query);
    const viewer = req.user?.id ?? null;
    await chainFor(id, viewer);
    const { rows } = await db.query<{ post_id: string; position: number }>(
      `SELECT l.post_id, l.position FROM reel_chain_links l
       WHERE l.chain_id = $2 AND l.position > $3 AND ${visibleLinkSql('$5')}
       ORDER BY l.position LIMIT $4`,
      [viewer, id, q.cursor ?? 0, q.limit + 1, await seesSensitiveMedia(db, viewer)],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.post_id),
        viewer,
      ),
      nextCursor: rows.length > q.limit ? String(page.at(-1)!.position) : null,
    };
  });

  /** The reel before or after one in its chain, among those you can see: moving sideways in the reels viewer. */
  app.get('/v1/chains/:id/step', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ from: z.string().uuid(), dir: z.enum(['next', 'previous']) }), req.query);
    const viewer = req.user?.id ?? null;
    await chainFor(id, viewer);
    const next = q.dir === 'next';
    const { rows } = await db.query<{ post_id: string }>(
      `SELECT l.post_id FROM reel_chain_links l
       WHERE l.chain_id = $2 AND l.position ${next ? '>' : '<'} (SELECT f.position FROM reel_chain_links f WHERE f.post_id = $3 AND f.chain_id = $2)
         AND ${visibleLinkSql('$4')}
       ORDER BY l.position ${next ? 'ASC' : 'DESC'} LIMIT 1`,
      [viewer, id, q.from, await seesSensitiveMedia(db, viewer)],
    );
    const [post] = rows[0] ? await hydratePosts(db, [rows[0].post_id], viewer) : [];
    return { post: post ?? null };
  });

  /** The starter changes the prompt or who can take the mic ('nobody' closes the chain; reels in it stay). */
  app.patch('/v1/chains/:id', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(chainEditSchema, req.body);
    await assertStarter(db, id, u.id);
    if (input.prompt) assertPromptOk(input.prompt);
    await db.query(`UPDATE reel_chains SET prompt = coalesce($2, prompt), who_can_join = coalesce($3, who_can_join), updated_at = now() WHERE id = $1`, [
      id,
      input.prompt ?? null,
      input.whoCanJoin ?? null,
    ]);
    return { chain: await chainFor(id, u.id) };
  });

  /**
   * Take a reel out of a chain: the starter removes any reel, a reel's author leaves with theirs.
   * The reel itself stays up, on its author's profile and in feeds.
   */
  app.delete('/v1/chains/:id/links/:postId', { preHandler: requireAuth }, async (req) => {
    await on();
    const u = me(req);
    const { id, postId } = parse(z.object({ id: z.string().uuid(), postId: z.string().uuid() }), req.params);
    const { rows } = await db.query(
      `SELECT l.author_id, ch.starter_id FROM reel_chain_links l JOIN reel_chains ch ON ch.id = l.chain_id
       WHERE l.post_id = $2 AND l.chain_id = $3 AND ${chainSeenSql('$1')}`,
      [u.id, postId, id],
    );
    const l = rows[0];
    if (!l || (l.author_id !== u.id && l.starter_id !== u.id)) throw notFound('That reel');
    await db.query(`DELETE FROM reel_chain_links WHERE post_id = $1 AND chain_id = $2`, [postId, id]);
    if (l.author_id !== u.id) await audit(db, { actorId: u.id, action: 'chain.link_removed', entityType: 'post', entityId: postId, metadata: { chainId: id } });
    return { removed: true };
  });

  /**
   * Pass the mic: invite people you follow or are friends with to add the next reel. Each is told
   * once per chain, and only when they may take the mic (they see the chain, the starter allows
   * them, minor protection); others are skipped without saying why. An @mention in a chain reel's
   * caption passes it too (lib/chains.ts passTheMicByMention), within the same limits.
   */
  app.post('/v1/chains/:id/pass', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await on();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(chainPassSchema, req.body);
    const chain = await chainFor(id, u.id);
    const sent = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reel_chain_passes WHERE chain_id = $1 AND from_id = $2`, [id, u.id])).rows[0]!
      .n;
    const max = CHAIN_RULES.passesPerChain;
    if (sent + userIds.length > max) throw new AppError(429, 'chain_limit', `You can pass the mic on one chain to up to ${max} people.`);
    const passed = await passTheMic(db, ctx.realtime, { chainId: id, fromId: u.id, userIds, prompt: chain.prompt });
    return { passed: passed.length };
  });

  // ── Fair start ────────────────────────────────────────────────────────

  /** Whether your next reel gets a fair start, for the line in the composer ("We'll show it to up to 1,000 people"). */
  app.get('/v1/me/fair-start', { preHandler: requireAuth }, async (req) => ({ offered: await fairStartOffered(db, me(req).id, ctx.config.SPAM_CHECKS) }));

  /** Your reel's fair start: how far it got, and the report. Authors and co-authors only. */
  app.get('/v1/posts/:id/fair-start', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const own = await db.query(`SELECT 1 FROM posts p WHERE p.id = $2 AND p.deleted_at IS NULL AND ${byOrWithSql('$1')}`, [u.id, id]);
    if (!own.rowCount) throw notFound('Post');
    return { fairStart: await fairStartOf(db, id) };
  });

  // ── Admin ─────────────────────────────────────────────────────────────

  /** For the admin console: chains this week, and the fair-start pool. */
  app.get('/v1/admin/pass-the-mic', { preHandler: requireRole('admin') }, async () => {
    const [chains, fair] = await Promise.all([
      db.query(
        `SELECT count(*) FILTER (WHERE ch.last_link_at > now() - make_interval(days => $1))::int AS active, count(*)::int AS total,
                (SELECT count(*) FROM reel_chain_links)::int AS links
         FROM reel_chains ch`,
        [CHAIN_RULES.activeDays],
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'active' AND slowed)::int AS slowed,
                count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'stopped')::int AS stopped,
                coalesce(round(avg(reached) FILTER (WHERE status = 'done')), 0)::int AS average_reached
         FROM fair_start_reels`,
      ),
    ]);
    const f = fair.rows[0];
    return {
      chains: chains.rows[0] as { active: number; total: number; links: number },
      fairStart: { active: f.active, slowed: f.slowed, done: f.done, stopped: f.stopped, averageReached: f.average_reached } as {
        active: number;
        slowed: number;
        done: number;
        stopped: number;
        averageReached: number;
      },
    };
  });
}
