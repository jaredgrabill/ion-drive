/**
 * Unit tests for the MCP `list_blocks` tool (spec-04 surface parity): the
 * tool exists exactly when the block engine is wired, and returns the ledger
 * rows with their provenance fields. Runs a real MCP client/server pair over
 * the SDK's in-memory transport — no HTTP, no database (the ledger is faked).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { InstalledBlock } from '../blocks/block-types.js';
import type { DataService } from '../data/data-service.js';
import type { SchemaManager } from '../schema/schema-manager.js';
import { type McpServerOptions, createMcpServer } from './server.js';

/** Tool registration only dereferences services inside handlers — stubs suffice. */
const stubs = {
  schemaManager: {} as SchemaManager,
  dataService: {} as DataService,
};

const LEDGER: InstalledBlock[] = [
  {
    name: 'crm',
    version: '0.2.0',
    title: 'CRM',
    status: 'installed',
    createdObjects: ['contacts'],
    manifest: { name: 'crm' } as InstalledBlock['manifest'],
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    sourceRegistry: '@ion',
    sourceUrl: 'https://registry.iondrive.dev/crm/dist/0.2.0/block.json',
    publisher: 'github.com/jaredgrabill/ion-drive-blocks',
    attested: true,
    trustTier: 'official',
    installedAt: new Date('2026-07-08T00:00:00Z'),
    updatedAt: new Date('2026-07-08T00:00:00Z'),
  },
];

async function connect(options: McpServerOptions) {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('MCP list_blocks', () => {
  it('is registered when the block ledger is wired and returns provenance', async () => {
    const { client, server } = await connect({
      ...stubs,
      blocks: { listInstalled: async () => LEDGER },
    });
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('list_blocks');

      const result = await client.callTool({ name: 'list_blocks', arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      const rows = JSON.parse(text) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'crm',
        version: '0.2.0',
        status: 'installed',
        title: 'CRM',
        trustTier: 'official',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        publisher: 'github.com/jaredgrabill/ion-drive-blocks',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('is absent on headless setups without the block engine', async () => {
    const { client, server } = await connect(stubs);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).not.toContain('list_blocks');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
