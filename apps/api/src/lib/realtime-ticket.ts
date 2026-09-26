import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.ts';

/**
 * Short-lived tickets for the realtime socket. In production the web app and
 * the API are on different hosts, so the browser's first-party session cookie
 * never reaches the socket. The web app asks for a ticket through its own
 * origin (cookie auth), then opens the socket with it. A ticket names a
 * session and expires after 60 seconds; the socket still checks that the
 * session is live.
 */
const TTL_MS = 60_000;

function key(cfg: Config): Buffer {
  return createHash('sha256')
    .update(`realtime-ticket:${cfg.MFA_ENCRYPTION_KEY || cfg.PAYMENTS_WEBHOOK_SECRET}`)
    .digest();
}

export function issueTicket(cfg: Config, sessionId: string, now = Date.now()): string {
  const body = Buffer.from(`${sessionId}.${now + TTL_MS}`).toString('base64url');
  const mac = createHmac('sha256', key(cfg)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The session id a ticket names, or null if it is forged or expired. */
export function readTicket(cfg: Config, ticket: string, now = Date.now()): string | null {
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key(cfg)).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [sessionId, exp] = Buffer.from(body, 'base64url').toString().split('.');
  if (!sessionId || !exp || Number(exp) < now) return null;
  return sessionId;
}
