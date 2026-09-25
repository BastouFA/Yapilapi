import type { FastifyBaseLogger } from 'fastify';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(email: Email): Promise<void>;
  /** Last emails sent, for development tooling and tests (log transport only). */
  outbox?: Email[];
}

/**
 * Development transport: writes emails to the log and keeps the last 50 in memory.
 * Production needs an SMTP or email-API adapter (documented in docs/architecture).
 */
export function logEmailSender(log: FastifyBaseLogger): EmailSender {
  const outbox: Email[] = [];
  return {
    outbox,
    async send(email) {
      outbox.push(email);
      if (outbox.length > 50) outbox.shift();
      log.info({ to: email.to, subject: email.subject }, `email (log transport): ${email.text}`);
    },
  };
}
