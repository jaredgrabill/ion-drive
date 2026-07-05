/**
 * The official block registry — the catalog the CLI reads for `list`/`add`.
 *
 * This is the shadcn `registry.json` analog: a flat, self-contained index of
 * every bundled block plus a lightweight summary of each (for `ion-drive list`
 * without loading full manifests). The registry is deliberately kept out of
 * `@ionshift/ion-drive-core` so the runtime engine stays content-agnostic (ADR-013).
 */

import type { BlockManifestInput } from '@ionshift/ion-drive-core';
import { audit } from './blocks/audit.js';
import { communications } from './blocks/communications.js';
import { crm } from './blocks/crm.js';
import { invoicing } from './blocks/invoicing.js';

/** Every block bundled with Ion Drive, keyed by name. */
export const blocks = { crm, invoicing, communications, audit } as const;

/** Ordered list of all bundled block manifests. */
export const blockRegistry: BlockManifestInput[] = [crm, invoicing, communications, audit];

/** A compact, list-friendly summary of a block (no schema payload). */
export interface BlockSummary {
  name: string;
  title: string;
  description: string;
  version: string;
  author?: string;
  categories: string[];
  dependencies: string[];
  icon?: string;
  objectCount: number;
}

/** Derives the list summaries from the full manifests. */
export const blockSummaries: BlockSummary[] = blockRegistry.map((b) => ({
  name: b.name,
  title: b.title,
  description: b.description ?? '',
  version: b.version ?? '0.1.0',
  author: b.author,
  categories: b.categories ?? [],
  dependencies: b.dependencies ?? [],
  icon: (b.meta as { icon?: string } | undefined)?.icon,
  objectCount: b.objects?.length ?? 0,
}));

/** Looks up a bundled block manifest by name. */
export function getBlock(name: string): BlockManifestInput | undefined {
  return blockRegistry.find((b) => b.name === name);
}
