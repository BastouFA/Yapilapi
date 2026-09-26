import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { BOOST_DAYS, BOOST_OPTIONS, CURRENCIES } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { startPayment } from '../lib/checkout.ts';
import { DIGITAL_TYPES, openPrivate, putPrivate } from '../lib/private-files.ts';
import { analyzeText } from '../lib/moderation.ts';
import { audit, isEnabled, notify, track } from '../lib/services.ts';
import { isBlockedEitherWay, plusCol, publicUserFrom } from '../lib/users.ts';
import { notBlockedSql } from '../lib/visibility.ts';
import { MAX_UPLOAD_BYTES } from './media.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const PLATFORM_FEE_BPS = 500;
/** How long a download link works. Long enough to start a download on a slow connection, short enough not to be shared around. */
const DOWNLOAD_LINK_MINUTES = 10;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Money on profiles and posts:
 * - the Shop on a profile (products, digital downloads and services),
 * - digital downloads: the seller uploads the file, stored privately; buyers
 *   get a short-lived download link,
 * - services: booked for a time and paid through checkout; the seller then
 *   confirms or declines (declining refunds),
 * - sales for the seller's Studio,
 * - boosting a post: an ad campaign for it, paid through checkout, then
 *   reviewed like any other campaign.
 */
export default async function moneyModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const commerceOn = async () => {
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Payments');
  };

  /** A buyer owns a product when an order for it is paid (not refunded). */
  const OWNED = `EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                         WHERE oi.product_id = pd.id AND o.buyer_id = $2 AND o.status = 'paid')`;

  // ── Shop ──────────────────────────────────────────────────────────────
  /** What a person sells: physical products, digital downloads and services. Tickets are sold from their event or live. */
  app.get('/v1/users/:id/shop', async (req) => {
    const { id } = parse(idParam, req.params);
    const viewer = req.user?.id ?? null;
    const { rows } = await db.query(
      `SELECT pd.id, pd.kind, pd.title, pd.description, pd.price_cents, pd.currency, pd.inventory, pd.created_at,
              f.filename AS file_name, f.mime AS file_mime, f.size_bytes AS file_size, ${OWNED} AS owned
       FROM products pd JOIN users u ON u.id = pd.seller_id LEFT JOIN product_files f ON f.product_id = pd.id
       WHERE pd.seller_id = $1 AND pd.deleted_at IS NULL AND pd.status = 'active' AND u.status = 'active'
         AND pd.kind IN ('product', 'digital', 'service', 'booking') AND ${notBlockedSql('pd.seller_id', '$2')}
         AND ($2::uuid = $1 OR pd.kind <> 'digital' OR f.product_id IS NOT NULL)
       ORDER BY pd.created_at DESC LIMIT 100`,
      [id, viewer],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        description: r.description,
        priceCents: r.price_cents,
        currency: r.currency.trim(),
        inventory: r.inventory,
        file: r.file_name ? { name: r.file_name, mime: r.file_mime, sizeBytes: Number(r.file_size) } : null,
        owned: r.owned === true,
      })),
    };
  });

  // ── Digital downloads ─────────────────────────────────────────────────
  /** The seller uploads (or replaces) the file buyers download. It is stored privately, never as public media. */
  app.put('/v1/products/:id/file', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const product = (await db.query(`SELECT seller_id, kind FROM products WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!product || product.seller_id !== u.id) throw notFound('Product');
    if (product.kind !== 'digital') throw badRequest('Only digital products have a file to download.');
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    if (!file) throw badRequest('Attach a file.');
    const type = DIGITAL_TYPES[file.mimetype];
    if (!type) throw new AppError(415, 'unsupported_media', 'Upload a PDF, ZIP, EPUB, MP3, M4A, MP4, PNG or JPEG file.');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, 'too_large', 'Files can be up to 50 MB.');
    if (!type.magic(buf)) throw new AppError(415, 'unsupported_media', "That file's contents don't match its type.");
    const name = (file.filename || `download.${type.ext}`).replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 200) || `download.${type.ext}`;
    const key = await putPrivate(ctx, buf, type.ext, file.mimetype);
    await db.query(
      `INSERT INTO product_files (product_id, storage_key, filename, mime, size_bytes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_id) DO UPDATE SET storage_key = EXCLUDED.storage_key, filename = EXCLUDED.filename, mime = EXCLUDED.mime,
         size_bytes = EXCLUDED.size_bytes, uploaded_at = now()`,
      [id, key, name, file.mimetype, buf.length],
    );
    await audit(db, { actorId: u.id, action: 'product.file.upload', entityType: 'product', entityId: id, metadata: { size: buf.length } });
    return { file: { name, mime: file.mimetype, sizeBytes: buf.length } };
  });

  /** Digital products you bought, newest first. */
  app.get('/v1/me/purchases', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT DISTINCT ON (pd.id) pd.id, pd.title, pd.kind, f.filename, f.size_bytes, o.id AS order_id, o.created_at AS bought_at,
              pr.user_id AS s_id, pr.username AS s_username, pr.display_name AS s_display_name, pr.avatar_url AS s_avatar_url, pr.mode AS s_mode, ${plusCol('s_')}
       FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products pd ON pd.id = oi.product_id
       JOIN profiles pr ON pr.user_id = pd.seller_id LEFT JOIN product_files f ON f.product_id = pd.id
       WHERE o.buyer_id = $1 AND o.status = 'paid' AND pd.kind = 'digital'
       ORDER BY pd.id, o.created_at DESC`,
      [u.id],
    );
    rows.sort((a, b) => +b.bought_at - +a.bought_at);
    return {
      items: rows.map((r) => ({
        productId: r.id,
        title: r.title,
        orderId: r.order_id,
        boughtAt: r.bought_at,
        file: r.filename ? { name: r.filename, sizeBytes: Number(r.size_bytes) } : null,
        seller: publicUserFrom(r, 's_'),
      })),
    };
  });

  /**
   * A short-lived link to download a digital product: only for people who paid
   * for it (and the seller). The link stops working after a few minutes, and
   * each use checks again that the order is still paid (a refund ends access).
   */
  app.post('/v1/products/:id/download', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { rows } = await db.query(
      `SELECT pd.seller_id, pd.kind, f.product_id IS NOT NULL AS has_file, ${OWNED} AS owned
       FROM products pd LEFT JOIN product_files f ON f.product_id = pd.id WHERE pd.id = $1`,
      [id, u.id],
    );
    const p = rows[0];
    if (!p || p.kind !== 'digital') throw notFound('Product');
    if (!p.owned && p.seller_id !== u.id) throw new AppError(403, 'not_purchased', 'Buy this to download it.');
    if (!p.has_file) throw new AppError(409, 'not_ready', "The seller hasn't added the file yet.");
    const token = randomBytes(32).toString('base64url');
    const { rows: link } = await db.query(
      `INSERT INTO download_links (token_hash, product_id, user_id, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4)) RETURNING expires_at`,
      [sha256(token), id, u.id, DOWNLOAD_LINK_MINUTES],
    );
    // Old links are cleaned up as new ones are made.
    void db.query(`DELETE FROM download_links WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    track(db, u.id, 'download_link');
    reply.header('cache-control', 'no-store');
    return { url: `${ctx.config.PUBLIC_API_URL}/v1/downloads/${token}`, expiresAt: (link[0].expires_at as Date).toISOString() };
  });

  /** The download itself. The token is the permission: it names one product for one person, for a few minutes. */
  app.get('/v1/downloads/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.params);
    const { rows } = await db.query(
      `SELECT f.storage_key, f.filename, f.mime FROM download_links l
       JOIN products pd ON pd.id = l.product_id JOIN product_files f ON f.product_id = pd.id
       WHERE l.token_hash = $1 AND l.expires_at > now()
         AND (pd.seller_id = l.user_id OR EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                                  WHERE oi.product_id = pd.id AND o.buyer_id = l.user_id AND o.status = 'paid'))`,
      [sha256(token)],
    );
    const f = rows[0];
    reply.header('cache-control', 'no-store');
    if (!f) throw new AppError(410, 'link_expired', 'This download link has expired. Get a new one from your purchases.');
    const obj = await openPrivate(ctx, f.storage_key);
    if (!obj) throw notFound('That file');
    reply.type(f.mime);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    if (obj.contentLength !== undefined) reply.header('content-length', obj.contentLength);
    return reply.send(obj.body);
  });

  // ── Services ──────────────────────────────────────────────────────────
  /**
   * Book a service for a time. A paid service goes through checkout first; the
   * seller is asked to confirm once it's paid. Declining refunds it.
   */
  app.post('/v1/products/:id/book', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    await commerceOn();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(
      z.object({
        startsAt: z.string().datetime({ offset: true }),
        note: z.string().trim().max(500).default(''),
        idempotencyKey: z.string().min(8).max(100),
      }),
      req.body,
    );
    if (new Date(input.startsAt) < new Date()) throw badRequest('Choose a time in the future.');
    if (input.note && analyzeText(input.note).risk === 'escalate') throw new AppError(422, 'content_blocked', "That note can't be sent.");
    const product = (
      await db.query(`SELECT id, seller_id, kind, title, price_cents, currency FROM products WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`, [id])
    ).rows[0];
    if (!product || product.kind !== 'service') throw notFound('Service');
    if (product.seller_id === u.id) throw badRequest("You can't book your own service.");
    if (await isBlockedEitherWay(db, u.id, product.seller_id)) throw forbidden();
    const again = await db.query(`SELECT id FROM orders WHERE buyer_id = $1 AND idempotency_key = $2`, [u.id, input.idempotencyKey]);
    if (again.rowCount) throw new AppError(409, 'conflict', 'This booking was already started. Refresh and try again.');
    const currency = product.currency.trim();
    const result = await tx(db, async (c) => {
      if (product.price_cents === 0) {
        const { rows } = await c.query(
          `INSERT INTO bookings (product_id, user_id, party_size, starts_at, note, status) VALUES ($1,$2,1,$3,$4,'requested') RETURNING id, status, starts_at`,
          [id, u.id, input.startsAt, input.note],
        );
        await notify(c, ctx.realtime, {
          userId: product.seller_id,
          category: 'commerce',
          type: 'booking_request',
          actorId: u.id,
          entityType: 'booking',
          entityId: rows[0].id,
          data: { startsAt: input.startsAt },
        });
        return { booking: rows[0], payment: null };
      }
      const fee = Math.round((product.price_cents * PLATFORM_FEE_BPS) / 10_000);
      const order = await c.query(
        `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [u.id, product.price_cents, fee, currency, input.idempotencyKey],
      );
      const orderId = order.rows[0].id as string;
      await c.query(`INSERT INTO order_items (order_id, product_id, quantity, unit_cents) VALUES ($1,$2,1,$3)`, [orderId, id, product.price_cents]);
      const { rows } = await c.query(
        `INSERT INTO bookings (product_id, user_id, party_size, starts_at, note, status, order_id) VALUES ($1,$2,1,$3,$4,'pending_payment',$5)
         RETURNING id, status, starts_at`,
        [id, u.id, input.startsAt, input.note, orderId],
      );
      const pay = await startPayment(c, ctx.paymentProviders, {
        orderId,
        buyerId: u.id,
        amountCents: product.price_cents,
        currency,
        idempotencyKey: input.idempotencyKey,
      });
      return { booking: rows[0], payment: { ...pay, orderId } };
    });
    reply.code(201);
    return {
      booking: { id: result.booking.id, status: result.booking.status, startsAt: result.booking.starts_at },
      payment: result.payment,
      amount: { cents: product.price_cents, currency, title: product.title },
    };
  });

  /** Bookings people made for your services (paid ones only, or free ones), soonest first. */
  app.get('/v1/me/service-bookings', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT bk.id, bk.status, bk.starts_at, bk.note, bk.created_at, pd.id AS product_id, pd.title, o.total_cents, o.currency,
              pr.user_id AS b_id, pr.username AS b_username, pr.display_name AS b_display_name, pr.avatar_url AS b_avatar_url, pr.mode AS b_mode, ${plusCol('b_')}
       FROM bookings bk JOIN products pd ON pd.id = bk.product_id JOIN profiles pr ON pr.user_id = bk.user_id
       LEFT JOIN orders o ON o.id = bk.order_id
       WHERE pd.seller_id = $1 AND bk.status <> 'pending_payment' AND bk.starts_at > now() - interval '30 days'
       ORDER BY (bk.status = 'requested') DESC, bk.starts_at LIMIT 100`,
      [u.id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        startsAt: r.starts_at,
        note: r.note,
        product: { id: r.product_id, title: r.title },
        amountCents: r.total_cents ?? 0,
        currency: r.currency?.trim() ?? null,
        customer: publicUserFrom(r, 'b_'),
      })),
    };
  });

  // ── Sales (Studio) ────────────────────────────────────────────────────
  /** What you sold: totals per currency over a period, and the latest sales. Refunded sales are listed but not counted. */
  app.get('/v1/me/sales', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const [totals, items] = await Promise.all([
      db.query(
        `SELECT o.currency, count(DISTINCT o.id)::int AS orders, sum(oi.quantity * oi.unit_cents)::bigint AS gross
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products pd ON pd.id = oi.product_id
         WHERE pd.seller_id = $1 AND o.status = 'paid' AND o.created_at > now() - make_interval(days => $2)
         GROUP BY o.currency ORDER BY o.currency`,
        [u.id, days],
      ),
      db.query(
        `SELECT o.id AS order_id, o.status, o.created_at, o.currency, oi.quantity, oi.unit_cents, pd.id AS product_id, pd.title, pd.kind,
                pr.user_id AS b_id, pr.username AS b_username, pr.display_name AS b_display_name, pr.avatar_url AS b_avatar_url, pr.mode AS b_mode, ${plusCol('b_')}
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products pd ON pd.id = oi.product_id JOIN profiles pr ON pr.user_id = o.buyer_id
         WHERE pd.seller_id = $1 AND o.status IN ('paid', 'refunded') AND o.created_at > now() - make_interval(days => $2)
         ORDER BY o.created_at DESC LIMIT 100`,
        [u.id, days],
      ),
    ]);
    return {
      days,
      totals: totals.rows.map((r) => {
        const gross = Number(r.gross);
        const fees = Math.round((gross * PLATFORM_FEE_BPS) / 10_000);
        return { currency: r.currency.trim(), orders: r.orders, grossCents: gross, feeCents: fees, netCents: gross - fees };
      }),
      items: items.rows.map((r) => ({
        orderId: r.order_id,
        status: r.status as 'paid' | 'refunded',
        createdAt: r.created_at,
        product: { id: r.product_id, title: r.title, kind: r.kind },
        quantity: r.quantity,
        amountCents: r.quantity * r.unit_cents,
        currency: r.currency.trim(),
        buyer: publicUserFrom(r, 'b_'),
      })),
    };
  });

  // ── Boosts ────────────────────────────────────────────────────────────
  const boostInput = z
    .object({
      budgetCents: z.number().int().positive(),
      currency: z.string().length(3).toUpperCase().pipe(z.enum(CURRENCIES)).default('USD'),
      days: z.number().int(),
      audience: z.discriminatedUnion('type', [
        z.object({
          type: z.literal('country'),
          countries: z
            .array(
              z
                .string()
                .regex(/^[A-Za-z]{2}$/)
                .transform((c) => c.toUpperCase()),
            )
            .min(1)
            .max(5),
        }),
        z.object({ type: z.literal('interests'), topics: z.array(z.string().trim().toLowerCase().min(1).max(40)).min(1).max(10) }),
      ]),
      idempotencyKey: z.string().min(8).max(100),
    })
    .superRefine((v, c) => {
      const opts = BOOST_OPTIONS[v.currency];
      if (!opts) c.addIssue({ code: 'custom', message: "Boosts aren't available in this currency.", path: ['currency'] });
      else if (!opts.budgets.includes(v.budgetCents)) c.addIssue({ code: 'custom', message: 'Choose one of the budgets.', path: ['budgetCents'] });
      if (!(BOOST_DAYS as readonly number[]).includes(v.days)) c.addIssue({ code: 'custom', message: 'Choose one of the durations.', path: ['days'] });
    });

  /**
   * Boost one of your public posts: an ad campaign for it with a budget, a
   * number of days and an audience (countries or interests). It's paid through
   * checkout; once paid it goes to ad review, and runs when approved.
   */
  app.post('/v1/posts/:id/boost', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!(await isEnabled(db, 'ADS'))) throw featureDisabled('Sponsored posts');
    await commerceOn();
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(boostInput, req.body);
    const post = (await db.query(`SELECT author_id, body, visibility, moderation_status, deleted_at FROM posts WHERE id = $1`, [id])).rows[0];
    if (!post || post.deleted_at) throw notFound('Post');
    if (post.author_id !== u.id) throw forbidden('You can only boost your own posts.');
    if (post.visibility !== 'public') throw badRequest('Only public posts can be boosted.');
    if (post.moderation_status !== 'normal') throw new AppError(422, 'content_blocked', "This post can't be boosted.");
    const opts = BOOST_OPTIONS[input.currency]!;
    const result = await tx(db, async (c) => {
      const running = await c.query(
        `SELECT id, status FROM ad_campaigns WHERE post_id = $1 AND advertiser_id = $2 AND status IN ('draft', 'pending_review', 'active', 'paused') FOR UPDATE`,
        [id, u.id],
      );
      if (running.rows.some((r) => r.status !== 'draft')) throw new AppError(409, 'conflict', 'This post already has a boost. Wait for it to end first.');
      // An earlier boost that was never paid is replaced.
      for (const r of running.rows) await c.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id = $1`, [r.id]);
      const again = await c.query(`SELECT id FROM orders WHERE buyer_id = $1 AND idempotency_key = $2`, [u.id, input.idempotencyKey]);
      if (again.rowCount) throw new AppError(409, 'conflict', 'This boost was already started. Refresh and try again.');
      const excerpt = (post.body as string).replace(/\s+/g, ' ').trim().slice(0, 60);
      const { rows } = await c.query(
        `INSERT INTO ad_campaigns (advertiser_id, post_id, name, topics, countries, cpm_cents, currency, boost_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          u.id,
          id,
          excerpt ? `Boost: ${excerpt}` : 'Boost',
          input.audience.type === 'interests' ? input.audience.topics : [],
          input.audience.type === 'country' ? input.audience.countries : [],
          opts.cpmCents,
          input.currency,
          input.days,
        ],
      );
      const campaignId = rows[0].id as string;
      const order = await c.query(
        `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key, purpose, campaign_id)
         VALUES ($1,$2,$2,$3,$4,'ad_budget',$5) RETURNING id`,
        [u.id, input.budgetCents, input.currency, input.idempotencyKey, campaignId],
      );
      const orderId = order.rows[0].id as string;
      const pay = await startPayment(c, ctx.paymentProviders, {
        orderId,
        buyerId: u.id,
        amountCents: input.budgetCents,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      });
      await audit(c, { actorId: u.id, action: 'ads.boost.create', entityType: 'ad_campaign', entityId: campaignId, metadata: { days: input.days } });
      return { campaignId, payment: { ...pay, orderId } };
    });
    track(db, u.id, 'boost_started', { currency: input.currency, days: input.days, audience: input.audience.type });
    reply.code(201);
    return {
      boost: {
        campaignId: result.campaignId,
        budgetCents: input.budgetCents,
        currency: input.currency,
        days: input.days,
        // About how many times it will be shown for this budget.
        estimatedImpressions: Math.floor((input.budgetCents / opts.cpmCents) * 1000),
      },
      payment: result.payment,
    };
  });

  /** Every boost of one of your posts, with its results. */
  app.get('/v1/posts/:id/boosts', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const own = await db.query(`SELECT 1 FROM posts WHERE id = $1 AND author_id = $2`, [id, u.id]);
    if (!own.rowCount) throw notFound('Post');
    const { rows } = await db.query(
      `SELECT id, status, topics, countries, boost_days, currency, impressions, clicks, spent_millicents, budget_millicents, refunded_millicents,
              review_note, approved_at, ends_at, created_at
       FROM ad_campaigns WHERE post_id = $1 AND advertiser_id = $2 ORDER BY created_at DESC LIMIT 20`,
      [id, u.id],
    );
    return { items: rows.map(boostDto) };
  });

  /** Your boosts across all posts, for Studio. */
  app.get('/v1/me/boosts', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT c.id, c.post_id, c.status, c.topics, c.countries, c.boost_days, c.currency, c.impressions, c.clicks, c.spent_millicents, c.budget_millicents,
              c.refunded_millicents, c.review_note, c.approved_at, c.ends_at, c.created_at, left(p.body, 120) AS excerpt
       FROM ad_campaigns c JOIN posts p ON p.id = c.post_id
       WHERE c.advertiser_id = $1 AND c.boost_days IS NOT NULL AND NOT (c.status = 'ended' AND c.budget_millicents = 0 AND c.impressions = 0)
       ORDER BY c.created_at DESC LIMIT 50`,
      [u.id],
    );
    return { items: rows.map((r) => ({ ...boostDto(r), postId: r.post_id, excerpt: r.excerpt })) };
  });
}

function boostDto(r: Record<string, any>) {
  const impressions = Number(r.impressions);
  const clicks = Number(r.clicks);
  return {
    campaignId: r.id as string,
    status: r.status as 'draft' | 'pending_review' | 'active' | 'paused' | 'ended' | 'rejected',
    audience: r.countries?.length
      ? { type: 'country' as const, countries: r.countries as string[] }
      : { type: 'interests' as const, topics: r.topics as string[] },
    days: r.boost_days as number | null,
    currency: String(r.currency).trim(),
    budgetCents: Math.floor(Number(r.budget_millicents) / 1000),
    spentCents: Math.ceil(Number(r.spent_millicents) / 1000),
    refundedCents: Math.floor(Number(r.refunded_millicents ?? 0) / 1000),
    impressions,
    clicks,
    ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : 0,
    reviewNote: r.review_note ?? null,
    approvedAt: r.approved_at ?? null,
    endsAt: r.ends_at ?? null,
    createdAt: r.created_at,
  };
}
