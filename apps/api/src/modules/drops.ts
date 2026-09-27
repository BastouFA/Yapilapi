import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  createDropSchema,
  dropCoverSchema,
  DROP_SCHEDULE_MESSAGES,
  dropScheduleProblem,
  updateDropSchema,
  type Drop,
  type DropActivity,
  type DropStats,
  type PublicDropPreview,
} from '@yapilapi/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { AppError, badRequest, featureDisabled, notFound, parse } from '../lib/errors.ts';
import { enqueueAt } from '../lib/jobs.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { audit, isEnabled, notify } from '../lib/services.ts';
import { assertAdultForMoney, plusCol, publicUserFrom } from '../lib/users.ts';
import { DROP_END_JOB, DROP_OPEN_JOB, DROP_RELEASE_JOB, dropVisibleSql, expireDropHold, publishDropChange, releaseDropOrder } from '../lib/drops.ts';
import { excerpt, publicAccountSql } from './public.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
/** Drafts and scheduled drops one seller can have at once. */
const MAX_PENDING_DROPS = 20;
/** Only things that ship or download can be in a drop (services and tickets have their own flows). */
const DROP_KINDS = ['product', 'digital'];
/** Ended drops stay on a profile this long. */
const RECENT_ENDED_DAYS = 14;

const DROP_COLS = `d.id, d.seller_id, d.title, d.description, d.cover_url, d.cover_alt, d.starts_at, d.ends_at, d.status, d.end_reason,
  d.published_at, d.opened_at, d.ended_at, d.cancelled_at, d.created_at,
  dpr.user_id AS s_id, dpr.username AS s_username, dpr.display_name AS s_display_name, dpr.avatar_url AS s_avatar_url, dpr.mode AS s_mode, ${plusCol('s_', 'dpr')}`;
const DROP_FROM = `FROM drops d JOIN profiles dpr ON dpr.user_id = d.seller_id JOIN users du ON du.id = d.seller_id`;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A draft (whatever its time), or a scheduled drop whose start hasn't come. */
const beforeOpening = (d: { status: string; starts_at: Date }) => d.status === 'draft' || (d.status === 'scheduled' && d.starts_at > new Date());

function scheduleCheck(startsAt: string | Date, endsAt: string | Date | null | undefined) {
  const p = dropScheduleProblem(startsAt, endsAt);
  if (p) throw new AppError(400, 'validation_failed', DROP_SCHEDULE_MESSAGES[p.problem], { fields: { [p.field]: DROP_SCHEDULE_MESSAGES[p.problem] } });
}

/**
 * Drops: a seller schedules a launch of some of their own products (drafts until published).
 * Before it opens, anyone who can see it can ask to be told when it does; only the seller sees
 * how many are waiting. At the start time a job opens it, tells the people waiting (in the app
 * and by push), and the products can be bought through the usual checkout (lib/drops.ts holds
 * the stock rules). It ends at its end time, when everything has sold, or when the seller
 * cancels it. Nothing is ever charged before a drop opens.
 */
