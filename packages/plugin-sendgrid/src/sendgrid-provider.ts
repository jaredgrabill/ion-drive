/**
 * SendGrid email provider — a real transport behind core's {@link EmailProvider}
 * port (the in-core default only logs). Zero dependencies: the SendGrid v3
 * `POST /v3/mail/send` API is called with the built-in `fetch`, mirroring the
 * invoicing block's Stripe client. The API base is overridable via
 * `SENDGRID_API_BASE` (or the constructor) so tests and mocks never touch the
 * real service.
 */

import type { EmailMessage, EmailProvider, EmailResult, LoggerProvider } from '@ion-drive/core';

const DEFAULT_API_BASE = 'https://api.sendgrid.com';

export interface SendGridProviderOptions {
  /** SendGrid API key (`SG.…`). */
  apiKey: string;
  /** Default sender used when a message carries no `from`. */
  from?: string;
  /** API base URL override (tests/mocks). Defaults to `SENDGRID_API_BASE` or the real API. */
  apiBase?: string;
}

/** One SendGrid address object. */
interface Address {
  email: string;
}

/** Normalizes `string | string[]` recipients into SendGrid address objects. */
function toAddresses(value: string | string[] | undefined): Address[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : [value]).map((email) => ({ email }));
  return list.length > 0 ? list : undefined;
}

/** Extracts a readable error message from a SendGrid error response body. */
function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: { message?: string }[] };
    const messages = (parsed.errors ?? [])
      .map((e) => e.message)
      .filter((m): m is string => typeof m === 'string');
    if (messages.length > 0) return messages.join('; ');
  } catch {
    // fall through to the raw body
  }
  return body.slice(0, 300);
}

export class SendGridEmailProvider implements EmailProvider {
  readonly name = 'sendgrid';

  private readonly apiKey: string;
  private readonly defaultFrom?: string;
  private readonly apiBase: string;

  constructor(
    options: SendGridProviderOptions,
    private readonly logger?: LoggerProvider,
  ) {
    this.apiKey = options.apiKey;
    this.defaultFrom = options.from;
    this.apiBase = (options.apiBase ?? process.env.SENDGRID_API_BASE ?? DEFAULT_API_BASE).replace(
      /\/+$/,
      '',
    );
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const from = message.from ?? this.defaultFrom;
    if (!from) {
      throw new Error(
        'SendGrid: no sender — set a `from` on the message or configure a default (SENDGRID_FROM)',
      );
    }
    if (!message.text && !message.html) {
      throw new Error('SendGrid: message needs a `text` or `html` body');
    }

    // SendGrid requires text/plain before text/html in `content`.
    const content: { type: string; value: string }[] = [];
    if (message.text) content.push({ type: 'text/plain', value: message.text });
    if (message.html) content.push({ type: 'text/html', value: message.html });

    const personalization: Record<string, unknown> = { to: toAddresses(message.to) };
    const cc = toAddresses(message.cc);
    const bcc = toAddresses(message.bcc);
    if (cc) personalization.cc = cc;
    if (bcc) personalization.bcc = bcc;

    const payload: Record<string, unknown> = {
      personalizations: [personalization],
      from: { email: from },
      subject: message.subject,
      content,
    };
    if (message.replyTo) payload.reply_to = { email: message.replyTo };

    const res = await fetch(`${this.apiBase}/v3/mail/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = errorDetail(await res.text());
      throw new Error(`SendGrid rejected the message (HTTP ${res.status}): ${detail}`);
    }

    const messageId = res.headers.get('x-message-id') ?? undefined;
    this.logger?.debug('SendGrid accepted message', { messageId });
    return { accepted: true, messageId };
  }
}
