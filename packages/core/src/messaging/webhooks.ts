/**
 * Outbound webhooks (Phase 12 / ADR-019) — push bus events to external URLs.
 *
 * A webhook is persisted config (`_ion_webhooks`, tenant DB) that the
 * {@link WebhookManager} projects onto the message bus as subscriptions with
 * consumer group `webhook:<id>` and the built-in `webhook` handler. Riding the
 * dispatcher means webhooks inherit, with no extra machinery: at-most-once
 * per webhook across instances, the retry budget with exponential backoff,
 * the delivery ledger as their delivery log (visible in the DLQ surface at
 * `/api/v1/events/deliveries?consumer=webhook:<id>`), and `ion.event.*`
 * metrics/spans per attempt.
 *
 * Payloads are signed Stripe-style — `x-ion-signature: t=<unix>,v1=<hmac>`
 * where the HMAC-SHA256 covers `"<t>.<raw body>"` — the same scheme the
 * invoicing block's `verifyStripeSignature` demonstrates for inbound hooks.
 * Signing secrets are generated server-side (`whsec_…`), stored encrypted
 * with the platform {@link Encryptor}, and revealed once on creation.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { Encryptor } from '../config/encryption.js';
import type { TenantDatabase } from '../db/types.js';
import type { LoggerProvider } from '../logging/logger-provider.js';
import type { BusHandler } from './event-types.js';
import type { MessageBus } from './message-bus.js';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** A stored webhook (secret always encrypted; decrypt only at delivery). */
export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  topics: string[];
  headers: Record<string, string>;
  enabled: boolean;
  secretEncrypted: string;
  managedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The API-facing shape: no secret material. */
export type WebhookView = Omit<WebhookRow, 'secretEncrypted'>;

export interface WebhookInput {
  name: string;
  url: string;
  topics: string[];
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Provenance — 'user' (default) or 'block:<name>' for installer-created hooks. */
  managedBy?: string;
}

