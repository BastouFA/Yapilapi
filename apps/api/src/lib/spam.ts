import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.ts';
import { AppError } from './errors.ts';
import { isDisposableEmail } from './disposable-domains.ts';
import type { RealtimeHub } from './realtime.ts';
import { audit, notify } from './services.ts';

type Q = Pool | PoolClient;

/**
 * Spam and bot detection. Every rule here only records a signal, holds content
 * for review or slows a brand-new account down; none of them deletes anything
 * or suspends anyone. People make the final call in the moderator console.
 * All rules are off when SPAM_CHECKS is false (the default in tests).
 */
export const SPAM_RULES = {
  /** Accounts younger than this get the stricter posting and messaging pace. */
  newAccountHours: 24,
  /** Accounts younger than this can't post many links at once without review. */
  linkWatchDays: 7,
  signupsPerIpPerHour: 5,
  signupsPerSubnetPerHour: 20,
  newAccountPostsPerHour: 10,
  newAccountMessagesPerHour: 30,
  /** The 3rd identical post from one account within an hour is held for review. */
  duplicatePostsPerHour: 3,
  /** The 5th identical post with a link, from any accounts, within an hour is held for review. */
  duplicateLinkPostsAcrossAccounts: 5,
  /** The same message sent into a 5th conversation within an hour is held for review. */
  duplicateMessageConversations: 5,
  /** More links than this in one post or message from a new account is held for review. */
  newAccountMaxLinks: 2,
  /** Shorter texts ("ok", "thanks") are never treated as repeated spam. */
  minDuplicateLength: 8,
  /** This many flagged posts or messages within 7 days limits the account until a moderator looks. */
  flagsBeforeRestrict: 3,
  /** Open signal weight at which an account's public posts wait for review. */
  riskyAccountScore: 40,
} as const;

export const SIGNAL_WEIGHTS: Record<string, number> = {
  disposable_email: 40,
  signup_ip_velocity: 30,
  signup_subnet_velocity: 20,
  post_velocity: 10,
  message_velocity: 10,
  duplicate_text: 20,
  link_spam: 20,
  auto_restricted: 0,
};

export interface Signal {
  kind: string;
  weight: number;
  detail?: Record<string, unknown>;
}

const signal = (kind: string, detail?: Record<string, unknown>): Signal => ({ kind, weight: SIGNAL_WEIGHTS[kind] ?? 0, detail });

/** Links in a text: http(s) addresses and bare www. addresses. */
export function countLinks(text: string): number {
  return text.match(/\bhttps?:\/\/|\bwww\./gi)?.length ?? 0;
}

const FINGERPRINT = (col: string) => `md5(regexp_replace(lower(${col}), '\\s+', ' ', 'g'))`;

// ── Sign-up ─────────────────────────────────────────────────────────────

/**
 * Score a sign-up before the account exists: a throwaway email domain, and
 * many sign-ups from the same address or /24 (IPv6: /64) in the last hour.
 */
export async function scoreSignup(db: Q, config: Config, input: { email: string; ip: string | undefined }): Promise<Signal[]> {
  if (!config.SPAM_CHECKS) return [];
  const out: Signal[] = [];
  if (isDisposableEmail(input.email)) out.push(signal('disposable_email', { domain: input.email.split('@').pop() }));
  if (input.ip) {
    const { rows } = await db.query<{ same_ip: string; same_subnet: string }>(
      `SELECT count(*) FILTER (WHERE ip = $1::inet) AS same_ip,
              count(*) FILTER (WHERE ip <<= network(set_masklen($1::inet, CASE WHEN family($1::inet) = 4 THEN 24 ELSE 64 END))) AS same_subnet
       FROM security_events WHERE type = 'account_created' AND created_at > now() - interval '1 hour'`,
      [input.ip],
    );
    const sameIp = Number(rows[0]?.same_ip ?? 0) + 1;
    const sameSubnet = Number(rows[0]?.same_subnet ?? 0) + 1;
    if (sameIp > SPAM_RULES.signupsPerIpPerHour) out.push(signal('signup_ip_velocity', { signupsLastHour: sameIp }));
    if (sameSubnet > SPAM_RULES.signupsPerSubnetPerHour) out.push(signal('signup_subnet_velocity', { signupsLastHour: sameSubnet }));
  }
  return out;
}

