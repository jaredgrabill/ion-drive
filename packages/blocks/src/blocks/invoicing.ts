/**
 * Invoicing building block — Invoices, Line Items, and Payments.
 *
 * Depends on the {@link crm} block: an invoice belongs to a CRM `companies`
 * record, so `crm` must be installed first. This is the block-level dependency
 * graph (the shadcn `registryDependencies` analog) — the engine refuses to
 * install `invoicing` until `crm` is present, and refuses to uninstall `crm`
 * while `invoicing` still depends on it.
 */

import type { BlockManifestInput } from '@ionshift/ion-drive-core';

export const invoicing = {
  $schema: 'https://ion-drive.dev/schema/block.json',
  name: 'invoicing',
  version: '0.1.0',
  title: 'Invoicing',
  description: 'Invoices, line items, and payments — billing on top of your CRM.',
  author: 'Ion Shift Labs <hello@ionshiftlabs.com>',
  categories: ['finance', 'billing'],
  dependencies: ['crm'],
  meta: { icon: '🧾', docs: 'https://ion-drive.dev/blocks/invoicing' },
  objects: [
    {
      name: 'invoices',
      displayName: 'Invoices',
      description: 'Bills issued to companies.',
      fields: [
        {
          name: 'number',
          displayName: 'Invoice #',
          columnType: 'short_text',
          isRequired: true,
          isUnique: true,
        },
        {
          name: 'status',
          displayName: 'Status',
          columnType: 'enum',
          defaultValue: 'draft',
          constraints: { enumValues: ['draft', 'sent', 'paid', 'overdue', 'void'] },
        },
        { name: 'issue_date', displayName: 'Issue Date', columnType: 'date' },
        { name: 'due_date', displayName: 'Due Date', columnType: 'date' },
        { name: 'subtotal', displayName: 'Subtotal', columnType: 'currency' },
        { name: 'tax', displayName: 'Tax', columnType: 'currency' },
        { name: 'total', displayName: 'Total', columnType: 'currency' },
        { name: 'notes', displayName: 'Notes', columnType: 'long_text' },
      ],
    },
    {
      name: 'line_items',
      displayName: 'Line Items',
      description: 'Individual charges on an invoice.',
      fields: [
        {
          name: 'description',
          displayName: 'Description',
          columnType: 'short_text',
          isRequired: true,
        },
        { name: 'quantity', displayName: 'Quantity', columnType: 'decimal', defaultValue: '1' },
        { name: 'unit_price', displayName: 'Unit Price', columnType: 'currency' },
        { name: 'amount', displayName: 'Amount', columnType: 'currency' },
      ],
    },
    {
      name: 'payments',
      displayName: 'Payments',
      description: 'Money received against invoices.',
      fields: [
        { name: 'amount', displayName: 'Amount', columnType: 'currency', isRequired: true },
        {
          name: 'method',
          displayName: 'Method',
          columnType: 'enum',
          constraints: { enumValues: ['card', 'bank_transfer', 'cash', 'check'] },
        },
        { name: 'paid_at', displayName: 'Paid At', columnType: 'datetime' },
        { name: 'reference', displayName: 'Reference', columnType: 'short_text' },
      ],
    },
  ],
  relationships: [
    {
      name: 'company',
      displayName: 'Company',
      type: 'many_to_one',
      sourceObjectName: 'invoices',
      targetObjectName: 'companies',
    },
    {
      name: 'invoice',
      displayName: 'Invoice',
      type: 'many_to_one',
      sourceObjectName: 'line_items',
      targetObjectName: 'invoices',
      cascadeDelete: true,
    },
    {
      name: 'invoice',
      displayName: 'Invoice',
      type: 'many_to_one',
      sourceObjectName: 'payments',
      targetObjectName: 'invoices',
    },
  ],
  roles: [
    {
      name: 'billing_clerk',
      description: 'Manage invoices, line items, and payments.',
      permissions: [
        { resource: 'invoices', actions: ['create', 'read', 'update', 'delete'] },
        { resource: 'line_items', actions: ['create', 'read', 'update', 'delete'] },
        { resource: 'payments', actions: ['create', 'read', 'update', 'delete'] },
      ],
    },
  ],
} satisfies BlockManifestInput;
