import type { Pool, PoolClient } from 'pg';
import type { RealtimeHub } from './realtime.ts';
import { deliverable, type EmailSender } from './email.ts';
import { notify } from './services.ts';

type Q = Pool | PoolClient;

/** "Chrome on macOS", "App on iOS": the browser (or our app) and the system, from a user agent. */
export function deviceName(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
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
            : 'Unknown OS';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'App';
  return `${browser} on ${os}`;
}

/**
 * What makes a sign-in "from somewhere new": the kind of device (browser or app, and system) and,
 * when a trusted CDN reports it, the country. Versions and exact addresses are left out, so
 * updates and a changing home connection don't set off alerts.
 */
export function signInFingerprint(device: string, country: string | null | undefined): string {
  return `${device.toLowerCase()}|${country && /^[A-Z]{2}$/.test(country) ? country : ''}`;
}

/** The country's name in English ("Nigeria"), or null when there is none. */
export function placeName(country: string | null | undefined): string | null {
  if (!country || !/^[A-Z]{2}$/.test(country)) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country;
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
  void emailAlert(deps, s.userId, { device, place, at }).catch((err: Error) => deps.log?.warn({ err: err.message }, 'sign-in alert email not sent'));
  return true;
}

async function emailAlert(deps: { db: Q; email: EmailSender; webOrigin: string }, userId: string, a: { device: string; place: string | null; at: Date }) {
  const { rows } = await deps.db.query<{ email: string; username: string; on: boolean }>(
    `SELECT u.email, pr.username, coalesce(up.sign_in_email_alerts, true) AS on
     FROM users u JOIN profiles pr ON pr.user_id = u.id LEFT JOIN user_preferences up ON up.user_id = u.id
     WHERE u.id = $1 AND u.status <> 'deleted'`,
    [userId],
  );
  const r = rows[0];
  if (!r || !r.on || !deliverable(r.email)) return;
  await deps.email.send(signInEmail(r.email, r.username, deps.webOrigin, a));
}

/** The email about a sign-in from a new device, with where to go if it wasn't you. */
export function signInEmail(to: string, username: string, webOrigin: string, a: { device: string; place: string | null; at: Date }) {
  const origin = webOrigin.split(',')[0]!.replace(/\/+$/, '');
  return {
    to,
    subject: 'New sign-in to your account',
    text: [
      `Someone just signed in to your YAPILAPI account @${username} from a device we haven't seen before.`,
      '',
      `Device: ${a.device}`,
      `When: ${a.at.toUTCString()}`,
      ...(a.place ? [`Approximate place: ${a.place}`] : []),
      '',
      'If this was you, there is nothing to do.',
      '',
      `This wasn't me: ${origin}/settings/security?review=sign-in`,
      'There you can log out the devices you don’t recognise and change your password.',
      '',
      'You can turn these emails off in Settings, under Security. You will still get a notification in the app.',
    ].join('\n'),
  };
}
