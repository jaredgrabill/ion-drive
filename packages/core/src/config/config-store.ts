/**
 * Config Store — persistent platform configuration key/value store.
 *
 * Holds non-secret runtime configuration in `_ion_config` (JSONB values). For
 * sensitive values (API tokens, passwords) use the SecretsManager instead, which
 * encrypts at rest.
 */

import { type Kysely, sql } from 'kysely';
import type { IonConfig, SystemDatabase } from '../db/types.js';

export class ConfigStore {
  constructor(private readonly db: Kysely<SystemDatabase>) {}

  /** Returns a single config value, or `undefined` if unset. */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db
      .selectFrom('_ion_config')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row ? (row.value as T) : undefined;
  }

  /** Lists all config entries (non-secret). */
  async list(): Promise<IonConfig[]> {
    return this.db.selectFrom('_ion_config').selectAll().orderBy('key').execute();
  }

  /** Upserts a config value. */
  async set(key: string, value: unknown, description?: string): Promise<void> {
    const json = JSON.stringify(value);
    await this.db
      .insertInto('_ion_config')
      .values({ key, value: json, description: description ?? null })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: json,
          description: description ?? null,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Deletes a config entry. Returns true if a row was removed. */
  async delete(key: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_config')
      .where('key', '=', key)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