/** Creates the `_ion_webhooks` table if absent. Safe to call repeatedly. */
export async function bootstrapWebhookTable(db: Kysely<TenantDatabase>): Promise<void> {
  await db.schema
    .createTable('_ion_webhooks')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('url', 'text', (col) => col.notNull())
    .addColumn('topics', 'jsonb', (col) => col.notNull().defaultTo('[]'))
    .addColumn('headers', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('secret_encrypted', 'text', (col) => col.notNull())
    .addColumn('managed_by', 'varchar(255)', (col) => col.notNull().defaultTo('user'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();
}

/** Maps a raw (untyped, ADR-002) tenant-db row onto the typed shape. */
function rowFromDb(raw: unknown): WebhookRow {
  const row = raw as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    topics: Array.isArray(row.topics)
      ? (row.topics as string[])
      : (JSON.parse(String(row.topics ?? '[]')) as string[]),
    headers:
      typeof row.headers === 'object' && row.headers !== null
        ? (row.headers as Record<string, string>)
        : {},
    enabled: Boolean(row.enabled),
    secretEncrypted: String(row.secret_encrypted),
    managedBy: String(row.managed_by),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export class WebhookStore {
  constructor(private readonly db: Kysely<TenantDatabase>) {}

  async list(): Promise<WebhookRow[]> {
    const rows = await this.db.selectFrom('_ion_webhooks').selectAll().orderBy('name').execute();
    return rows.map(rowFromDb);
  }

  async getById(id: string): Promise<WebhookRow | null> {
    const row = await this.db
      .selectFrom('_ion_webhooks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowFromDb(row) : null;
  }

  async getByName(name: string): Promise<WebhookRow | null> {
    const row = await this.db
      .selectFrom('_ion_webhooks')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    return row ? rowFromDb(row) : null;
  }

  async insert(input: WebhookInput & { id: string; secretEncrypted: string }): Promise<WebhookRow> {
    const row = await this.db
      .insertInto('_ion_webhooks')
      .values({
        id: input.id,
        name: input.name,
        url: input.url,
        topics: JSON.stringify(input.topics),
        headers: JSON.stringify(input.headers ?? {}),
        enabled: input.enabled ?? true,
        secret_encrypted: input.secretEncrypted,
        managed_by: input.managedBy ?? 'user',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowFromDb(row);
  }

  async update(id: string, patch: Partial<WebhookInput>): Promise<WebhookRow | null> {
    const values: Record<string, unknown> = { updated_at: sql`now()` };
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.url !== undefined) values.url = patch.url;
    if (patch.topics !== undefined) values.topics = JSON.stringify(patch.topics);
    if (patch.headers !== undefined) values.headers = JSON.stringify(patch.headers);
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    const row = await this.db
      .updateTable('_ion_webhooks')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row ? rowFromDb(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_webhooks')
      .where('id', '=', id)
      .returning('id')
      .execute();
    return result.length > 0;
  }

  async removeByManagedBy(managedBy: string): Promise<string[]> {
    const rows = await this.db
      .deleteFrom('_ion_webhooks')
      .where('managed_by', '=', managedBy)
      .returning('id')
      .execute();
    return rows.map((r) => String((r as Record<string, unknown>).id));
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Header carrying the signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-ion-signature';

/** Computes the `t=<unix>,v1=<hex hmac>` signature over `"<t>.<body>"`. */
export function signWebhookPayload(secret: string, body: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

/** Generates a fresh signing secret (`whsec_` + 192 bits of entropy). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Manager — projects stored webhooks onto the bus
// ---------------------------------------------------------------------------

/** Consumer-group prefix; the ledger's rows for a webhook carry this. */
export const WEBHOOK_CONSUMER_PREFIX = 'webhook:';

/** The registered bus-handler name. */
export const WEBHOOK_HANDLER_NAME = 'webhook';

export interface WebhookManagerOptions {
  store: WebhookStore;
  bus: MessageBus;
  encryptor: Encryptor;
  logger: LoggerProvider;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
}

/** The result of a create: the stored view plus the once-only plaintext secret. */
export interface CreatedWebhook {
  webhook: WebhookView;
  /** Shown exactly once; only the encrypted form is stored. */
  secret: string;
}

export class WebhookManager {
  private readonly store: WebhookStore;
  private readonly bus: MessageBus;
  private readonly encryptor: Encryptor;
  private readonly logger: LoggerProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WebhookManagerOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.encryptor = options.encryptor;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Registers the `webhook` handler and every enabled webhook's subscriptions. */
  async initialize(): Promise<void> {
    this.bus.registerHandler(this.createHandler());
    for (const webhook of await this.store.list()) {
      if (webhook.enabled) this.register(webhook);
    }
  }

  async list(): Promise<WebhookView[]> {
    return (await this.store.list()).map(toView);
  }

  async getById(id: string): Promise<WebhookView | null> {
    const row = await this.store.getById(id);
    return row ? toView(row) : null;
  }

  async getByName(name: string): Promise<WebhookView | null> {
    const row = await this.store.getByName(name);
    return row ? toView(row) : null;
  }

  /** Creates a webhook and registers it on the bus. Returns the secret once. */
  async create(input: WebhookInput): Promise<CreatedWebhook> {
    if (await this.store.getByName(input.name)) {
      throw new WebhookError(`A webhook named "${input.name}" already exists`, 'conflict');
    }
    const secret = generateWebhookSecret();
    const row = await this.store.insert({
      ...input,
      id: randomUUID(),
      secretEncrypted: this.encryptor.encrypt(secret),
    });
    if (row.enabled) this.register(row);
    return { webhook: toView(row), secret };
  }

  async update(id: string, patch: Partial<WebhookInput>): Promise<WebhookView | null> {
    const row = await this.store.update(id, patch);
    if (!row) return null;
    this.bus.unsubscribeConsumer(`${WEBHOOK_CONSUMER_PREFIX}${row.id}`);
    if (row.enabled) this.register(row);
    return toView(row);
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.store.remove(id);
    if (removed) this.bus.unsubscribeConsumer(`${WEBHOOK_CONSUMER_PREFIX}${id}`);
    return removed;
  }

  /** Removes every webhook a block installed (uninstall path). */
  async removeByManagedBy(managedBy: string): Promise<number> {
    const ids = await this.store.removeByManagedBy(managedBy);
    for (const id of ids) this.bus.unsubscribeConsumer(`${WEBHOOK_CONSUMER_PREFIX}${id}`);
    return ids.length;
  }

  /**
   * Publishes a `webhook.test.<id>` event that only this webhook's consumer
   * group subscribes to (wired in {@link register}), exercising the full
   * delivery path — sign → POST → ledger. Requires the webhook be enabled.
   */
  async sendTest(id: string): Promise<boolean> {
    const row = await this.store.getById(id);
    if (!row || !row.enabled) return false;
    await this.bus.publish({
      topic: `webhook.test.${row.id}`,
      payload: { message: 'Ion Drive webhook test', webhook: row.name },
    });
    return true;
  }

  /**
   * One bus subscription per topic pattern — the shared consumer group dedupes
   * an event matching several patterns — plus the private test topic.
   */
  private register(webhook: WebhookRow): void {
    for (const topic of [...webhook.topics, `webhook.test.${webhook.id}`]) {
      this.bus.subscribe({
        topic,
        consumer: `${WEBHOOK_CONSUMER_PREFIX}${webhook.id}`,
        handler: WEBHOOK_HANDLER_NAME,
        config: { webhookId: webhook.id },
        source: `webhook:${webhook.name}`,
      });
    }
  }

  /**
   * The delivery handler. Loads the webhook fresh per attempt (URL edits and
   * disables take effect immediately), signs the envelope, POSTs it under the
   * dispatcher's abort signal, and throws on non-2xx so the ledger records the
   * failure and schedules a backed-off retry.
   */
  private createHandler(): BusHandler {
    return {
      name: WEBHOOK_HANDLER_NAME,
      description: 'Delivers the event to a configured webhook URL (HMAC-signed).',
      handle: async (ctx) => {
        const webhookId = (ctx.subscription.config as { webhookId?: string } | undefined)
          ?.webhookId;
        if (!webhookId) throw new Error('webhook handler requires config.webhookId');
        const webhook = await this.store.getById(webhookId);
        if (!webhook || !webhook.enabled) {
          // Deleted/disabled between claim and delivery — drop silently.
          this.logger.debug('Skipping delivery to missing/disabled webhook', { webhookId });
          return;
        }

        const body = JSON.stringify(ctx.event);
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await this.fetchImpl(webhook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'ion-drive-webhook',
            [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(
              this.encryptor.decrypt(webhook.secretEncrypted),
              body,
              timestamp,
            ),
            'x-ion-event-id': ctx.event.id,
            'x-ion-topic': ctx.event.topic,
            ...webhook.headers,
          },
          body,
          signal: ctx.signal,
        });
        if (!response.ok) {
          throw new Error(`Webhook responded ${response.status} ${response.statusText}`);
        }
      },
    };
  }
}

function toView(row: WebhookRow): WebhookView {
  const { secretEncrypted: _secret, ...view } = row;
  return view;
}

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly code: 'conflict' | 'validation',
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}
