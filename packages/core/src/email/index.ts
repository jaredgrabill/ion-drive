/**
 * Email module barrel — the {@link EmailProvider} port, the default logging
 * adapter, and the registry token used to resolve/replace it.
 */

import { serviceToken } from '../runtime/service-registry.js';
import type { EmailProvider } from './email-provider.js';

export type { EmailProvider, EmailMessage, EmailResult } from './email-provider.js';
export { LogEmailProvider } from './log-email.js';

/** Registry token for the platform email provider. */
export const EMAIL_SERVICE = serviceToken<EmailProvider>('email');
