/**
 * @module @ionshift/ion-drive-blocks
 *
 * Ion Drive's official building blocks — ready-made business domains distributed
 * shadcn-style. Consumers (the CLI, tests, or the admin console) import the
 * catalog here; a running Ion Drive instance never depends on this package —
 * blocks are *submitted* to it as manifests. See ADR-013.
 */

export { crm } from './blocks/crm.js';
export { invoicing } from './blocks/invoicing.js';
export { communications } from './blocks/communications.js';
export {
  blocks,
  blockRegistry,
  blockSummaries,
  getBlock,
  type BlockSummary,
} from './registry.js';
