import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ACCOUNTS_COOKIE, hashToken, SESSION_COOKIE } from '@yapilapi/auth';
import { clientPlatformFrom, MAX_DEVICE_ACCOUNTS, type BrowserAccount, type Me } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { unreadNotifications } from './notifications.ts';

/**
 * More than one account in one browser: the website's account switcher (the phone keeps its own
 * list, packages/shared/src/accounts.ts). The account in use is the session cookie, as always. A
 * second httpOnly cookie, ACCOUNTS_COOKIE, holds the session tokens of every account signed in on
 * this browser, in the order they were added (the one in use among them), so the API can switch
 * between them: the page never sees a token.
 *
 * Nothing in the cookie is trusted. Each token is looked up, and only live sessions count (not
 * revoked, not expired, of an active account); dead ones leave the cookie the next time it is
 * read. So a password change, "Log out of all devices", a session ended from Settings or a
 * deleted account leaves nothing to switch to. Switching only reaches sessions this browser's own
 * cookie holds.
 *
 * A session signed in with "Stay signed in" off keeps ending with the browser: while the cookie
 * holds one, the cookie itself ends with the browser too.
 */

/** A session token as newToken makes them (32 random bytes, base64url). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A live session signed in on this browser. */
interface Signed {
  token: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  /** Signed in with "Stay signed in" on: its cookie outlives the browser. */
  remembered: boolean;
}

const tokensIn = (raw: string | undefined) => [...new Set((raw ?? '').split('.').filter((t) => TOKEN.test(t)))].slice(0, MAX_DEVICE_ACCOUNTS * 2);

/** Requests from the website (the phone app says it is the phone, and keeps its accounts itself). */
export const fromWeb = (req: FastifyRequest) => clientPlatformFrom(req.headers['x-client-platform']) === 'web';