export async function recordSignals(db: Q, userId: string, signals: Signal[], target?: { type: string; id: string }): Promise<void> {
  for (const s of signals)
    await db.query(`INSERT INTO risk_signals (user_id, kind, weight, detail, target_type, target_id) VALUES ($1,$2,$3,$4,$5,$6)`, [
      userId,
      s.kind,
      s.weight,
      s.detail ?? {},
      target?.type ?? null,
      target?.id ?? null,
    ]);
}

// ── Pace for new accounts ───────────────────────────────────────────────

interface Standing {
  newAccount: boolean;
  linkWatch: boolean;
  restricted: boolean;
  score: number;
}

async function standing(db: Q, userId: string): Promise<Standing> {
  const { rows } = await db.query(
    `SELECT u.created_at > now() - make_interval(hours => $2) AS new_account,
            u.created_at > now() - make_interval(days => $3) AS link_watch,
            u.restricted_at IS NOT NULL AS restricted,
            (SELECT coalesce(sum(weight), 0) FROM risk_signals s WHERE s.user_id = u.id AND s.status = 'open')::int AS score
     FROM users u WHERE u.id = $1`,
    [userId, SPAM_RULES.newAccountHours, SPAM_RULES.linkWatchDays],
  );
  const r = rows[0];
  return { newAccount: !!r?.new_account, linkWatch: !!r?.link_watch, restricted: !!r?.restricted, score: Number(r?.score ?? 0) };
}

/** Whether moderators (or repeated flags) have limited this account. Always enforced, whatever SPAM_CHECKS says. */
export async function isRestricted(db: Q, userId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT restricted_at IS NOT NULL AS r FROM users WHERE id = $1`, [userId]);
  return !!rows[0]?.r;
}

export function restrictedError(action: 'message' | 'live'): AppError {
  return new AppError(
    403,
    'account_restricted',
    action === 'live'
      ? 'Your account is limited while our team reviews some recent activity, so you can’t go live for now. This usually takes a day or two.'
      : 'Your account is limited while our team reviews some recent activity, so you can only message friends for now. This usually takes a day or two.',
  );
}

/** Record a velocity signal at most once an hour, so a burst doesn't pile up signals. */
async function velocitySignal(db: Q, userId: string, kind: 'post_velocity' | 'message_velocity', count: number) {
  const recent = await db.query(`SELECT 1 FROM risk_signals WHERE user_id = $1 AND kind = $2 AND created_at > now() - interval '1 hour'`, [userId, kind]);
  if (!recent.rowCount) await recordSignals(db, userId, [signal(kind, { lastHour: count })]);
}

/** New accounts share at most a few posts an hour. Throws 429 with a plain explanation. */
export async function assertPostPace(db: Q, config: Config, userId: string): Promise<void> {
  if (!config.SPAM_CHECKS) return;
  const { rows } = await db.query(
    `SELECT u.created_at > now() - make_interval(hours => $2) AS new_account,
            (SELECT count(*) FROM posts p WHERE p.author_id = u.id AND p.created_at > now() - interval '1 hour')::int AS n
     FROM users u WHERE u.id = $1`,
    [userId, SPAM_RULES.newAccountHours],
  );
  if (!rows[0]?.new_account || rows[0].n < SPAM_RULES.newAccountPostsPerHour) return;
  await velocitySignal(db, userId, 'post_velocity', rows[0].n);
  throw new AppError(429, 'slow_down', `New accounts can share up to ${SPAM_RULES.newAccountPostsPerHour} posts an hour. You can post again a little later.`);
}

export async function assertMessagePace(db: Q, config: Config, userId: string): Promise<void> {
  if (!config.SPAM_CHECKS) return;
  const { rows } = await db.query(
    `SELECT u.created_at > now() - make_interval(hours => $2) AS new_account,
            (SELECT count(*) FROM messages m WHERE m.sender_id = u.id AND m.created_at > now() - interval '1 hour')::int AS n
     FROM users u WHERE u.id = $1`,
    [userId, SPAM_RULES.newAccountHours],
  );
  if (!rows[0]?.new_account || rows[0].n < SPAM_RULES.newAccountMessagesPerHour) return;
  await velocitySignal(db, userId, 'message_velocity', rows[0].n);
  throw new AppError(
    429,
    'slow_down',
    `New accounts can send up to ${SPAM_RULES.newAccountMessagesPerHour} messages an hour. You can send more a little later.`,
  );
}

// ── Content ─────────────────────────────────────────────────────────────

export interface Assessment {
  /** Rule-based flags for this piece of content; each one counts toward limiting the account. */
  flags: Signal[];
  /** The account's open signals add up to enough that its public posts wait for review. */
  risky: boolean;
  restricted: boolean;
}

/** Check a post before it's saved: too many links from a new account, and repeated identical text. */
export async function assessPost(db: Q, config: Config, userId: string, text: string): Promise<Assessment> {
  const st = await standing(db, userId);
  if (!config.SPAM_CHECKS) return { flags: [], risky: false, restricted: st.restricted };
  const flags: Signal[] = [];
  const links = countLinks(text);
  if (st.linkWatch && links > SPAM_RULES.newAccountMaxLinks) flags.push(signal('link_spam', { links }));
  if (text.length >= SPAM_RULES.minDuplicateLength) {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE author_id = $1)::int AS mine, count(*)::int AS everyone
       FROM posts WHERE ${FINGERPRINT('body')} = ${FINGERPRINT('$2::text')} AND body <> '' AND deleted_at IS NULL AND created_at > now() - interval '1 hour'`,
      [userId, text],
    );
    const mine = (rows[0]?.mine ?? 0) + 1;
    const everyone = (rows[0]?.everyone ?? 0) + 1;
    if (mine >= SPAM_RULES.duplicatePostsPerHour) flags.push(signal('duplicate_text', { scope: 'account', copiesLastHour: mine }));
    else if (links > 0 && everyone >= SPAM_RULES.duplicateLinkPostsAcrossAccounts)
      flags.push(signal('duplicate_text', { scope: 'accounts', copiesLastHour: everyone }));
  }
  return { flags, risky: st.score >= SPAM_RULES.riskyAccountScore, restricted: st.restricted };
}

