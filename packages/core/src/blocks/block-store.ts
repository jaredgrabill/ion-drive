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
import type {
  BlockInstallSource,
  BlockManifest,
  BlockStatus,
  InstalledBlock,
} from './block-types.js';

/**
 * Creates the block ledger table if absent, then upgrades pre-existing
 * tables with columns added later ({@link migrateBlockTables}). Safe to call
 * repeatedly.
 */
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
    .addColumn('artifact_digest', 'text')
    .addColumn('source_registry', 'text')
    .addColumn('source_url', 'text')
    .addColumn('publisher', 'text')
    .addColumn('attested', 'boolean')
    .addColumn('trust_tier', 'text')
    .addColumn('installed_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(db.fn('now')))
    .execute();

  await migrateBlockTables(db);
}

/**
 * Boot migration for ledgers created before spec-04: the six nullable
 * provenance columns. Every statement is `ADD COLUMN IF NOT EXISTS` (the
 * `schema/system-tables.ts` pattern), so this is a no-op on fresh installs.
 */
async function migrateBlockTables(db: Kysely<SystemDatabase>): Promise<void> {
  await sql`ALTER TABLE "_ion_blocks" ADD COLUMN IF NOT EXISTS "artifact_digest" TEXT`.execute(db);
  await sql`ALTER TABLE "_ion_blocks" ADD COLUMN IF NOT EXISTS "source_registry" TEXT`.execute(db);
  await sql`ALTER TABLE "_ion_blocks" ADD COLUMN IF NOT EXISTS "source_url" TEXT`.execute(db);
  await sql`ALTER TABLE "_ion_blocks" ADD COLUMN IF NOT EXISTS "publisher" TEXT`.execute(db);
  await sql`ALTER TABLE "_ion_blocks" ADD COLUMN IF NOT EXISTS "attested" BOOLEAN`.execute(db);
  await sql`ALTER TABLE "_ion_blocks" ADD COLUMN IF NOT EXISTS "trust_tier" TEXT`.execute(db);
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
    artifactDigest: row.artifact_digest,
    sourceRegistry: row.source_registry,
    sourceUrl: row.source_url,
    publisher: row.publisher,
    attested: row.attested,
    trustTier: row.trust_tier,
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
   *
   * The optional `source` envelope writes the spec-04 provenance columns —
   * in the upsert branch too, so a bare reinstall RESETS them to null
   * (correct for client-asserted metadata: stale provenance would be a lie).
   * Note a *failed* install keeps the asserted source on its `failed` row —
   * desirable for the "which servers touched the bad digest?" question.
   */
  async begin(manifest: BlockManifest, source?: BlockInstallSource): Promise<void> {
    const provenance = provenanceColumns(source);
    await this.db
      .insertInto('_ion_blocks')
      .values({
        name: manifest.name,
        version: manifest.version,
        title: manifest.title,
        status: 'installing',
        created_objects: JSON.stringify([]),
        manifest: JSON.stringify(manifest),
        ...provenance,
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          version: manifest.version,
          title: manifest.title,
          status: 'installing',
          created_objects: JSON.stringify([]),
          manifest: JSON.stringify(manifest),
          ...provenance,
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

  /**
   * Flips ONLY the lifecycle status (spec-07 upgrade semantics). Upgrades run
   * begin-with-old/finish-with-new: `setStatus('installing')` guards
   * concurrency while the PRIOR version + manifest snapshot stay in the row,
   * so an upgrade failure (`setStatus('failed')`) leaves the diff anchor and
   * ownership intact and a re-run recomputes the same delta (AC4). Contrast
   * with {@link begin}, whose upsert replaces the snapshot up front — correct
   * for plain installs, where the incoming manifest IS the truth.
   */
  async setStatus(name: string, status: BlockStatus): Promise<void> {
    await this.db
      .updateTable('_ion_blocks')
      .set({ status, updated_at: sql`now()` })
      .where('name', '=', name)
      .execute();
  }

  /**
   * Finishes a SUCCESSFUL upgrade: replaces version/title/manifest snapshot +
   * provenance and marks the row installed with the merged ownership list.
   * Only reached after the installer completed — a failed upgrade never gets
   * here, keeping the prior snapshot as the re-run baseline.
   */
  async replaceInstalled(
    manifest: BlockManifest,
    createdObjects: string[],
    source?: BlockInstallSource,
  ): Promise<void> {
    await this.db
      .updateTable('_ion_blocks')
      .set({
        version: manifest.version,
        title: manifest.title,
        status: 'installed',
        created_objects: JSON.stringify(createdObjects),
        manifest: JSON.stringify(manifest),
        ...provenanceColumns(source),
        updated_at: sql`now()`,
      })
      .where('name', '=', manifest.name)
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

/**
 * The spec-04 provenance columns from a client-asserted source envelope.
 * Absent fields write null — stale provenance would be a lie.
 */
function provenanceColumns(source?: BlockInstallSource) {
  return {
    artifact_digest: source?.digest ?? null,
    source_registry: source?.registry ?? null,
    source_url: source?.url ?? null,
    publisher: source?.publisher ?? null,
    attested: source?.attested ?? null,
    trust_tier: source?.tier ?? null,
  };
}
