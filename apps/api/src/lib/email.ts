import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/** Development adapter: logs the message (links included) instead of sending. */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly log: (line: string) => void) {}
  async send(msg: EmailMessage): Promise<void> {
    this.log(`[dev-email] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
  }
}

/** Test adapter: captures messages so tests can read verification/reset links. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
  }
  last(to?: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => !to || m.to === to);
  }
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport;
  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }
  async send(msg: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    });
  }
}
