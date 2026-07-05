/**
 * Logging email provider — the default {@link EmailProvider}.
 *
 * There is no outbound transport in core, so the default provider records the
 * message to the platform log and reports it as accepted. This makes the email
 * seam usable in development and tests while a plugin (SendGrid/SMTP) supplies
 * real delivery in production. It never throws, so callers behave identically
 * whether or not a transport is configured.
 */

import type { LoggerProvider } from '../logging/logger-provider.js';
import type { EmailMessage, EmailProvider, EmailResult } from './email-provider.js';

export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';

  constructor(private readonly logger: LoggerProvider) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    this.logger.warn(
      'No email transport configured — logging message instead of sending. Install an email plugin (e.g. SendGrid) to deliver mail.',
      {
        to: message.to,
        subject: message.subject,
        from: message.from,
      },
    );
    return { accepted: true };
  }
}
