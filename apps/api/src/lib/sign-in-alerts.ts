import type { Pool, PoolClient } from 'pg';
import type { RealtimeHub } from './realtime.ts';
// Every language, loaded up front: the alert email is written in its reader's.
import { t } from '@yapilapi/shared/i18n';
import { deliverable, linkOrigin, recipientLocale, whenLine, type EmailSender } from './email.ts';
import { notify } from './services.ts';

type Q = Pool | PoolClient;

/** The browser and the system named in a user agent; null for either when it isn't one we know (our app, an unknown system). */
function deviceParts(ua: string): { browser: string | null; os: string | null } {
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  return { browser, os };
}

/**
 * "Chrome on macOS", "App on iOS": the browser (or our app) and the system, from a user agent.
 * Always English: it is the stored device name and part of the sign-in fingerprint, so it must not
 * change with anyone's language (emails use deviceLabel()).
 */
export function deviceName(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  const { browser, os } = deviceParts(ua);
  return `${browser ?? 'App'} on ${os ?? 'Unknown OS'}`;
}

/** The same as deviceName(), in the reader's language ("Chrome sur macOS"). */
export function deviceLabel(ua: string | null | undefined, locale: string): string {
  if (!ua) return t('email.device.unknown', locale);
  const { browser, os } = deviceParts(ua);
  return t('email.device.name', locale, { browser: browser ?? t('email.device.app', locale), os: os ?? t('email.device.unknownOs', locale) });
}

/**
 * What makes a sign-in "from somewhere new": the kind of device (browser or app, and system) and,
 * when a trusted CDN reports it, the country. Versions and exact addresses are left out, so
 * updates and a changing home connection don't set off alerts.
 */
export function signInFingerprint(device: string, country: string | null | undefined): string {
  return `${device.toLowerCase()}|${country && /^[A-Z]{2}$/.test(country) ? country : ''}`;
}

/** The country's name in the reader's language ("Nigeria", "Nigéria", "نيجيريا"), or null when there is none. */
export function placeName(country: string | null | undefined, locale = 'en'): string | null {
  if (!country || !/^[A-Z]{2}$/.test(country)) return null;
  try {
    return new Intl.DisplayNames([recipientLocale(locale)], { type: 'region' }).of(country) ?? country;
  } catch {
    return country;
  }
}

export interface SignIn {
  userId: string;
  sessionId: string;
  userAgent: string | null | undefined;
  /** From the trusted CDN header, when configured. */
  country: string | null;
}

/**
 * Remember where an account signs in from, and tell the person when it's somewhere new: a
 * notification in the app always, and an email unless they turned those off. Nothing is sent for
 * the sign-up itself (`quiet`), nor for an account's first sign-in since alerts began (there is
 * nothing to compare with yet). Returns whether this was new and announced.
 */
export async function recordSignIn(
  deps: { db: Pool; realtime: RealtimeHub; email: EmailSender; webOrigin: string; log?: { warn(obj: object, msg: string): void } },
  s: SignIn,
  o: { quiet?: boolean; at?: Date } = {},
): Promise<boolean> {
  const device = deviceName(s.userAgent);
  const fingerprint = signInFingerprint(device, s.country);
  const known = await deps.db.query<{ fingerprint: string }>(`SELECT fingerprint FROM known_sign_ins WHERE user_id = $1`, [s.userId]);
  const seen = known.rows.some((r) => r.fingerprint === fingerprint);
  await deps.db.query(
    `INSERT INTO known_sign_ins (user_id, fingerprint) VALUES ($1, $2)
     ON CONFLICT (user_id, fingerprint) DO UPDATE SET last_seen_at = now()`,
    [s.userId, fingerprint],
  );
  if (seen || o.quiet || !known.rowCount) return false;
  const at = o.at ?? new Date();
  const place = placeName(s.country);
  await notify(deps.db, deps.realtime, {
    userId: s.userId,
    category: 'security',
    type: 'new_sign_in',
    entityType: 'session',
    entityId: s.sessionId,
    data: { device, place, country: s.country, at: at.toISOString() },
  });
  void emailAlert(deps, s.userId, { userAgent: s.userAgent, country: s.country, at }).catch((err: Error) =>
    deps.log?.warn({ err: err.message }, 'sign-in alert email not sent'),
  );
  return true;
}

async function emailAlert(
  deps: { db: Q; email: EmailSender; webOrigin: string },
  userId: string,
  a: { userAgent: string | null | undefined; country: string | null; at: Date },
) {
  const { rows } = await deps.db.query<{ email: string; username: string; locale: string | null; on: boolean }>(
    `SELECT u.email, pr.username, pr.locale, coalesce(up.sign_in_email_alerts, true) AS on
     FROM users u JOIN profiles pr ON pr.user_id = u.id LEFT JOIN user_preferences up ON up.user_id = u.id
     WHERE u.id = $1 AND u.status <> 'deleted'`,
    [userId],
  );
  const r = rows[0];
  if (!r || !r.on || !deliverable(r.email)) return;
  // In the account's own language: the device, the country's name and the date too.
  const locale = recipientLocale(r.locale);
  await deps.email.send(
    signInEmail(r.email, r.username, deps.webOrigin, { device: deviceLabel(a.userAgent, locale), place: placeName(a.country, locale), at: a.at }, locale),
  );
}

/** The email about a sign-in from a new device, with where to go if it wasn't you. `device` and `place` are already in `locale`. */
export function signInEmail(to: string, username: string, webOrigin: string, a: { device: string; place: string | null; at: Date }, locale = 'en') {
  return {
    to,
    subject: t('email.signIn.subject', locale),
    text: [
      t('email.signIn.intro', locale, { username }),
      '',
      t('email.signIn.device', locale, { device: a.device }),
      whenLine(a.at, locale),
      ...(a.place ? [t('email.signIn.place', locale, { place: a.place })] : []),
      '',
      t('email.nothingToDo', locale),
      '',
      t('email.signIn.notMe', locale, { url: `${linkOrigin(webOrigin)}/settings/security?review=sign-in` }),
      t('email.signIn.notMeHint', locale),
      '',
      t('email.signIn.turnOff', locale),
    ].join('\n'),
  };
}
