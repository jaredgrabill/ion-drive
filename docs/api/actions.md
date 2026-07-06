# Block actions & hooks

Blocks with vendored logic (ADR-018) expose two kinds of HTTP surface beyond
the automatic CRUD APIs: **actions** (callable operations) and **hooks**
(inbound webhooks). Both follow the platform's declare-then-provide contract:

- the block's **manifest declares** the surface (`actions`, `hooks`) — this is
  what appears in OpenAPI and MCP;
- the block's **vendored code provides** the handlers, registered through the
  plugin host at boot (`ctx.actions.registerAction/registerHook`);
- **install validates** the two match: a declared action without a registered
  handler fails with *"did you vendor its code? (expected in /blocks/&lt;name&gt;)"*.

## Actions

```
POST /api/v1/blocks/:block/actions/:action
```

```bash
curl -X POST http://localhost:3000/api/v1/blocks/invoicing/actions/create_payment_link \
  -H 'content-type: application/json' \
  -d '{"invoice_id":"7d5c02e2-…"}'
# → { "data": { "url": "https://checkout.stripe.com/…", "session_id": "cs_…" } }
```

- **Validation** — the handler's registered Zod schema validates the body;
  failures return `400` with per-field `issues`.
- **RBAC** — with `ION_REQUIRE_AUTH=true`, invoking an action requires
  `update` on the `blocks` resource by default; a manifest declaration can
  override per action: `"rbac": { "resource": "invoices", "action": "manage" }`.
- **Errors** — `404` (block not installed / action not declared / handler not
  registered), `400` (validation), `504` (handler timeout, default 30s),
  `500` (handler threw; the message is the handler's error).
- **Observability** — every invocation emits a span (`action <block>.<name>`)
  and the `ion.action.invocations` / `ion.action.duration` metrics.

### Surface parity

Declared actions automatically appear:

- in **OpenAPI** (`/api/v1/openapi.json`) as one operation per action, request
  schema from the manifest's JSON-Schema `input`;
- as **MCP tools** named `<block>_<action>` — parameters mirror the handler's
  Zod object schema, so agents can call your business operations directly.

GraphQL mutations for actions are deferred (revisit with the GraphQL
relational work).

### Registering a handler (vendored code)

```ts
// blocks/invoicing/index.ts — yours to edit
import { definePlugin } from '@ion-drive/core';
import { z } from 'zod';

export default definePlugin({
  name: 'invoicing',
  setup(ctx) {
    ctx.actions.registerAction({
      block: 'invoicing',
      name: 'create_payment_link',
      input: z.object({ invoice_id: z.string().uuid() }),
      handler: async ({ input, dataService, secrets, config, logger, signal }) => {
        // Full platform context: CRUD, encrypted secrets, config, logging.
        return { ok: true };
      },
    });
  },
});
```

## Hooks (inbound webhooks)

```
GET|POST|PUT|PATCH|DELETE /api/v1/hooks/:block/:hook
```

Hooks receive third-party deliveries (Stripe, GitHub, …). Two deliberate
differences from every other endpoint:

- **Session-auth exempt** — providers can't log in; authenticity is the
  handler's job via provider signatures. The per-IP rate limiter still applies.
- **Raw body** — the handler receives the exact request bytes
  (`ctx.rawBody: Buffer`), because signature schemes sign them. Parse JSON only
  *after* verifying.

```ts
ctx.actions.registerHook({
  block: 'invoicing',
  name: 'stripe',
  handler: async ({ rawBody, headers, secrets, dataService }) => {
    const secret = await secrets.get('stripe_webhook_secret');
    if (!verifySignature(rawBody, headers['stripe-signature'], secret)) {
      return { status: 400, body: { error: 'invalid signature' } };
    }
    // …handle the event…
    return { status: 200, body: { received: true } }; // omitted → 200 {received:true}
  },
});
```

Hook deliveries emit `hook <block>.<name>` spans and `ion.hook.deliveries` /
`ion.hook.duration` metrics.

## Manifest declarations

```jsonc
{
  "actions": [
    {
      "name": "create_payment_link",
      "description": "Create a Stripe Checkout payment link for an invoice.",
      "input": { "type": "object", "properties": { "invoice_id": { "type": "string" } } },
      "rbac": { "resource": "blocks", "action": "update" }   // optional override
    }
  ],
  "hooks": [{ "name": "stripe", "description": "Stripe webhook receiver." }],
  "requires": {
    "handlers": ["some_bus_handler"],   // message-bus handlers that must exist
    "plugins": ["some-plugin"]          // plugins that must be loaded
  }
}
```

`GET /api/v1/blocks/actions` lists the declared surface plus every registered
handler — useful for debugging "declared but not registered" states (the CLI
polls it after vendoring code to detect the dev server's reload).
