/**
 * Block install ledger — persistence for installed building blocks (Phase 6).
 *
 * `_ion_blocks` records exactly which blocks are installed, the manifest
 * snapshot as applied (so the consumer owns their copy — ADR-006), and the list
 * of objects the block created so an uninstall can drop precisely those tables.
 *
 * {@link bootstrapBlockTables} creates the table (idempotent, `IF NOT EXISTS`).
 * The store is a thin, typed data-access layer over Kysely; orchestration lives
 * in {@link BlockEngine} / {@link BlockInstaller}.
 */

import { type Kysely, sql } from 'kysely';
import type { IonBlock, SystemDatabase } from '../db/types.js';
import type { BlockManifest, BlockStatus, InstalledBlock } from './block-types.js';

/** Creates the block ledger table if absent. Safe to call repeatedly. */
export async function bootstrapBlockTables(db: Kysely<SystemDatabase>): Promise<void> {
  await db.schema
    .createTable('_ion_blocks')
    .ifNotExists()
    .addColumn('name', 'varchar(64)', (col) => col.primaryKey())
    .addColumn('version', 'varchar(32)', (col) => col.notNull())
    .addColumn('title', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(20)', (col) => col.notNull())
    .addColumn('created_objects', 'jsonb', (col) => col.notNull().defaultTo('[]'))
    .addColumn('manifest', 'jsonb', (col) => col.notNull().defaultTo('{}'))
    .addColumn('installed_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();
}

/** Maps a raw ledger row to the API-facing {@link InstalledBlock}. */
function toInstalledBlock(row: IonBlock): InstalledBlock {
  return {
    name: row.name,
    version: row.version,
    title: row.title,
    status: row.status as BlockStatus,
    createdObjects: row.created_objects ?? [],
    manifest: row.manifest as unknown as BlockManifest,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

export class BlockStore {
  constructor(private readonly db: Kysely<SystemDatabase>) {}

  async list(): Promise<InstalledBlock[]> {
    const rows = await this.db.selectFrom('_ion_blocks').selectAll().orderBy('name').execute();
    return rows.map(toInstalledBlock);
  }

  async getByName(name: string): Promise<InstalledBlock | undefined> {
    const row = await this.db
      .selectFrom('_ion_blocks')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    return row ? toInstalledBlock(row) : undefined;
  }

  /** Names of all fully-installed blocks (used for dependency checks). */
  async listInstalledNames(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('_ion_blocks')
      .select('name')
      .where('status', '=', 'installed')
      .execute();
    return new Set(rows.map((r) => r.name));
  }

  /**
   * Name → version of every fully-installed block, in one query — the input
   * to `evaluateDependencies` (spec-02's dependency-range check).
   */
  async listInstalledVersions(): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('_ion_blocks')
      .select(['name', 'version'])
      .where('status', '=', 'installed')
      .execute();
    return new Map(rows.map((r) => [r.name, r.version]));
  }

  /**
   * Records the start of an install (status `installing`). Upserts so a retried
   * install of a previously-failed block overwrites the stale row.
   */
  async begin(manifest: BlockManifest): Promise<void> {
    await this.db
      .insertInto('_ion_blocks')
      .values({
        name: manifest.name,
        version: manifest.version,
        title: manifest.title,
        status: 'installing',
        created_objects: JSON.stringify([]),
        manifest: JSON.stringify(manifest),
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          version: manifest.version,
          title: manifest.title,
          status: 'installing',
          created_objects: JSON.stringify([]),
          manifest: JSON.stringify(manifest),
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Marks a block install finished with the given status and created objects. */
  async finish(name: string, status: BlockStatus, createdObjects: string[]): Promise<void> {
    await this.db
      .updateTable('_ion_blocks')
      .set({
        status,
        created_objects: JSON.stringify(createdObjects),
        updated_at: sql`now()`,
      })
      .where('name', '=', name)
      .execute();
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_blocks')
      .where('name', '=', name)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
