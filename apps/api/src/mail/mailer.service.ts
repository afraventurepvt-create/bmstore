import { Injectable, Logger } from '@nestjs/common';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email sender. STUB: there is no transport yet. Messages are kept in an in-memory outbox (bounded, newest last) so
 * tests and local development can read them, and a line WITHOUT the body is logged (bodies carry reset tokens).
 * Replace `deliver()` with a real transport (SES / SMTP) when one is chosen; callers never need to change.
 */
@Injectable()
export class MailerService {
  private readonly log = new Logger(MailerService.name);
  private static readonly OUTBOX_LIMIT = 200;
  readonly outbox: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    await this.deliver(mail);
  }

  protected async deliver(mail: Mail): Promise<void> {
    this.outbox.push(mail);
    if (this.outbox.length > MailerService.OUTBOX_LIMIT) this.outbox.splice(0, this.outbox.length - MailerService.OUTBOX_LIMIT);
    this.log.log(`mail queued (stub transport) to=${mask(mail.to)} subject="${mail.subject}"`);
  }

  /** Last message sent to an address, if any (tests, dev tooling). */
  lastTo(to: string): Mail | undefined {
    const t = to.toLowerCase();
    for (let i = this.outbox.length - 1; i >= 0; i--) if (this.outbox[i].to.toLowerCase() === t) return this.outbox[i];
    return undefined;
  }
}

function mask(email: string) {
  const [u, d] = email.split('@');
  return `${u?.slice(0, 2) ?? ''}***@${d ?? ''}`;
}
