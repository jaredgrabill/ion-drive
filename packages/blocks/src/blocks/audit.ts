/**
 * Audit building block — a durable change log for every data record.
 *
 * It declares one object (`audit_log`) and one event subscription: the `audit`
 * consumer group listens to `data.#` (every create/update/delete) and, via the
 * built-in `persist_event` handler, writes exactly one `audit_log` row per
 * change. Because `audit` is a single consumer group, only one row is written
 * per change even across multiple app instances (see ADR-015), and because the
 * handler writes through the event-suppressing path there is no audit-of-audit
 * recursion.
 *
 * This is the reference consumer proving the block-declared-subscription seam.
 * Authored as a typed object (`satisfies BlockManifestInput`) and emitted to
 * `blocks/audit/block.json` by `pnpm --filter @ionshift/ion-drive-blocks emit`.
 */

import type { BlockManifestInput } from '@ionshift/ion-drive-core';

export const audit = {
  $schema: 'https://ion-drive.dev/schema/block.json',
  name: 'audit',
  version: '0.1.0',
  title: 'Audit Log',
  description:
    'Records every record create/update/delete into an audit_log table, with a system-field-free diff.',
  author: 'Ion Shift Labs <hello@ionshiftlabs.com>',
  categories: ['observability', 'compliance'],
  meta: { icon: '🛰️', docs: 'https://ion-drive.dev/blocks/audit' },
  objects: [
    {
      name: 'audit_log',
      displayName: 'Audit Log',
      description: 'One row per data change, written by the audit event consumer.',
      fields: [
        {
          name: 'object_name',
          displayName: 'Object',
          columnType: 'short_text',
          isRequired: true,
          isIndexed: true,
        },
        { name: 'record_id', displayName: 'Record ID', columnType: 'uuid', isIndexed: true },
        {
          name: 'operation',
          displayName: 'Operation',
          columnType: 'enum',
          isIndexed: true,
          constraints: { enumValues: ['created', 'updated', 'deleted'] },
        },
        { name: 'diff', displayName: 'Diff', columnType: 'json' },
        { name: 'snapshot', displayName: 'Snapshot', columnType: 'json' },
        {
          name: 'event_id',
          displayName: 'Event ID',
          columnType: 'uuid',
          isUnique: true,
          isIndexed: true,
        },
        {
          name: 'changed_by',
          displayName: 'Changed By',
          columnType: 'short_text',
          // Actor identity is deferred (ADR-015); the column is present for forward-compat.
        },
      ],
    },
  ],
  subscriptions: [
    {
      event: 'data.#',
      consumer: 'audit',
      handler: 'persist_event',
      config: {
        object: 'audit_log',
        map: {
          object_name: 'payload.object',
          record_id: 'payload.id',
          operation: 'payload.op',
          diff: 'payload.diff',
          snapshot: 'payload.record',
          event_id: 'event.id',
        },
      },
    },
  ],
} satisfies BlockManifestInput;