export function browserAccounts(app: FastifyInstance, ctx: AppContext, loadMe: (ctx: AppContext, userId: string) => Promise<Me>) {
  const ttlMs = ctx.config.SESSION_TTL_DAYS * 86400_000;
  const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  /** The session cookie's attributes; `remember: false` ends it with the browser. */
  const cookieOptions = (remember: boolean) => ({
    httpOnly: true,
    secure: ctx.config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    ...(remember ? { maxAge: Math.floor(ttlMs / 1000) } : {}),
  });

  /**
   * This browser's live accounts, in the order they were added, one per account, and the one in
   * use. `stale`: the cookie holds something else (a session that ended, a duplicate), so it should
   * be written again.
   */
  async function read(req: FastifyRequest): Promise<{ list: Signed[]; active: Signed | null; stale: boolean }> {
    const stored = tokensIn(req.cookies?.[ACCOUNTS_COOKIE]);
    const raw = req.cookies?.[SESSION_COOKIE];
    const activeToken = raw && TOKEN.test(raw) ? raw : null;
    const tokens = activeToken && !stored.includes(activeToken) ? [...stored, activeToken] : stored;
    if (!tokens.length) return { list: [], active: null, stale: !!req.cookies?.[ACCOUNTS_COOKIE] };
    const { rows } = await ctx.db.query<{
      token_hash: string;
      user_id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      remembered: boolean;
    }>(
      `SELECT s.token_hash, s.user_id, pr.username, pr.display_name, pr.avatar_url, (s.expires_at - s.created_at) >= make_interval(secs => $2) AS remembered
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN profiles pr ON pr.user_id = u.id
       WHERE s.token_hash = ANY($1) AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
      [tokens.map(hashToken), Math.max(0, ttlMs / 1000 - 60)],
    );
    const byHash = new Map(rows.map((r) => [r.token_hash, r]));
    const list: Signed[] = [];
    for (const token of tokens) {
      const r = byHash.get(hashToken(token));
      if (!r) continue;
      const entry: Signed = { token, userId: r.user_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, remembered: r.remembered };
      // One place per account: the session in use wins over another of the same account.
      const at = list.findIndex((a) => a.userId === r.user_id);
      if (at < 0) list.push(entry);
      else if (token === activeToken) list[at] = entry;
    }
    const active = list.find((a) => a.token === activeToken) ?? null;
    const stale = list.length !== stored.length || list.some((a, i) => a.token !== stored[i]);
    return { list, active, stale };
  }

  function write(reply: FastifyReply, list: { token: string; remembered: boolean }[]) {
    if (!list.length) return void reply.clearCookie(ACCOUNTS_COOKIE, { path: '/' });
    reply.setCookie(ACCOUNTS_COOKIE, list.map((a) => a.token).join('.'), cookieOptions(list.every((a) => a.remembered)));
  }

  function setActive(reply: FastifyReply, a: Signed | null) {
    if (a) reply.setCookie(SESSION_COOKIE, a.token, cookieOptions(a.remembered));
    else reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  const tooMany = () =>
    new AppError(409, 'too_many_accounts', `You can keep up to ${MAX_DEVICE_ACCOUNTS} accounts in this browser.`, { max: MAX_DEVICE_ACCOUNTS });

  const addingAccount = (req: FastifyRequest) => fromWeb(req) && (req.body as { addAccount?: unknown } | undefined)?.addAccount === true;

  /** "Add account" on a browser that already has the most accounts it can keep is refused before anything happens. */
  async function checkRoom(req: FastifyRequest) {
    if (!addingAccount(req)) return;
    if ((await read(req)).list.length >= MAX_DEVICE_ACCOUNTS) throw tooMany();
  }

  /**
   * A web sign-in: the new session joins this browser's accounts, and is the one in use (the
   * caller sets the session cookie). An earlier session of the same account here is replaced and
   * ends. Past the limit (a sign-in without "Add account", or two at once) the oldest others leave
   * this browser's list.
   */
  async function signedIn(req: FastifyRequest, reply: FastifyReply, s: { token: string; userId: string; remembered: boolean }) {
    if (!fromWeb(req)) return;
    const { list } = await read(req);
    const same = list.filter((a) => a.userId === s.userId);
    if (same.length)
      await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = ANY($1) AND revoked_at IS NULL`, [same.map((a) => hashToken(a.token))]);
    const others = list.filter((a) => a.userId !== s.userId);
    while (others.length >= MAX_DEVICE_ACCOUNTS) others.shift();
    write(reply, [...others, s]);
  }

  /** The session in use ended (Log out): it leaves this browser's accounts. The others stay, to switch to. */
  async function loggedOut(req: FastifyRequest, reply: FastifyReply) {
    if (!req.cookies?.[ACCOUNTS_COOKIE]) return;
    const { list, stale } = await read(req);
    // The session in use is already revoked, so it isn't in the list any more.
    if (stale) write(reply, list);
  }

  const view = async (list: Signed[], active: Signed | null): Promise<BrowserAccount[]> =>
    Promise.all(
      list.map(async (a) => ({
        id: a.userId,
        username: a.username,
        displayName: a.displayName,
        avatarUrl: a.avatarUrl,
        current: a === active,
        unread: a === active ? 0 : await unreadNotifications(ctx.db, a.userId),
      })),
    );

  const userIdBody = z.object({ userId: z.string().uuid() });

  /** This browser's accounts (never their tokens), the one in use marked. Works signed out too, to log back in with a tap. */
  app.get('/v1/auth/accounts', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { list, active, stale } = await read(req);
    if (stale) write(reply, list);
    return { items: await view(list, active), max: MAX_DEVICE_ACCOUNTS };
  });

  /** Use another account signed in on this browser. Only one this browser's cookie holds, with a session that is still live. */
  app.post('/v1/auth/accounts/switch', { config: authLimit }, async (req, reply) => {
    const { userId } = parse(userIdBody, req.body);
    const { list, stale } = await read(req);
    if (stale) write(reply, list);
    const target = list.find((a) => a.userId === userId);
    if (!target) throw notFound('Account');
    setActive(reply, target);
    return { user: await loadMe(ctx, target.userId) };
  });

  /**
   * Log out of one account on this browser: its session ends and it leaves the list. When it was
   * the one in use, the next account takes over (`current`), or nobody is signed in (`current: null`).
   */
  app.post('/v1/auth/accounts/logout', { config: authLimit }, async (req, reply) => {
    const { userId } = parse(userIdBody, req.body);
    const { list, active } = await read(req);
    const target = list.find((a) => a.userId === userId);
    if (!target) throw notFound('Account');
    await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(target.token)]);
    const rest = list.filter((a) => a !== target);
    write(reply, rest);
    const current = target === active ? (rest[0] ?? null) : active;
    if (target === active) setActive(reply, current);
    return { ok: true, current: current ? await loadMe(ctx, current.userId) : null };
  });

  /** Log out of every account on this browser. */
  app.post('/v1/auth/accounts/logout-all', { config: authLimit }, async (req, reply) => {
    const tokens = tokensIn(req.cookies?.[ACCOUNTS_COOKIE]);
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw && TOKEN.test(raw)) tokens.push(raw);
    const r = tokens.length
      ? await ctx.db.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = ANY($1) AND revoked_at IS NULL`, [tokens.map(hashToken)])
      : { rowCount: 0 };
    reply.clearCookie(ACCOUNTS_COOKIE, { path: '/' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, count: r.rowCount ?? 0 };
  });

  return { cookieOptions, checkRoom, signedIn, loggedOut };
}
