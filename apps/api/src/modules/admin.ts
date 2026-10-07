import type { FastifyInstance } from 'fastify';
import { ADMIN_CONTENT_KINDS, ADMIN_PERIODS, ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX, type AdminContentKind } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { audit, securityEvent } from '../lib/services.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
/** `days=7|30|90`, as the query sends it. */
const periodQuery = z.object({
  days: z.coerce
    .number()
    .refine((n) => (ADMIN_PERIODS as readonly number[]).includes(n), 'Choose 7, 30 or 90 days.')
    .default(30),
});

/** A whole amount of money from Postgres (sums come back as text): a number, and the currency without padding. */
const money = (r: { currency: string; n: number | string; cents: number | string | null }) => ({
  currency: String(r.currency).trim(),
  count: Number(r.n),
  cents: Number(r.cents ?? 0),
});

/** The day (UTC) `n` days before `day`, as YYYY-MM-DD. */
function dayBefore(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** How much a total moved from the period before, in whole percent; null when there was nothing before to compare with. */
const changeFrom = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);

/** A link from an announcement: a web address on https, or a path in the app ("/settings/privacy"), never "//elsewhere". */
export function announcementLinkOk(v: string): boolean {
  if (/^\/(?![/\\])/.test(v)) return !/\s/.test(v);
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

const announcementDto = (r: Record<string, any>) => ({
  id: r.id as string,
  title: r.title as string,
  body: r.body as string,
  linkUrl: (r.link_url as string | null) ?? null,
  startsAt: r.starts_at,
  endsAt: r.ends_at ?? null,
  createdAt: r.created_at,
});

/**
 * The admin console's overview, health, people, content, money and announcements. Everything here
 * is for admins (moderation itself is in safety.ts); every change is in the audit log.
 */
export default async function adminModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const admin = { preHandler: requireRole('admin') };

  // ── Overview: trends ──────────────────────────────────────────────────
  /**
   * Counts per day (UTC) over the last 7, 30 or 90 days, today included, with the totals and how they
   * moved from the period before. Active people are those with any recorded activity that day
   * (analytics_events) or a session seen that day; their total counts each person once.
   */
  app.get('/v1/admin/analytics/series', admin, async (req) => {
    const { days } = parse(periodQuery, req.query);
    const today = new Date().toISOString().slice(0, 10);
    const from = dayBefore(today, days - 1);
    const prevFrom = dayBefore(from, days);
    const since = `${prevFrom}T00:00:00Z`;
    const perDay = (sql: string) => db.query<{ d: string; n: number }>(sql, [since]);
    const day = (col: string) => `to_char((${col} AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`;
    const counted = (table: string, where = 'true', col = 'created_at') =>
      perDay(`SELECT ${day(col)} AS d, count(*)::int AS n FROM ${table} WHERE ${col} >= $1 AND ${where} GROUP BY 1`);
    const [signups, active, posts, reels, comments, messages, reports, paidOrders, activeTotals] = await Promise.all([
      counted('users', 'NOT is_dev_data'),
      perDay(
        `SELECT d, count(DISTINCT user_id)::int AS n FROM (
           SELECT user_id, ${day('created_at')} AS d FROM analytics_events WHERE created_at >= $1 AND user_id IS NOT NULL
           UNION SELECT user_id, ${day('last_seen_at')} FROM sessions WHERE last_seen_at >= $1) x GROUP BY d`,
      ),
      counted('posts', `format = 'post' AND status = 'published'`),
      counted('posts', `format = 'reel' AND status = 'published'`),
      counted('comments'),
      counted('messages'),
      counted('reports'),
      counted('orders', 'paid_at IS NOT NULL', 'paid_at'),
      db.query<{ now: number; before: number }>(
        `SELECT count(DISTINCT user_id) FILTER (WHERE at >= $2)::int AS now, count(DISTINCT user_id) FILTER (WHERE at < $2)::int AS before FROM (
           SELECT user_id, created_at AS at FROM analytics_events WHERE created_at >= $1 AND user_id IS NOT NULL
           UNION ALL SELECT user_id, last_seen_at FROM sessions WHERE last_seen_at >= $1) x`,
        [since, `${from}T00:00:00Z`],
      ),
    ]);
    const metrics = { signups, active, posts, reels, comments, messages, reports, paidOrders };
    type Metric = keyof typeof metrics;
    const byDay = Object.fromEntries(Object.entries(metrics).map(([k, r]) => [k, new Map(r.rows.map((x) => [x.d, Number(x.n)]))])) as Record<
      Metric,
      Map<string, number>
    >;
    const series = Array.from({ length: days }, (_, i) => {
      const d = dayBefore(today, days - 1 - i);
      return { day: d, ...(Object.fromEntries(Object.keys(metrics).map((k) => [k, byDay[k as Metric].get(d) ?? 0])) as Record<Metric, number>) };
    });
    const sum = (k: Metric, start: string, end: string) => [...byDay[k]].reduce((n, [d, v]) => (d >= start && d <= end ? n + v : n), 0);
    const totals = {} as Record<Metric, number>;
    const previous = {} as Record<Metric, number>;
    const change = {} as Record<Metric, number | null>;
    for (const k of Object.keys(metrics) as Metric[]) {
      totals[k] = k === 'active' ? activeTotals.rows[0]!.now : sum(k, from, today);
      previous[k] = k === 'active' ? activeTotals.rows[0]!.before : sum(k, prevFrom, dayBefore(from, 1));
      change[k] = changeFrom(totals[k], previous[k]);
    }
    return { days, from, to: today, series, totals, previous, change };
  });

  // ── System health ─────────────────────────────────────────────────────
  /** What the team needs to see that the service is well: the database, Redis, the job queue, webhooks, and which build is running. */
  app.get('/v1/admin/system', admin, async () => {
    const started = performance.now();
    let database: { ok: boolean; latencyMs: number | null } = { ok: false, latencyMs: null };
    try {
      await db.query('SELECT 1');
      database = { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch {
      // Shown as down; the rest of this page can't be read either, so the request fails below.
    }
    let redis: 'ok' | 'degraded' | 'not_configured' = 'not_configured';
    if (ctx.redis) {
      const ping = ctx.redis.ping().then(
        () => 'ok' as const,
        () => 'degraded' as const,
      );
      const late = new Promise<'degraded'>((resolve) => setTimeout(() => resolve('degraded'), 1000).unref());
      redis = await Promise.race([ping, late]);
    }
    const [jobs, failed, webhooks] = await Promise.all([
      db.query(
        `SELECT count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS due,
                count(*) FILTER (WHERE status = 'queued' AND run_at > now())::int AS scheduled,
                count(*) FILTER (WHERE status = 'running')::int AS running,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'failed' AND coalesce(finished_at, created_at) > now() - interval '1 day')::int AS failed_24h,
                extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now()))::int AS oldest_due_seconds
         FROM jobs WHERE status IN ('queued', 'running', 'failed')`,
      ),
      db.query(
        `SELECT id::text AS id, kind, attempts, left(coalesce(last_error, ''), 2000) AS error, created_at, finished_at
         FROM jobs WHERE status = 'failed' ORDER BY coalesce(finished_at, created_at) DESC, id DESC LIMIT 20`,
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM webhook_deliveries WHERE status IN ('pending', 'failed')`,
      ),
    ]);
    const j = jobs.rows[0];
    return {
      database,
      redis,
      jobs: {
        pending: j.due + j.scheduled,
        due: j.due,
        scheduled: j.scheduled,
        running: j.running,
        failed: j.failed,
        failed24h: j.failed_24h,
        oldestPendingSeconds: j.oldest_due_seconds ?? null,
        recentFailures: failed.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          attempts: r.attempts,
          error: r.error,
          createdAt: r.created_at,
          finishedAt: r.finished_at,
        })),
      },
      webhooks: { failed: webhooks.rows[0].failed, pending: webhooks.rows[0].pending },
      app: {
        commit: ctx.config.RENDER_GIT_COMMIT || null,
        environment: ctx.config.APP_ENV,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        ai: ctx.ai.providerName,
        email: ctx.config.EMAIL_TRANSPORT,
        payments: ctx.config.PAYMENTS_PROVIDER,
        storage: ctx.config.STORAGE_DRIVER,
      },
      serverTime: new Date().toISOString(),
    };
  });

  // ── One account ───────────────────────────────────────────────────────
  /**
   * Everything about one account the team may need: who they are, how they sign in (sessions and
   * devices, never their tokens), what they post (removed posts included), cases and reports, money
   * and risk.
   */
  app.get('/v1/admin/users/:id', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const u = (
      await db.query(
        `SELECT u.id, u.email, u.email_verified_at, u.phone_e164, u.phone_verified_at, u.role, u.status, u.created_at, u.deleted_at, u.restricted_at,
                u.is_dev_data, u.mfa_enabled, (u.birth_date > current_date - interval '18 years') AS minor,
                pr.username, pr.display_name, pr.avatar_url, pr.bio, pr.is_private, pr.mode, pr.country, pr.locale,
                (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at
         FROM users u JOIN profiles pr ON pr.user_id = u.id WHERE u.id = $1`,
        [id],
      )
    ).rows[0];
    if (!u) throw notFound('User');
    const [counts, posts, cases, sessions, devices, events, bought, sold, payouts, risk, actions] = await Promise.all([
      db.query(
        `SELECT (SELECT count(*) FROM posts WHERE author_id = $1 AND format = 'post' AND status = 'published' AND deleted_at IS NULL)::int AS posts,
                (SELECT count(*) FROM posts WHERE author_id = $1 AND format = 'reel' AND status = 'published' AND deleted_at IS NULL)::int AS reels,
                (SELECT count(*) FROM follows WHERE followee_id = $1)::int AS followers,
                (SELECT count(*) FROM follows WHERE follower_id = $1)::int AS following,
                (SELECT count(*) FROM friendships WHERE user_a = $1 OR user_b = $1)::int AS friends,
                (SELECT count(*) FROM reports WHERE reporter_id = $1)::int AS reports_made,
                (SELECT count(*) FROM reports r WHERE EXISTS (SELECT 1 FROM moderation_cases mc
                   WHERE mc.target_type = r.target_type AND mc.target_id = r.target_id AND mc.subject_user_id = $1))::int AS reports_against`,
        [id],
      ),
      db.query(
        `SELECT id, format, kind, left(body, 280) AS body, visibility, moderation_status, deleted_at, created_at FROM posts
         WHERE author_id = $1 AND status = 'published' ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      db.query(
        `SELECT id, target_type, target_id, source, status, decision, note, created_at, decided_at FROM moderation_cases
         WHERE subject_user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id],
      ),
      db.query(
        `SELECT s.id, s.user_agent, host(s.ip) AS ip, s.created_at, s.last_seen_at, s.expires_at, d.name AS device_name, d.platform
         FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
         WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_seen_at DESC LIMIT 50`,
        [id],
      ),
      db.query(`SELECT id, name, platform, created_at, last_seen_at FROM devices WHERE user_id = $1 ORDER BY last_seen_at DESC NULLS LAST LIMIT 50`, [id]),
      db.query(
        `SELECT id::text AS id, type, host(ip) AS ip, user_agent, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      db.query(
        `SELECT currency, count(*) AS n, sum(total_cents) AS cents FROM orders
         WHERE buyer_id = $1 AND status IN ('paid', 'partially_refunded', 'refunded') GROUP BY currency ORDER BY currency`,
        [id],
      ),
      db.query(
        `SELECT currency, count(*) AS n, sum(total_cents) AS cents FROM orders o
         WHERE status IN ('paid', 'partially_refunded', 'refunded')
           AND (o.payee_id = $1 OR EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND p.seller_id = $1))
         GROUP BY currency ORDER BY currency`,
        [id],
      ),
      db.query(`SELECT status, currency, count(*) AS n, sum(amount_cents) AS cents FROM payouts WHERE user_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [id]),
      db.query(
        `SELECT coalesce(sum(weight) FILTER (WHERE status = 'open'), 0)::int AS score, count(*) FILTER (WHERE status = 'open')::int AS open
         FROM risk_signals WHERE user_id = $1`,
        [id],
      ),
      db.query(
        `SELECT l.id::text AS id, l.action, pr.username AS actor_username, l.metadata, l.created_at
         FROM audit_logs l LEFT JOIN profiles pr ON pr.user_id = l.actor_id
         WHERE l.entity_type = 'user' AND l.entity_id = $1 ORDER BY l.id DESC LIMIT 20`,
        [id],
      ),
    ]);
    const c = counts.rows[0];
    return {
      user: {
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        bio: u.bio ?? '',
        isPrivate: u.is_private,
        profileType: u.mode,
        country: u.country,
        locale: u.locale,
        email: u.email,
        emailConfirmed: !!u.email_verified_at,
        phone: u.phone_e164,
        phoneConfirmed: !!u.phone_verified_at,
        twoStep: u.mfa_enabled,
        minor: !!u.minor,
        role: u.role,
        status: u.status,
        deleted: !!u.deleted_at,
        devData: u.is_dev_data,
        createdAt: u.created_at,
        lastActiveAt: u.last_active_at,
      },
      self: id === me(req).id,
      counts: {
        posts: c.posts,
        reels: c.reels,
        followers: c.followers,
        following: c.following,
        friends: c.friends,
        reportsMade: c.reports_made,
        reportsAgainst: c.reports_against,
      },
      posts: posts.rows.map((p) => ({
        id: p.id,
        format: p.format,
        kind: p.kind,
        body: p.body ?? '',
        visibility: p.visibility,
        moderationStatus: p.moderation_status,
        deleted: !!p.deleted_at,
        createdAt: p.created_at,
      })),
      cases: cases.rows.map((k) => ({
        id: k.id,
        targetType: k.target_type,
        targetId: k.target_id,
        source: k.source,
        status: k.status,
        decision: k.decision,
        note: k.note,
        createdAt: k.created_at,
        decidedAt: k.decided_at,
      })),
      sessions: sessions.rows.map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        device: s.device_name,
        platform: s.platform,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        expiresAt: s.expires_at,
      })),
      devices: devices.rows.map((d) => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.created_at, lastSeenAt: d.last_seen_at })),
      securityEvents: events.rows.map((e) => ({ id: e.id, type: e.type, ip: e.ip, userAgent: e.user_agent, createdAt: e.created_at })),
      money: {
        bought: bought.rows.map(money),
        sold: sold.rows.map(money),
        payouts: payouts.rows.map((p) => ({ status: p.status, ...money(p) })),
      },
      risk: { score: risk.rows[0].score, openSignals: risk.rows[0].open, restrictedAt: u.restricted_at },
      adminActions: actions.rows.map((a) => ({ id: a.id, action: a.action, actor: a.actor_username, metadata: a.metadata, createdAt: a.created_at })),
    };
  });

  /** Sign the account out of every device (it can sign in again). Not your own: Settings does that for you. */
  app.post('/v1/admin/users/:id/sign-out-everywhere', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    if (id === me(req).id) throw badRequest("You can't do this to your own account here.");
    const exists = await db.query(`SELECT 1 FROM users WHERE id = $1`, [id]);
    if (!exists.rowCount) throw notFound('User');
    const r = await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(db, {
      actorId: me(req).id,
      action: 'user.sign_out_everywhere',
      entityType: 'user',
      entityId: id,
      ip: req.ip,
      requestId: req.id,
      metadata: { sessions: r.rowCount ?? 0 },
    });
    return { revoked: r.rowCount ?? 0 };
  });

  /** Mark the account's email address as confirmed (someone who can't receive the link, confirmed another way). */
  app.post('/v1/admin/users/:id/confirm-email', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    if (id === me(req).id) throw badRequest("You can't do this to your own account here.");
    const r = await db.query<{ email: string; before: Date | null }>(
      `UPDATE users u SET email_verified_at = coalesce(u.email_verified_at, now()) FROM users old
       WHERE u.id = $1 AND old.id = u.id AND u.deleted_at IS NULL RETURNING u.email, old.email_verified_at AS before`,
      [id],
    );
    if (!r.rowCount) throw notFound('User');
    if (!r.rows[0]!.before) {
      // In their own security log too ("Email confirmed").
      await securityEvent(db, id, 'email_verified', req.ip, undefined, { byTeam: true });
      await audit(db, {
        actorId: me(req).id,
        action: 'user.confirm_email',
        entityType: 'user',
        entityId: id,
        ip: req.ip,
        requestId: req.id,
        metadata: { email: r.rows[0]!.email },
      });
    }
    return { emailConfirmed: true };
  });

  // ── Content browser ───────────────────────────────────────────────────
  /**
   * Posts, reels, comments, Market listings, communities and events, newest first, 50 at a time:
   * `q` matches the text or the author's username, `status` picks what's up, what's removed, or both.
   * Removing and restoring are in safety.ts, with moderation's own steps.
   */
  app.get('/v1/admin/content', admin, async (req) => {
    const q = parse(
      z.object({
        kind: z.enum(ADMIN_CONTENT_KINDS).default('post'),
        q: z.string().trim().max(100).default(''),
        status: z.enum(['all', 'visible', 'removed']).default('all'),
        cursor: z.string().max(200).optional(),
      }),
      req.query,
    );
    const c = decodeCursor<{ t: string; id: string }>(q.cursor);
    // Each kind: its table, who it belongs to, its text, and whether it can be held (moderation_status).
    const KINDS: Record<AdminContentKind, { from: string; owner: string; text: string; held: boolean; extra: string }> = {
      post: { from: `posts x`, owner: 'x.author_id', text: 'x.body', held: true, extra: `x.format = 'post' AND x.status = 'published'` },
      reel: { from: `posts x`, owner: 'x.author_id', text: 'x.body', held: true, extra: `x.format = 'reel' AND x.status = 'published'` },
      comment: { from: `comments x`, owner: 'x.author_id', text: 'x.body', held: true, extra: 'true' },
      listing: { from: `market_listings x`, owner: 'x.seller_id', text: `concat_ws(E'\\n', x.title, nullif(x.description, ''))`, held: true, extra: 'true' },
      community: { from: `communities x`, owner: 'x.owner_id', text: `concat_ws(E'\\n', x.name, nullif(x.description, ''))`, held: false, extra: 'true' },
      event: { from: `events x`, owner: 'x.host_id', text: `concat_ws(E'\\n', x.title, nullif(x.description, ''))`, held: false, extra: 'true' },
    };
    const k = KINDS[q.kind];
    const args: unknown[] = [];
    const arg = (v: unknown) => `$${args.push(v)}`;
    const removed = k.held ? `x.moderation_status = 'removed'` : 'x.deleted_at IS NOT NULL';
    const where = [k.extra];
    if (q.status === 'removed') where.push(removed);
    if (q.status === 'visible') where.push(`NOT (${removed}) AND x.deleted_at IS NULL`);
    if (q.q) {
      const term = `%${q.q.replace(/^@/, '').replace(/[\\%_]/g, '\\$&')}%`;
      where.push(`(${k.text} ILIKE ${arg(term)} OR pr.username ILIKE ${arg(term)})`);
    }
    if (c) where.push(`(x.created_at, x.id) < (${arg(c.t)}::timestamptz, ${arg(c.id)}::uuid)`);
    const limit = 50;
    const { rows } = await db.query(
      `SELECT x.id, left(${k.text}, 400) AS text, x.created_at, x.created_at::text AS cursor_t, x.deleted_at,
              ${k.held ? 'x.moderation_status' : 'NULL'} AS moderation_status,
              ${q.kind === 'comment' ? 'x.post_id' : 'NULL::uuid'} AS post_id,
              ${q.kind === 'community' ? 'x.slug' : 'NULL'} AS slug,
              pr.user_id AS author_id, pr.username, pr.display_name
       FROM ${k.from} LEFT JOIN profiles pr ON pr.user_id = ${k.owner}
       WHERE ${where.join(' AND ')} ORDER BY x.created_at DESC, x.id DESC LIMIT ${limit + 1}`,
      args,
    );
    const page = rows.slice(0, limit);
    const href = (r: Record<string, any>): string | null => {
      switch (q.kind) {
        case 'post':
          return `/p/${r.id}`;
        case 'reel':
          return `/reels/${r.id}`;
        case 'comment':
          return r.post_id ? `/p/${r.post_id}` : null;
        case 'listing':
          return `/market/${r.id}`;
        case 'community':
          return r.slug ? `/c/${r.slug}` : null;
        case 'event':
          return `/events/${r.id}`;
      }
    };
    const last = page[page.length - 1];
    return {
      items: page.map((r) => {
        const isRemoved = k.held ? r.moderation_status === 'removed' : !!r.deleted_at;
        return {
          kind: q.kind,
          id: r.id,
          text: r.text ?? '',
          author: r.author_id ? { id: r.author_id, username: r.username, displayName: r.display_name } : null,
          createdAt: r.created_at,
          moderationStatus: r.moderation_status ?? (r.deleted_at ? 'removed' : 'normal'),
          removed: isRemoved,
          // Deleted by its author (not by moderation): nothing to restore.
          deletedByOwner: !!r.deleted_at && !isRemoved,
          href: href(r),
        };
      }),
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
    };
  });

  // ── Announcements ─────────────────────────────────────────────────────
  const announcementInput = z.object({
    title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
    body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX),
    linkUrl: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) => v || null)
      .refine((v) => v === null || announcementLinkOk(v), 'Use a web address that starts with https://, or a path in the app that starts with /.'),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).nullish(),
  });

  app.post('/v1/admin/announcements', admin, async (req, reply) => {
    const input = parse(announcementInput, req.body);
    const starts = input.startsAt ? new Date(input.startsAt) : new Date();
    if (input.endsAt && new Date(input.endsAt) <= starts) throw badRequest('The end must be after the start.');
    const { rows } = await db.query(
      `INSERT INTO announcements (title, body, link_url, created_by, starts_at, ends_at) VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6) RETURNING *`,
      [input.title, input.body, input.linkUrl, me(req).id, input.startsAt ?? null, input.endsAt ?? null],
    );
    await audit(db, {
      actorId: me(req).id,
      action: 'announcement.create',
      entityType: 'announcement',
      entityId: rows[0].id,
      ip: req.ip,
      requestId: req.id,
      metadata: { title: input.title, linkUrl: input.linkUrl, startsAt: rows[0].starts_at, endsAt: rows[0].ends_at },
    });
    reply.code(201);
    return { announcement: announcementDto(rows[0]) };
  });

  app.get('/v1/admin/announcements', admin, async () => {
    const { rows } = await db.query(
      `SELECT a.*, pr.username AS created_by_username, (SELECT count(*) FROM announcement_dismissals d WHERE d.announcement_id = a.id)::int AS dismissals,
              (a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())) AS active
       FROM announcements a LEFT JOIN profiles pr ON pr.user_id = a.created_by ORDER BY a.created_at DESC LIMIT 100`,
    );
    return {
      items: rows.map((r) => ({
        ...announcementDto(r),
        createdBy: r.created_by_username ?? null,
        dismissals: r.dismissals,
        state: r.active ? 'active' : new Date(r.starts_at) > new Date() ? 'scheduled' : 'ended',
      })),
    };
  });

  /** End an announcement now: it leaves everyone's app on their next load. One that hadn't started never shows. */
  app.post('/v1/admin/announcements/:id/end', admin, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `UPDATE announcements SET starts_at = least(starts_at, now()), ends_at = now() WHERE id = $1 AND (ends_at IS NULL OR ends_at > now()) RETURNING *`,
      [id],
    );
    if (!r.rowCount) throw notFound('Announcement');
    await audit(db, { actorId: me(req).id, action: 'announcement.end', entityType: 'announcement', entityId: id, ip: req.ip, requestId: req.id });
    return { announcement: announcementDto(r.rows[0]) };
  });

  /** The newest announcement that is showing now and that you haven't closed (null when there is none). */
  app.get('/v1/announcements/current', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT a.* FROM announcements a
       WHERE a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
         AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = $1)
       ORDER BY a.starts_at DESC, a.created_at DESC LIMIT 1`,
      [me(req).id],
    );
    return { announcement: rows[0] ? announcementDto(rows[0]) : null };
  });

  app.post('/v1/announcements/:id/dismiss', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await db.query(
      `INSERT INTO announcement_dismissals (announcement_id, user_id) SELECT id, $2 FROM announcements WHERE id = $1 AND starts_at <= now()
       ON CONFLICT DO NOTHING RETURNING announcement_id`,
      [id, me(req).id],
    );
    if (!r.rowCount) {
      const known = await db.query(`SELECT 1 FROM announcement_dismissals WHERE announcement_id = $1 AND user_id = $2`, [id, me(req).id]);
      if (!known.rowCount) throw notFound('Announcement');
    }
    return { dismissed: true };
  });

  // ── Payments ──────────────────────────────────────────────────────────
  /**
   * Money in over the last 7, 30 or 90 days: orders by status (count and gross, per currency),
   * payments by provider, refunds, and the 50 newest orders with who bought and who was paid.
   */
  app.get('/v1/admin/payments', admin, async (req) => {
    const { days } = parse(periodQuery, req.query);
    const since = `now() - make_interval(days => $1::int)`;
    const [byStatus, byProvider, refunds, recent] = await Promise.all([
      db.query(`SELECT status, currency, count(*) AS n, sum(total_cents) AS cents FROM orders WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY 1, 2`, [
        days,
      ]),
      db.query(
        `SELECT provider, status, currency, count(*) AS n, sum(amount_cents) AS cents FROM payments WHERE created_at >= ${since} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        [days],
      ),
      db.query(
        `SELECT r.status, pay.currency, count(*) AS n, sum(r.amount_cents) AS cents FROM refunds r JOIN payments pay ON pay.id = r.payment_id
         WHERE r.created_at >= ${since} GROUP BY 1, 2 ORDER BY 1, 2`,
        [days],
      ),
      db.query(
        `SELECT o.id, o.status, o.purpose, o.total_cents, o.platform_fee_cents, o.currency, o.created_at, o.paid_at,
                o.buyer_id, bp.username AS buyer, sp.user_id AS seller_id, sp.username AS seller,
                (SELECT pay.provider FROM payments pay WHERE pay.order_id = o.id ORDER BY pay.created_at DESC LIMIT 1) AS provider
         FROM orders o LEFT JOIN profiles bp ON bp.user_id = o.buyer_id
         LEFT JOIN profiles sp ON sp.user_id = coalesce(o.payee_id,
           (SELECT p.seller_id FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id LIMIT 1))
         WHERE o.created_at >= ${since} ORDER BY o.created_at DESC LIMIT 50`,
        [days],
      ),
    ]);
    return {
      days,
      byStatus: byStatus.rows.map((r) => ({ status: r.status, ...money(r) })),
      byProvider: byProvider.rows.map((r) => ({ provider: r.provider, status: r.status, ...money(r) })),
      refunds: refunds.rows.map((r) => ({ status: r.status, ...money(r) })),
      recent: recent.rows.map((r) => ({
        id: r.id,
        status: r.status,
        purpose: r.purpose,
        amountCents: r.total_cents,
        feeCents: r.platform_fee_cents,
        currency: String(r.currency).trim(),
        provider: r.provider,
        buyer: r.buyer_id ? { id: r.buyer_id, username: r.buyer } : null,
        seller: r.seller_id ? { id: r.seller_id, username: r.seller } : null,
        createdAt: r.created_at,
        paidAt: r.paid_at,
      })),
    };
  });
}
