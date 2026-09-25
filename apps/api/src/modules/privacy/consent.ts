import type { Queryable } from '@yapilapi/database';
import { AppError } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';

/**
 * Consents are APPEND-ONLY (a database trigger forbids UPDATE/DELETE on `consents`): every change inserts a new row and
 * the LATEST row for (user, purpose) wins. That gives an evidence trail ("when did she withdraw?") for free.
 *
 * `hasConsent` is the one function other modules (AI, ads, analytics, recommendations) call before processing personal
 * data for a purpose. Defaults are privacy-preserving: everything is opt-in except personalization for adults.
 */

export const CONSENT_PURPOSES = [
  'personalization',
  'ai_processing',
  'ai_memory',
  'advertising',
  'analytics',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const PURPOSE_INFO: Record<
  ConsentPurpose,
  { label: string; description: string; defaultGranted: boolean; teenCanGrant: boolean }
> = {
  personalization: {
    label: 'Personalised recommendations',
    description: 'Use your activity and interests to tailor your feed, discovery and search.',
    defaultGranted: true,
    teenCanGrant: true,
  },
  ai_processing: {
    label: 'AI assistance',
    description:
      'Let AI features process the content you choose to send them (drafts, summaries, translation).',
    defaultGranted: false,
    teenCanGrant: true,
  },
  ai_memory: {
    label: 'AI memory',
    description:
      'Let the AI assistant remember facts you tell it between conversations. You can review and delete memories at any time.',
    defaultGranted: false,
    teenCanGrant: false,
  },
  advertising: {
    label: 'Personalised advertising',
    description:
      'Use your activity to choose which ads you see. Without this you still see ads, but not tailored to you.',
    defaultGranted: false,
    teenCanGrant: false,
  },
  analytics: {
    label: 'Product analytics',
    description: 'Share pseudonymous usage events that help us improve YAPILAPI.',
    defaultGranted: false,
    teenCanGrant: false,
  },
};

export const isPurpose = (s: string): s is ConsentPurpose =>
  (CONSENT_PURPOSES as readonly string[]).includes(s);

interface LatestRow {
  purpose: string;
  granted: boolean;
  created_at: Date;
  scope: Record<string, unknown>;
}

async function latest(db: Queryable, userId: string): Promise<Map<string, LatestRow>> {
  const { rows } = await db.query<LatestRow>(
    `SELECT DISTINCT ON (purpose) purpose, granted, created_at, scope FROM consents WHERE user_id = $1 AND purpose = ANY($2::text[]) ORDER BY purpose, created_at DESC, id DESC`,
    [userId, [...CONSENT_PURPOSES]],
  );
  return new Map(rows.map((r) => [r.purpose, r]));
}

/** Has the user (currently) consented to `purpose`? Latest row wins; defaults are in PURPOSE_INFO. Minors never grant teen-restricted purposes. */
export async function hasConsent(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
  purpose: ConsentPurpose,
  db: Queryable = ctx.db,
): Promise<boolean> {
  const info = PURPOSE_INFO[purpose];
  if (!info.teenCanGrant) {
    const u = await db.query<{ age_band: string }>('SELECT age_band FROM users WHERE id = $1', [
      userId,
    ]);
    if (u.rows[0]?.age_band === 'teen') return false;
  }
  if (purpose === 'personalization') {
    // The feed/search switch lives in user_preferences (kept in sync by setConsent); it is the source of truth here.
    const p = await db.query<{ personalization: boolean }>(
      'SELECT personalization FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    return p.rows[0]?.personalization ?? info.defaultGranted;
  }
  const { rows } = await db.query<{ granted: boolean }>(
    'SELECT granted FROM consents WHERE user_id = $1 AND purpose = $2 ORDER BY created_at DESC, id DESC LIMIT 1',
    [userId, purpose],
  );
  return rows[0]?.granted ?? info.defaultGranted;
}

export async function listConsents(ctx: AppContext, userId: string) {
  const [rows, ageBand] = await Promise.all([
    latest(ctx.db, userId),
    ctx.db.query<{ age_band: string }>('SELECT age_band FROM users WHERE id = $1', [userId]),
  ]);
  const teen = ageBand.rows[0]?.age_band === 'teen';
  const out = [];
  for (const purpose of CONSENT_PURPOSES) {
    const info = PURPOSE_INFO[purpose];
    const row = rows.get(purpose);
    out.push({
      purpose,
      label: info.label,
      description: info.description,
      granted: await hasConsent(ctx, userId, purpose),
      decidedAt: row?.created_at.toISOString() ?? null,
      isDefault: !row,
      canGrant: !teen || info.teenCanGrant,
    });
  }
  return out;
}

export async function setConsent(
  ctx: AppContext,
  userId: string,
  purpose: ConsentPurpose,
  granted: boolean,
  opts: { source?: string; scope?: Record<string, unknown> } = {},
): Promise<{ purpose: ConsentPurpose; granted: boolean; changed: boolean }> {
  const info = PURPOSE_INFO[purpose];
  const u = await ctx.db.query<{ age_band: string }>('SELECT age_band FROM users WHERE id = $1', [
    userId,
  ]);
  if (granted && u.rows[0]?.age_band === 'teen' && !info.teenCanGrant) {
    throw new AppError('forbidden', `${info.label} is not available for accounts under 18`);
  }
  const current = await hasConsent(ctx, userId, purpose);
  const hasRow = (await latest(ctx.db, userId)).has(purpose);
  // Append only when the decision changes (or there is no recorded decision yet): the log stays a meaningful trail.
  if (current === granted && hasRow) return { purpose, granted, changed: false };
  await ctx.db.query(
    'INSERT INTO consents (user_id, purpose, granted, scope, source) VALUES ($1,$2,$3,$4,$5)',
    [userId, purpose, granted, JSON.stringify(opts.scope ?? {}), opts.source ?? 'user'],
  );
  if (purpose === 'personalization')
    await ctx.db.query('UPDATE user_preferences SET personalization = $2 WHERE user_id = $1', [
      userId,
      granted,
    ]);
  if (purpose === 'analytics' && !granted) {
    // Withdrawal: detach previously collected events from the person (aggregates survive, attribution does not).
    await ctx.db.query('UPDATE analytics_events SET user_id = NULL WHERE user_id = $1', [userId]);
  }
  return { purpose, granted, changed: true };
}

export async function consentHistory(ctx: AppContext, userId: string, purpose?: string) {
  const { rows } = await ctx.db.query(
    `SELECT id, purpose, granted, source, created_at FROM consents WHERE user_id = $1 AND ($2::text IS NULL OR purpose = $2) ORDER BY created_at DESC, id DESC LIMIT 200`,
    [userId, purpose ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    purpose: r.purpose,
    granted: r.granted,
    source: r.source,
    at: r.created_at.toISOString(),
  }));
}
