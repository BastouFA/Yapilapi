import type { FastifyBaseLogger } from 'fastify';
import { createTransport, type SendMailOptions } from 'nodemailer';
// Every language, loaded up front: an email is written in its recipient's.
import { SUPPORTED_LOCALES, t, type MessageKey } from '@yapilapi/shared/i18n';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  /** Which transport this is: "log" (development) or "smtp". */
  name: 'log' | 'smtp';
  send(email: Email): Promise<void>;
  /** Last emails sent, for development tooling and tests (log transport only). */
  outbox?: Email[];
}

/** Development transport: writes emails to the log and keeps the last 50 in memory. */
export function logEmailSender(log: FastifyBaseLogger): EmailSender {
  const outbox: Email[] = [];
  return {
    name: 'log',
    outbox,
    async send(email) {
      outbox.push(email);
      if (outbox.length > 50) outbox.shift();
      log.info({ to: email.to, subject: email.subject }, `email (log transport): ${email.text}`);
    },
  };
}

/** What the SMTP sender needs from a mail transport (nodemailer's, or a fake in tests). */
export interface MailTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
}

/**
 * Real delivery through any SMTP relay (EMAIL_TRANSPORT=smtp). SMTP_URL is a connection URL,
 * for example smtps://user:password@smtp.example.com:465 or smtp://user:password@host:587
 * (STARTTLS). Plain text only: every email we send is a short notice with one link.
 * A failed send throws; callers decide whether that should fail the request.
 */
export function smtpEmailSender(opts: { url: string; from: string; transport?: MailTransport }): EmailSender {
  const transport: MailTransport = opts.transport ?? createTransport(opts.url);
  return {
    name: 'smtp',
    async send(email) {
      await transport.sendMail({ from: opts.from, to: email.to, subject: email.subject, text: email.text });
    },
  };
}

/** Addresses of deleted accounts are placeholders that must never be written to. */
export function deliverable(address: string | null | undefined): address is string {
  return !!address && !address.endsWith('@deleted.invalid');
}

/**
 * The language to write to someone in: their app language (`profiles.locale`) when there is a
 * catalog for it (or for its base language: fr-CA → fr), else English.
 */
export function recipientLocale(locale: string | null | undefined): string {
  const base = locale?.split(/[-_]/)[0]?.toLowerCase() ?? '';
  return SUPPORTED_LOCALES.includes(base) ? base : 'en';
}

/** "When: Sunday 27 September 2026 at 20:00 UTC", the date and time in the reader's language, always in UTC. */
export function whenLine(at: Date, locale: string): string {
  // Fields rather than dateStyle/timeStyle: Yorùbá's short time style drops a digit ("20:0").
  const date = new Intl.DateTimeFormat(recipientLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(at);
  return t('email.when', locale, { date });
}

/** The web app's address for links in emails (the first origin when several are allowed). */
export const linkOrigin = (webOrigin: string) => webOrigin.split(',')[0]!.replace(/\/+$/, '');

/**
 * Security notices: sent to the account's email address whenever one of these happens, so
 * someone who didn't do it can act (reset the password, sign out other devices).
 * Keyed by the security event type (lib/services.ts securityEvent); the text is in the catalogs
 * under `email.security.<type>`.
 */
export const SECURITY_EMAILS: Record<string, { subject: MessageKey; body: MessageKey }> = Object.fromEntries(
  [
    'password_changed',
    'password_reset',
    'mfa_enabled',
    'mfa_disabled',
    'mfa_recovery_codes_regenerated',
    'passkey_added',
    'passkey_removed',
    'phone_verified',
    'phone_removed',
  ].map((type) => [type, { subject: `email.security.${type}.subject` as MessageKey, body: `email.security.${type}.body` as MessageKey }]),
);

/** The text of a security notice in the reader's language, with what to do if it wasn't you. */
export function securityEmail(type: string, to: string, webOrigin: string, when = new Date(), locale = 'en'): Email | null {
  const e = SECURITY_EMAILS[type];
  if (!e) return null;
  return {
    to,
    subject: t(e.subject, locale),
    text: [
      t(e.body, locale),
      whenLine(when, locale),
      '',
      t('email.nothingToDo', locale),
      t('email.security.ifNot', locale, { url: `${linkOrigin(webOrigin)}/forgot-password` }),
    ].join('\n'),
  };
}
