/**
 * Email port.
 *
 * Ion Drive sends mail through the {@link EmailProvider} interface. The default
 * {@link LogEmailProvider} only logs the message (there is no transport out of
 * the box); a SendGrid/SMTP plugin registers a real provider under the same
 * token (see ADR-015). Keeping the port in core lets building blocks and tasks
 * send mail without hard-wiring a vendor.
 */

/** A single email to send. */
export interface EmailMessage {
  to: string | string[];
  subject: string;
  /** Plain-text body. At least one of `text`/`html` should be set. */
  text?: string;
  /** HTML body. */
  html?: string;
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}

/** The outcome of a send attempt. */
export interface EmailResult {
  /** Whether the provider accepted the message for delivery. */
  accepted: boolean;
  /** Provider-assigned message id, when available. */
  messageId?: string;
}

/** A pluggable outbound email transport. */
export interface EmailProvider {
  /** The provider's name (for diagnostics/logging). */
  readonly name: string;
  /** Sends one message. Throws on transport failure. */
  send(message: EmailMessage): Promise<EmailResult>;
}