/** Check a message to someone who isn't a friend: links from a new account, and the same text sent into many conversations. */
export async function assessMessage(db: Q, config: Config, userId: string, conversationId: string, text: string): Promise<Assessment> {
  const st = await standing(db, userId);
  if (!config.SPAM_CHECKS || !text) return { flags: [], risky: false, restricted: st.restricted };
  const flags: Signal[] = [];
  const links = countLinks(text);
  if (st.linkWatch && links > SPAM_RULES.newAccountMaxLinks) flags.push(signal('link_spam', { links }));
  if (text.length >= SPAM_RULES.minDuplicateLength) {
    const { rows } = await db.query(
      `SELECT count(DISTINCT conversation_id)::int AS n FROM messages
       WHERE sender_id = $1 AND conversation_id <> $2 AND deleted_at IS NULL AND created_at > now() - interval '1 hour'
         AND ${FINGERPRINT('body')} = ${FINGERPRINT('$3::text')}`,
      [userId, conversationId, text],
    );
    const conversations = (rows[0]?.n ?? 0) + 1;
    if (conversations >= SPAM_RULES.duplicateMessageConversations) flags.push(signal('duplicate_text', { scope: 'messages', conversations }));
  }
  return { flags, risky: st.score >= SPAM_RULES.riskyAccountScore, restricted: st.restricted };
}

/**
 * Record flags against the content they came from, then limit the account when
 * it has collected enough flagged items this week. Limiting is reversible and
 * a moderator reviews it from the console. Returns true when this call limited it.
 */
export async function flagContent(
  c: Q,
  realtime: RealtimeHub,
  userId: string,
  target: { type: 'post' | 'message'; id: string },
  flags: Signal[],
): Promise<boolean> {
  if (!flags.length) return false;
  await recordSignals(c, userId, flags, target);
  const { rows } = await c.query(
    `SELECT count(DISTINCT (target_type, target_id))::int AS n FROM risk_signals
     WHERE user_id = $1 AND status = 'open' AND target_id IS NOT NULL AND created_at > now() - interval '7 days'`,
    [userId],
  );
  const n = rows[0]?.n ?? 0;
  if (n < SPAM_RULES.flagsBeforeRestrict) return false;
  const r = await c.query(`UPDATE users SET restricted_at = now() WHERE id = $1 AND restricted_at IS NULL AND role = 'user' RETURNING id`, [userId]);
  if (!r.rowCount) return false;
  await recordSignals(c, userId, [signal('auto_restricted', { flaggedItems: n })]);
  await audit(c, { actorId: null, action: 'account.auto_restricted', entityType: 'user', entityId: userId, metadata: { flaggedItems: n } });
  await notify(c, realtime, { userId, category: 'moderation', type: 'account_limited', entityType: 'user', entityId: userId });
  return true;
}
