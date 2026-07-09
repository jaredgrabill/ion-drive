/**
 * Registry MCP server (spec-08 §4) — the SDK wrapper over the transport-free
 * handlers in `handlers.ts`.
 *
 * Registers the four registry tools on an `McpServer` with Zod input shapes
 * (Zod is confined to this module — the handlers stay SDK- and Zod-free).
 * Every result is one JSON text content block; the registry layer's typed
 * errors (`RegistryError`, `ResolveError`, `RefError`, `ConfigError`,
 * `IntegrityError`, `ApiError`) surface as MCP tool errors with their
 * friendly messages instead of crashing the server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiError } from '../api-client.js';
import { ConfigError } from '../config.js';
import { RefError } from '../registry/ref.js';
import { RegistryError } from '../registry/registry-client.js';
import { ResolveError } from '../registry/resolver.js';
import { IntegrityError } from '../registry/verify.js';
import { CLI_VERSION } from '../version-check.js';
import { type RegistryMcpDeps, createRegistryMcpHandlers } from './handlers.js';

/** The one MCP result shape we emit: a single JSON text content block. */
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Wraps a handler so known typed errors come back as MCP tool errors with
 * their actionable messages; anything unknown rethrows (a real bug should
 * crash loudly, not masquerade as a tool result).
 */
async function guarded(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return jsonResult(await run());
  } catch (err) {
    if (
      err instanceof RegistryError ||
      err instanceof ResolveError ||
      err instanceof RefError ||
      err instanceof ConfigError ||
      err instanceof IntegrityError ||
      err instanceof ApiError
    ) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    throw err;
  }
}

/** Builds the registry MCP server (stdio transport attached by `commands/mcp.ts`). */
export function createRegistryMcpServer(deps: RegistryMcpDeps = {}): McpServer {
  const handlers = createRegistryMcpHandlers(deps);

  const server = new McpServer({ name: 'ion-drive-registry', version: CLI_VERSION });

  server.tool(
    'search_blocks',
    'Search a block registry by term (matched against name, title, description, categories). ' +
      "Uses the registry's prebuilt search index when advertised, else substring fallback.",
    {
      term: z.string().min(1).describe('Search term (case-insensitive substring)'),
      registry: z
        .string()
        .optional()
        .describe('Registry namespace like "@acme" (default: the project\'s default registry)'),
    },
    (args) => guarded(() => handlers.search_blocks(args)),
  );

  server.tool(
    'get_block',
    "Fetch one block's registry document: full version history with digests, dependencies, " +
      'status, and advisories — plus its README inlined when the registry publishes one.',
    {
      name: z.string().min(1).describe('Block name, e.g. "invoicing"'),
      registry: z
        .string()
        .optional()
        .describe('Registry namespace like "@acme" (default: the project\'s default registry)'),
    },
    (args) => guarded(() => handlers.get_block(args)),
  );

  server.tool(
    'list_registries',
    'List every registry configured for this project (namespace, URL, block count, freshness). ' +
      'Unreachable registries appear as error rows.',
    {},
    () => guarded(() => handlers.list_registries()),
  );

  server.tool(
    'preview_install',
    'Dry-resolve a block ref ("crm", "crm@^0.2.0", "@acme/billing@1.x") through the full ' +
      'install pipeline: dependency closure, digest verification, and client-computed trust ' +
      'tiers — exactly what `ion-drive add` would install. NEVER makes changes.',
    {
      ref: z.string().min(1).describe('Block ref: name[@selector], @ns/name[@selector], or a URL'),
    },
    (args) => guarded(() => handlers.preview_install(args)),
  );

  return server;
}
