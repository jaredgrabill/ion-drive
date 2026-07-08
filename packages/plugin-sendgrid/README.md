# @ion-drive/plugin-sendgrid

SendGrid email transport for [Ion Drive](https://github.com/jaredgrabill/ion-drive) —
swaps the platform's `EmailProvider` port (whose in-core default only logs)
for real outbound delivery via the SendGrid v3 API. Zero runtime dependencies.

## Install

```bash
npm install @ion-drive/plugin-sendgrid
```

Programmatic (recommended — your `server.ts` composition root):

```ts
import { createServer, loadConfig } from '@ion-drive/core';
import { sendgridPlugin } from '@ion-drive/plugin-sendgrid';

const server = await createServer(loadConfig(), {
  plugins: [sendgridPlugin({ from: 'no-reply@acme.io' })],
});
```

Or via environment: `ION_PLUGINS=@ion-drive/plugin-sendgrid`.

## Configuration

| Option | Env fallback | Notes |
|---|---|---|
| `apiKey` | `SENDGRID_API_KEY` (or `ION_SENDGRID_API_KEY`) | Required — boot fails with a clear error otherwise |
| `from` | `SENDGRID_FROM` (or `ION_EMAIL_FROM`) | Default sender when a message has no `from` |
| `apiBase` | `SENDGRID_API_BASE` | Override for tests/mocks |

Anything that resolves core's `EMAIL_SERVICE` token — blocks, tasks, plugins —
then sends real mail with no further wiring:

```ts
const email = registry.require(EMAIL_SERVICE);
await email.send({ to: 'user@example.com', subject: 'Welcome', text: 'Hi!' });
```

## License

Apache-2.0 © IonShift Technologies LLC
