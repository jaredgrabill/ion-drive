/**
 * CRM building block — Contacts, Companies, Deals, and Activities.
 *
 * The canonical example block: a small but complete sales domain with
 * many-to-one relationships (a contact belongs to a company; a deal belongs to
 * both a company and its primary contact; activities hang off contacts and
 * deals) plus a `crm_agent` role and a disabled daily-digest task. Installing it
 * lights up REST/GraphQL/MCP CRUD for all four objects instantly.
 *
 * Authored as a typed object (`satisfies BlockManifestInput`) so the compiler
 * validates every column type and shape; `pnpm --filter @ionshift/ion-drive-blocks emit`
 * writes the distributable `blocks/crm/block.json` from this source.
 */

import type { BlockManifestInput } from '@ionshift/ion-drive-core';

export const crm = {
  $schema: 'https://ion-drive.dev/schema/block.json',
  name: 'crm',
  version: '0.1.0',
  title: 'CRM',
  description: 'Contacts, companies, deals, and activities — a lightweight sales pipeline.',
  author: 'Ion Shift Labs <hello@ionshiftlabs.com>',
  categories: ['sales', 'crm'],
  meta: { icon: '🪐', docs: 'https://ion-drive.dev/blocks/crm' },
  objects: [
    {
      name: 'companies',
      displayName: 'Companies',
      description: 'Organizations you sell to.',
      fields: [
        {
          name: 'name',
          displayName: 'Name',
          columnType: 'short_text',
          isRequired: true,
          isIndexed: true,
        },
        { name: 'website', displayName: 'Website', columnType: 'url' },
        {
          name: 'industry',
          displayName: 'Industry',
          columnType: 'enum',
          constraints: {
            enumValues: ['technology', 'finance', 'healthcare', 'retail', 'manufacturing', 'other'],
          },
        },
        { name: 'employee_count', displayName: 'Employees', columnType: 'integer' },
        { name: 'annual_revenue', displayName: 'Annual Revenue', columnType: 'currency' },
      ],
    },
    {
      name: 'contacts',
      displayName: 'Contacts',
      description: 'People at the companies you work with.',
      fields: [
        {
          name: 'first_name',
          displayName: 'First Name',
          columnType: 'short_text',
          isRequired: true,
        },
        { name: 'last_name', displayName: 'Last Name', columnType: 'short_text', isRequired: true },
        { name: 'email', displayName: 'Email', columnType: 'email', isUnique: true },
        { name: 'phone', displayName: 'Phone', columnType: 'phone' },
        { name: 'title', displayName: 'Job Title', columnType: 'short_text' },
      ],
    },
    {
      name: 'deals',
      displayName: 'Deals',
      description: 'Revenue opportunities moving through the pipeline.',
      fields: [
        { name: 'title', displayName: 'Title', columnType: 'short_text', isRequired: true },
        { name: 'amount', displayName: 'Amount', columnType: 'currency' },
        {
          name: 'stage',
          displayName: 'Stage',
          columnType: 'enum',
          defaultValue: 'lead',
          constraints: {
            enumValues: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
          },
        },
        { name: 'close_date', displayName: 'Expected Close', columnType: 'date' },
      ],
    },
    {
      name: 'activities',
      displayName: 'Activities',
      description: 'Calls, emails, meetings, and notes.',
      fields: [
        { name: 'subject', displayName: 'Subject', columnType: 'short_text', isRequired: true },
        {
          name: 'type',
          displayName: 'Type',
          columnType: 'enum',
          defaultValue: 'note',
          constraints: { enumValues: ['call', 'email', 'meeting', 'note'] },
        },
        { name: 'notes', displayName: 'Notes', columnType: 'long_text' },
        { name: 'due_date', displayName: 'Due Date', columnType: 'datetime' },
        {
          name: 'completed',
          displayName: 'Completed',
          columnType: 'boolean',
          defaultValue: 'false',
        },
      ],
    },
  ],
  relationships: [
    {
      name: 'company',
      displayName: 'Company',
      type: 'many_to_one',
      sourceObjectName: 'contacts',
      targetObjectName: 'companies',
    },
    {
      name: 'company',
      displayName: 'Company',
      type: 'many_to_one',
      sourceObjectName: 'deals',
      targetObjectName: 'companies',
    },
    {
      name: 'primary_contact',
      displayName: 'Primary Contact',
      type: 'many_to_one',
      sourceObjectName: 'deals',
      targetObjectName: 'contacts',
    },
    {
      name: 'contact',
      displayName: 'Contact',
      type: 'many_to_one',
      sourceObjectName: 'activities',
      targetObjectName: 'contacts',
    },
    {
      name: 'deal',
      displayName: 'Deal',
      type: 'many_to_one',
      sourceObjectName: 'activities',
      targetObjectName: 'deals',
    },
  ],
  seed: {
    companies: [
      {
        name: 'Orbital Dynamics',
        website: 'https://orbital.example',
        industry: 'technology',
        employee_count: 120,
      },
      {
        name: 'Nova Financial',
        website: 'https://nova.example',
        industry: 'finance',
        employee_count: 40,
      },
    ],
    contacts: [
      { first_name: 'Ada', last_name: 'Vega', email: 'ada@orbital.example', title: 'CTO' },
      { first_name: 'Milo', last_name: 'Reyes', email: 'milo@nova.example', title: 'Head of Ops' },
    ],
  },
  roles: [
    {
      name: 'crm_agent',
      description: 'Full read/write access to CRM objects; no platform administration.',
      permissions: [
        { resource: 'companies', actions: ['create', 'read', 'update', 'delete'] },
        { resource: 'contacts', actions: ['create', 'read', 'update', 'delete'] },
        { resource: 'deals', actions: ['create', 'read', 'update', 'delete'] },
        { resource: 'activities', actions: ['create', 'read', 'update', 'delete'] },
      ],
    },
  ],
  tasks: [
    {
      name: 'crm-daily-digest',
      description: 'Logs a daily CRM activity digest (disabled by default; enable and customise).',
      type: 'log',
      schedule: '0 8 * * *',
      enabled: false,
      config: { message: 'CRM daily digest' },
    },
  ],
} satisfies BlockManifestInput;
