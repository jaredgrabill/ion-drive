/**
 * @module @ion-drive/plugin-sendgrid
 *
 * Ion Drive plugin swapping the platform's email port for SendGrid.
 *
 * Usage — programmatic:
 * ```ts
 * import { createServer } from '@ion-drive/core';
 * import { sendgridPlugin } from '@ion-drive/plugin-sendgrid';
 *
 * await createServer(config, { plugins: [sendgridPlugin({ from: 'no-reply@acme.io' })] });
 * ```
 * or via env: `ION_PLUGINS=@ion-drive/plugin-sendgrid` with `SENDGRID_API_KEY`
 * (and optionally `SENDGRID_FROM`) set. Anything resolving core's
 * `EMAIL_SERVICE` token — blocks, tasks, future core features — then sends
 * real mail with no further wiring.
 */

import { EMAIL_SERVICE, type IonPlugin, definePlugin } from '@ion-drive/core';
import { SendGridEmailProvider, type SendGridProviderOptions } from './sendgrid-provider.js';

export { SendGridEmailProvider } from './sendgrid-provider.js';
export type { SendGridProviderOptions } from './sendgrid-provider.js';

export type SendGridPluginOptions = Partial<SendGridProviderOptions>;

/**
 * Creates the plugin. Options fall back to environment variables at load time:
 * `SENDGRID_API_KEY` (or `ION_SENDGRID_API_KEY`), `SENDGRID_FROM` (or
 * `ION_EMAIL_FROM`), `SENDGRID_API_BASE`.
 */
export function sendgridPlugin(options: SendGridPluginOptions = {}): IonPlugin {
  return definePlugin({
    name: 'sendgrid',
    setup(ctx) {
      const apiKey =
        options.apiKey ?? process.env.SENDGRID_API_KEY ?? process.env.ION_SENDGRID_API_KEY;
      if (!apiKey) {
        throw new Error(
          'SendGrid API key missing — set SENDGRID_API_KEY or pass sendgridPlugin({ apiKey })',
        );
      }
      const from = options.from ?? process.env.SENDGRID_FROM ?? process.env.ION_EMAIL_FROM;
      const provider = new SendGridEmailProvider(
        { apiKey, from, apiBase: options.apiBase },
        ctx.logger,
      );
      ctx.registry.set(EMAIL_SERVICE, provider);
      ctx.logger.info('Email provider swapped to SendGrid', { from: from ?? '(per-message)' });
    },
  });
}

/** Env-driven default export for `ION_PLUGINS=@ion-drive/plugin-sendgrid`. */
export default sendgridPlugin();
