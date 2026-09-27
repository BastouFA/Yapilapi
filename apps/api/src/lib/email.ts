import type { FastifyBaseLogger } from 'fastify';
import { createTransport, type SendMailOptions } from 'nodemailer';

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
 * Security notices: sent to the account's email address whenever one of these happens, so
 * someone who didn't do it can act (reset the password, sign out other devices).
 * Keyed by the security event type (lib/services.ts securityEvent).
 */
export const SECURITY_EMAILS: Record<string, { subject: string; body: string }> = {
  password_changed: {
    subject: 'Your YAPILAPI password was changed',
    body: 'The password for your YAPILAPI account was just changed, and your other devices were signed out.',
  },
  password_reset: {
    subject: 'Your YAPILAPI password was reset',
    body: 'The password for your YAPILAPI account was just reset with a link sent to this address, and every device was signed out.',
  },
  mfa_enabled: {
    subject: 'Two-step verification is on',
    body: 'Two-step verification was just turned on for your YAPILAPI account.',
  },
  mfa_disabled: {
    subject: 'Two-step verification is off',
    body: 'Two-step verification was just turned off for your YAPILAPI account.',
  },
  mfa_recovery_codes_regenerated: {
    subject: 'New recovery codes for YAPILAPI',
    body: 'New recovery codes were just made for your YAPILAPI account. The old ones no longer work.',
  },
  passkey_added: {
    subject: 'A passkey was added to your YAPILAPI account',
    body: 'A new passkey was just added to your YAPILAPI account. It can be used to sign in without your password.',
  },
  passkey_removed: {
    subject: 'A passkey was removed from your YAPILAPI account',
    body: 'A passkey was just removed from your YAPILAPI account.',
  },
  phone_verified: {
    subject: 'A phone number was added to your YAPILAPI account',
    body: 'A phone number was just confirmed on your YAPILAPI account.',
  },
  phone_removed: {
    subject: 'A phone number was removed from your YAPILAPI account',
    body: 'The phone number on your YAPILAPI account was just removed.',
  },
};

/** The text of a security notice, with what to do if it wasn't you. */
export function securityEmail(type: string, to: string, webOrigin: string, when = new Date()): Email | null {
  const e = SECURITY_EMAILS[type];
  if (!e) return null;
  const origin = webOrigin.split(',')[0]!.replace(/\/+$/, '');
  return {
    to,
    subject: e.subject,
    text: [
      e.body,
      `When: ${when.toUTCString()}`,
      '',
      'If this was you, there is nothing to do.',
      `If it wasn't, reset your password now at ${origin}/forgot-password and check the devices signed in to your account in Settings.`,
    ].join('\n'),
  };
}