export default async function dropsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const commerceOn = async () => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Drops');
  };

  /** Drops by id, in that order, as the viewer may see them. The seller also gets the numbers. */
  async function loadDrops(ids: string[], viewer: string | null, withStats = true): Promise<Drop[]> {
    if (!ids.length) return [];
    const { rows } = await db.query(
      `SELECT ${DROP_COLS}, EXISTS (SELECT 1 FROM drop_reminders r WHERE r.drop_id = d.id AND r.user_id = $2) AS reminded
       ${DROP_FROM} WHERE d.id = ANY($1) AND ${dropVisibleSql('$2')}`,
      [ids, viewer],
    );
    if (!rows.length) return [];
    const found = rows.map((r) => r.id as string);
    const items = await db.query(
      `SELECT di.drop_id, di.product_id, di.quantity, di.per_buyer_limit, di.taken, di.sold_out_at,
              pd.kind, pd.title, pd.description, pd.price_cents, pd.currency,
              (SELECT coalesce(sum(o.quantity), 0) FROM drop_orders o
               WHERE o.drop_id = di.drop_id AND o.product_id = di.product_id AND o.buyer_id = $2 AND o.status <> 'released')::int AS yours
       FROM drop_items di JOIN products pd ON pd.id = di.product_id
       WHERE di.drop_id = ANY($1) AND pd.deleted_at IS NULL ORDER BY di.position, pd.title`,
      [found, viewer],
    );
    const own = rows.filter((r) => r.seller_id === viewer).map((r) => r.id as string);
    const stats = withStats && own.length ? await statsFor(own) : new Map<string, DropStats>();
    const byId = new Map(
      rows.map((r) => {
        const drop: Drop = {
          id: r.id,
          title: r.title,
          description: r.description,
          coverUrl: r.cover_url,
          coverAlt: r.cover_url ? (r.cover_alt ?? null) : null,
          startsAt: r.starts_at.toISOString(),
          endsAt: iso(r.ends_at),
          status: r.status,
          endReason: r.end_reason ?? null,
          seller: publicUserFrom(r, 's_'),
          items: items.rows
            .filter((i) => i.drop_id === r.id)
            .map((i) => ({
              productId: i.product_id,
              kind: i.kind,
              title: i.title,
              description: i.description,
              priceCents: i.price_cents,
              currency: String(i.currency).trim(),
              quantity: i.quantity,
              perBuyerLimit: i.per_buyer_limit,
              // Real numbers: what the drop has, less what is sold or held in unpaid orders.
              remaining: i.quantity === null ? null : Math.max(0, i.quantity - i.taken),
              soldOut: i.quantity !== null && i.taken >= i.quantity,
              soldOutAt: iso(i.sold_out_at),
              ...(viewer ? { yours: i.yours } : {}),
            })),
          reminded: r.reminded,
          isSeller: r.seller_id === viewer,
          publishedAt: iso(r.published_at),
          openedAt: iso(r.opened_at),
          endedAt: iso(r.ended_at),
          cancelledAt: iso(r.cancelled_at),
          createdAt: r.created_at.toISOString(),
          ...(stats.has(r.id) ? { stats: stats.get(r.id) } : {}),
        };
        return [r.id as string, drop];
      }),
    );
    return ids.map((id) => byId.get(id)).filter((d): d is Drop => !!d);
  }

  /** The seller's numbers: people waiting, paid orders, units sold and held, money in, and when each product sold out. */
  async function statsFor(ids: string[]): Promise<Map<string, DropStats>> {
    const [waiting, items, orders] = await Promise.all([
      db.query(`SELECT drop_id, count(*)::int AS n FROM drop_reminders WHERE drop_id = ANY($1) GROUP BY drop_id`, [ids]),
      db.query(
        `SELECT di.drop_id, di.product_id, di.sold_out_at, pd.currency,
                coalesce(sum(o.quantity) FILTER (WHERE o.status = 'paid'), 0)::int AS sold,
                coalesce(sum(o.quantity) FILTER (WHERE o.status = 'held'), 0)::int AS held,
                coalesce(sum(o.quantity * oi.unit_cents) FILTER (WHERE o.status = 'paid'), 0)::bigint AS gross
         FROM drop_items di JOIN products pd ON pd.id = di.product_id
         LEFT JOIN drop_orders o ON o.drop_id = di.drop_id AND o.product_id = di.product_id
         LEFT JOIN order_items oi ON oi.order_id = o.order_id AND oi.product_id = o.product_id
         WHERE di.drop_id = ANY($1) GROUP BY di.drop_id, di.product_id, di.sold_out_at, pd.currency, di.position ORDER BY di.position`,
        [ids],
      ),
      db.query(`SELECT drop_id, count(DISTINCT order_id)::int AS n FROM drop_orders WHERE drop_id = ANY($1) AND status = 'paid' GROUP BY drop_id`, [ids]),
    ]);
    const out = new Map<string, DropStats>();
    for (const id of ids) {
      const mine = items.rows.filter((r) => r.drop_id === id);
      const revenue = new Map<string, number>();
      for (const r of mine) {
        const cur = String(r.currency).trim();
        revenue.set(cur, (revenue.get(cur) ?? 0) + Number(r.gross));
      }
      out.set(id, {
        waiting: waiting.rows.find((r) => r.drop_id === id)?.n ?? 0,
        orders: orders.rows.find((r) => r.drop_id === id)?.n ?? 0,
        unitsSold: mine.reduce((n, r) => n + r.sold, 0),
        unitsHeld: mine.reduce((n, r) => n + r.held, 0),
        revenue: [...revenue].filter(([, cents]) => cents > 0).map(([currency, grossCents]) => ({ currency, grossCents })),
        items: mine.map((r) => ({ productId: r.product_id, sold: r.sold, held: r.held, grossCents: Number(r.gross), soldOutAt: iso(r.sold_out_at) })),
      });
    }
    return out;
  }

  async function loadDrop(id: string, viewer: string | null): Promise<Drop> {
    const d = (await loadDrops([id], viewer))[0];
    if (!d) throw notFound('That drop');
    return d;
  }

  /** Your own drop, locked for a change. */
  async function ownDrop(c: PoolClient, id: string, userId: string) {
    const d = (await c.query(`SELECT * FROM drops WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
    if (!d || d.seller_id !== userId) throw notFound('That drop');
    return d;
  }

  /**
   * The products must be your own, on sale (not deleted or archived), things that ship or
   * download, and not in another drop that is still to come or open.
   */
  async function checkItems(c: PoolClient, sellerId: string, dropId: string | null, items: { productId: string }[]) {
    const ids = items.map((i) => i.productId);
    const { rows } = await c.query(
      `SELECT pd.id, pd.kind,
              EXISTS (SELECT 1 FROM drop_items di JOIN drops d ON d.id = di.drop_id
                      WHERE di.product_id = pd.id AND d.status IN ('draft', 'scheduled', 'open') AND d.deleted_at IS NULL
                        AND d.id IS DISTINCT FROM $3::uuid) AS busy
       FROM products pd WHERE pd.id = ANY($1) AND pd.seller_id = $2 AND pd.deleted_at IS NULL AND pd.status = 'active'
       FOR UPDATE OF pd`,
      [ids, sellerId, dropId],
    );
    if (rows.length !== ids.length) throw badRequest('Choose products from your own shop.', { fields: { items: 'Choose products from your own shop.' } });
    if (rows.some((r) => !DROP_KINDS.includes(r.kind)))
      throw badRequest('Only products and downloads can be in a drop.', { fields: { items: 'Only products and downloads can be in a drop.' } });
    if (rows.some((r) => r.busy))
      throw new AppError(409, 'conflict', 'One of these products is already in another drop.', { fields: { items: 'Already in another drop.' } });
    return new Map(rows.map((r) => [r.id as string, r.kind as string]));
  }

  async function writeItems(
    c: PoolClient,
    dropId: string,
    kinds: Map<string, string>,
    items: { productId: string; quantity?: number | null; perBuyerLimit?: number | null }[],
  ) {
    await c.query(`DELETE FROM drop_items WHERE drop_id = $1`, [dropId]);
    for (const [position, i] of items.entries())
      await c.query(`INSERT INTO drop_items (drop_id, product_id, position, quantity, per_buyer_limit) VALUES ($1,$2,$3,$4,$5)`, [
        dropId,
        i.productId,
        position,
        i.quantity ?? null,
        // A download is one each anyway.
        kinds.get(i.productId) === 'digital' ? 1 : (i.perBuyerLimit ?? null),
      ]);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────
  // At the start time: open, then tell each person waiting (once, even if the job runs again).
  // A drop that was moved later, cancelled or already opened is left alone.
  ctx.jobs[DROP_OPEN_JOB] = async ({ id }: { id: string }) => {
    const d = (
      await db.query(
        `UPDATE drops SET status = 'open', opened_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'scheduled' AND starts_at <= now() AND deleted_at IS NULL RETURNING id, seller_id, title, ends_at`,
        [id],
      )
    ).rows[0];
    if (d?.ends_at) await enqueueAt(db, DROP_END_JOB, { id }, d.ends_at);
    if (d) await publishDropChange(db, ctx.realtime, id);
    const drop = d ?? (await db.query(`SELECT id, seller_id, title FROM drops WHERE id = $1 AND status IN ('open', 'ended')`, [id])).rows[0];
    if (!drop) return;
    for (;;) {
      const batch = (await db.query(`SELECT user_id FROM drop_reminders WHERE drop_id = $1 AND notified_at IS NULL LIMIT 200`, [id])).rows;
      if (!batch.length) break;
      for (const r of batch) {
        await notify(db, ctx.realtime, {
          userId: r.user_id,
          category: 'commerce',
          type: 'drop_opened',
          actorId: drop.seller_id,
          entityType: 'drop',
          entityId: id,
          data: { title: drop.title },
        });
        await db.query(`UPDATE drop_reminders SET notified_at = now() WHERE drop_id = $1 AND user_id = $2`, [id, r.user_id]);
      }
    }
  };

  ctx.jobs[DROP_END_JOB] = async ({ id }: { id: string }) => {
    const r = await db.query(
      `UPDATE drops SET status = 'ended', end_reason = 'time', ended_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'open' AND ends_at <= now() RETURNING id`,
      [id],
    );
    if (r.rowCount) await publishDropChange(db, ctx.realtime, id);
  };

  ctx.jobs[DROP_RELEASE_JOB] = async ({ orderId }: { orderId: string }) => {
    const drops = await tx(db, async (c) => {
      const ids = (await c.query<{ drop_id: string }>(`SELECT DISTINCT drop_id FROM drop_orders WHERE order_id = $1`, [orderId])).rows;
      return (await expireDropHold(c, orderId)) ? ids : [];
    });
    for (const d of drops) await publishDropChange(db, ctx.realtime, d.drop_id);
  };

  // ── Seller ────────────────────────────────────────────────────────────
  app.post('/v1/drops', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    await commerceOn();
    const u = me(req);
    const input = parse(createDropSchema, req.body);
    // Selling is for adults (creator and seller terms).
    await assertAdultForMoney(db, u.id);
    scheduleCheck(input.startsAt, input.endsAt);
    const id = await tx(db, async (c) => {
      const pending = await c.query(`SELECT count(*)::int AS n FROM drops WHERE seller_id = $1 AND status IN ('draft', 'scheduled')`, [u.id]);
      if (pending.rows[0].n >= MAX_PENDING_DROPS) throw new AppError(409, 'too_many', `You can have up to ${MAX_PENDING_DROPS} drops waiting at once.`);
      const kinds = await checkItems(c, u.id, null, input.items);
      const { rows } = await c.query(`INSERT INTO drops (seller_id, title, description, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        u.id,
        input.title,
        input.description,
        input.startsAt,
        input.endsAt ?? null,
      ]);
      await writeItems(c, rows[0].id, kinds, input.items);
      return rows[0].id as string;
    });
    reply.code(201);
    return { drop: await loadDrop(id, u.id) };
  });

  /** Change a draft or a drop that hasn't opened yet. A new start time moves the opening with it. */
  app.patch('/v1/drops/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(updateDropSchema, req.body);
    await tx(db, async (c) => {
      const d = await ownDrop(c, id, u.id);
      if (!beforeOpening(d)) throw new AppError(409, 'drop_started', 'A drop can only be changed before it opens.');
      const startsAt = input.startsAt ?? d.starts_at;
      const endsAt = input.endsAt === undefined ? d.ends_at : input.endsAt;
      if (input.startsAt !== undefined || input.endsAt !== undefined) scheduleCheck(startsAt, endsAt);
      if (input.items) await writeItems(c, id, await checkItems(c, u.id, id, input.items), input.items);
      await c.query(
        `UPDATE drops SET title = coalesce($2, title), description = coalesce($3, description), starts_at = $4, ends_at = $5, updated_at = now() WHERE id = $1`,
        [id, input.title ?? null, input.description ?? null, startsAt, endsAt],
      );
      // The earlier job does nothing once its time no longer matches.
      if (d.status === 'scheduled' && input.startsAt !== undefined) await enqueueAt(c, DROP_OPEN_JOB, { id }, new Date(startsAt));
    });
    return { drop: await loadDrop(id, u.id) };
  });

  /** Publish a draft: people can see it and ask to be told, and it opens at its start time. */
  app.post('/v1/drops/:id/publish', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    await commerceOn();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await assertAdultForMoney(db, u.id);
    await tx(db, async (c) => {
      const d = await ownDrop(c, id, u.id);
      if (d.status !== 'draft') throw new AppError(409, 'conflict', 'This drop is already published.');
      scheduleCheck(d.starts_at, d.ends_at);
      const items = (await c.query(`SELECT product_id AS "productId" FROM drop_items WHERE drop_id = $1`, [id])).rows;
      if (!items.length) throw badRequest('Add at least one product.', { fields: { items: 'Add at least one product.' } });
      await checkItems(c, u.id, id, items);
      await c.query(`UPDATE drops SET status = 'scheduled', published_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await enqueueAt(c, DROP_OPEN_JOB, { id }, d.starts_at);
      await audit(c, { actorId: u.id, action: 'drop.publish', entityType: 'drop', entityId: id });
    });
    return { drop: await loadDrop(id, u.id) };
  });

  /**
   * Cancel a drop that is scheduled or open. Everyone waiting is told. Nothing was charged
   * before it opened; unpaid orders are cancelled and their units released, and orders already
   * paid stay paid (the seller can refund them as with any order).
   */
  app.post('/v1/drops/:id/cancel', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await tx(db, async (c) => {
      const d = await ownDrop(c, id, u.id);
      if (!['scheduled', 'open'].includes(d.status)) throw new AppError(409, 'conflict', 'Only a drop that is scheduled or open can be cancelled.');
      await c.query(`UPDATE drops SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [id]);
      const pending = await c.query<{ order_id: string }>(
        `SELECT o.id AS order_id FROM orders o
         WHERE o.status = 'pending' AND o.id IN (SELECT order_id FROM drop_orders WHERE drop_id = $1 AND status = 'held') FOR UPDATE`,
        [id],
      );
      for (const o of pending.rows) {
        await c.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [o.order_id]);
        await releaseDropOrder(c, o.order_id);
      }
      const waiting = await c.query<{ user_id: string }>(`SELECT user_id FROM drop_reminders WHERE drop_id = $1`, [id]);
      for (const w of waiting.rows)
        await notify(c, ctx.realtime, {
          userId: w.user_id,
          category: 'commerce',
          type: 'drop_cancelled',
          actorId: u.id,
          entityType: 'drop',
          entityId: id,
          data: { title: d.title },
        });
      await audit(c, { actorId: u.id, action: 'drop.cancel', entityType: 'drop', entityId: id, metadata: { was: d.status, unpaidOrders: pending.rowCount } });
    });
    await publishDropChange(db, ctx.realtime, id);
    return { drop: await loadDrop(id, u.id) };
  });

  /** Delete a draft (published drops are cancelled instead, so the people waiting hear about it). */
  app.delete('/v1/drops/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await tx(db, async (c) => {
      const d = await ownDrop(c, id, u.id);
      if (d.status !== 'draft') throw new AppError(409, 'conflict', 'Only a draft can be deleted. Cancel a published drop instead.');
      await c.query(`DELETE FROM drops WHERE id = $1`, [id]);
    });
    return { ok: true };
  });

  /** The cover: one of your own photos, processed and not flagged. Changed before the drop opens. */
  app.put('/v1/drops/:id/cover', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(dropCoverSchema, req.body);
    await tx(db, async (c) => {
      const d = await ownDrop(c, id, u.id);
      if (!beforeOpening(d)) throw new AppError(409, 'drop_started', 'A drop can only be changed before it opens.');
      const m = (
        await c.query(`SELECT kind, status, moderation, variants, alt_text FROM media WHERE id = $1 AND owner_id = $2 AND NOT private AND deleted_at IS NULL`, [
          input.mediaId,
          u.id,
        ])
      ).rows[0];
      if (!m) throw notFound('That photo');
      if (m.kind !== 'image') throw badRequest('Choose a photo for the cover.');
      if (m.moderation === 'blocked') throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
      if (m.moderation === 'sensitive') throw new AppError(422, 'media_sensitive', 'This photo may be sensitive, so it can’t be a cover. Choose another one.');
      const variants = (m.variants ?? {}) as Record<string, string>;
      const url = variants.large ?? variants.medium;
      if (m.status !== 'ready' || !url) throw new AppError(409, 'media_processing', 'Your photo is still being prepared. Try again in a moment.');
      await c.query(`UPDATE drops SET cover_url = $2, cover_media_id = $3, cover_alt = $4, updated_at = now() WHERE id = $1`, [
        id,
        url,
        input.mediaId,
        input.altText || m.alt_text || null,
      ]);
      await c.query(`UPDATE media SET used_at = coalesce(used_at, now()) WHERE id = $1`, [input.mediaId]);
    });
    return { drop: await loadDrop(id, u.id) };
  });

  app.delete('/v1/drops/:id/cover', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await tx(db, async (c) => {
      const d = await ownDrop(c, id, u.id);
      if (!beforeOpening(d)) throw new AppError(409, 'drop_started', 'A drop can only be changed before it opens.');
      await c.query(`UPDATE drops SET cover_url = NULL, cover_media_id = NULL, cover_alt = NULL, updated_at = now() WHERE id = $1`, [id]);
    });
    return { drop: await loadDrop(id, u.id) };
  });

  /** Your drops as a seller, drafts included, newest first, with their numbers. */
  app.get('/v1/me/drops', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT id FROM drops WHERE seller_id = $1 AND deleted_at IS NULL
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, starts_at DESC LIMIT 50`,
      [u.id],
    );
    return {
      items: await loadDrops(
        rows.map((r) => r.id),
        u.id,
      ),
    };
  });

  // ── Everyone ──────────────────────────────────────────────────────────
  app.get('/v1/drops/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return { drop: await loadDrop(id, req.user?.id ?? null) };
  });

  /** "Notify me": a reminder when the drop opens. Not a payment, and nothing is held for you. */
  app.post('/v1/drops/:id/remind', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    await commerceOn();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const d = await loadDrop(id, u.id);
    if (d.isSeller) throw badRequest('This is your own drop.');
    if (d.status !== 'scheduled') throw new AppError(409, 'conflict', d.status === 'open' ? 'This drop is already open.' : 'This drop isn’t coming up.');
    await db.query(`INSERT INTO drop_reminders (drop_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
    return { reminded: true };
  });

  app.delete('/v1/drops/:id/remind', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await db.query(`DELETE FROM drop_reminders WHERE drop_id = $1 AND user_id = $2`, [id, u.id]);
    return { reminded: false };
  });

  /** A person's drops on their profile: open and coming up, then ones that ended in the last two weeks. */
  app.get('/v1/users/:id/drops', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const { rows } = await db.query(
      `SELECT d.id ${DROP_FROM}
       WHERE d.seller_id = $1 AND ${dropVisibleSql('$2')}
         AND (d.status IN ('scheduled', 'open') OR (d.status = 'ended' AND d.ended_at > now() - make_interval(days => $3)))
       ORDER BY CASE d.status WHEN 'open' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, d.starts_at LIMIT 10`,
      [id, viewer, RECENT_ENDED_DAYS],
    );
    return {
      items: await loadDrops(
        rows.map((r) => r.id),
        viewer,
        false,
      ),
    };
  });

  /** For Home: drops that are open or coming up from people you follow. */
  app.get('/v1/drops/following', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT d.id ${DROP_FROM}
       WHERE d.status IN ('scheduled', 'open') AND d.seller_id IN (SELECT followee_id FROM follows WHERE follower_id = $1) AND ${dropVisibleSql('$1')}
       ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.starts_at LIMIT 10`,
      [u.id],
    );
    return {
      items: await loadDrops(
        rows.map((r) => r.id),
        u.id,
        false,
      ),
    };
  });

  /** "Your drops" as a buyer: drops you asked to hear about, and what you bought in drops. */
  app.get('/v1/me/drop-activity', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT x.drop_id, max(x.at) AS at FROM (
         SELECT drop_id, created_at AS at FROM drop_reminders WHERE user_id = $1
         UNION ALL SELECT drop_id, created_at FROM drop_orders WHERE buyer_id = $1
       ) x GROUP BY x.drop_id ORDER BY at DESC LIMIT 50`,
      [u.id],
    );
    const drops = await loadDrops(
      rows.map((r) => r.drop_id),
      u.id,
      false,
    );
    const purchases = await db.query(
      `SELECT dor.drop_id, dor.order_id, dor.product_id, pd.title, dor.quantity, dor.status, dor.created_at
       FROM drop_orders dor JOIN products pd ON pd.id = dor.product_id
       WHERE dor.buyer_id = $1 AND dor.drop_id = ANY($2) ORDER BY dor.created_at DESC`,
      [u.id, drops.map((d) => d.id)],
    );
    const items: DropActivity[] = drops.map((drop) => ({
      drop,
      purchases: purchases.rows
        .filter((p) => p.drop_id === drop.id)
        .map((p) => ({
          orderId: p.order_id,
          productId: p.product_id,
          title: p.title,
          quantity: p.quantity,
          status: p.status,
          createdAt: p.created_at.toISOString(),
        })),
    }));
    return { items };
  });

  /** What anyone can see of a shared drop link: published, not removed, by a public adult account. */
  app.get('/v1/public/drops/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    reply.header('cache-control', 'no-store');
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.description, d.cover_url, d.starts_at, d.ends_at, d.status, dpr.username, dpr.display_name, dpr.avatar_url,
              (SELECT count(*) FROM drop_items di JOIN products pd ON pd.id = di.product_id WHERE di.drop_id = d.id AND pd.deleted_at IS NULL)::int AS items
       ${DROP_FROM}
       WHERE d.id = $1 AND d.status <> 'draft' AND ${dropVisibleSql('NULL::uuid')} AND ${publicAccountSql('dpr', 'du')}`,
      [id],
    );
    const r = rows[0];
    if (!r) throw notFound('That drop');
    const drop: PublicDropPreview = {
      id: r.id,
      title: r.title,
      excerpt: excerpt(r.description),
      seller: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      coverUrl: r.cover_url,
      startsAt: r.starts_at.toISOString(),
      endsAt: iso(r.ends_at),
      status: r.status,
      itemCount: r.items,
    };
    // Short: the status changes at the start time.
    reply.header('cache-control', 'public, max-age=60');
    return { drop };
  });
}
