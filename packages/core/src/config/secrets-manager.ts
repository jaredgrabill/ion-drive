/**
 * Secrets Manager — encrypted secret storage in `_ion_secrets`.
 *
 * Values are encrypted with AES-256-GCM (see Encryptor) before they touch the
 * database and decrypted only on explicit read. Listing never returns plaintext
 * — only keys and metadata — so the admin UI can manage secrets without exposing
 * them.
 */

import { type Kysely, sql } from 'kysely';
import type { SystemDatabase } from '../db/types.js';
import type { Encryptor } from './encryption.js';

export interface SecretMetadata {
  key: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SecretsManager {
  constructor(
    private readonly db: Kysely<SystemDatabase>,
    private readonly encryptor: Encryptor,
  ) {}

  /** Encrypts and upserts a secret value. */
  async set(key: string, value: string, description?: string): Promise<void> {
    const encrypted = this.encryptor.encrypt(value);
    await this.db
      .insertInto('_ion_secrets')
      .values({ key, encrypted_value: encrypted, description: description ?? null })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          encrypted_value: encrypted,
          description: description ?? null,
          updated_at: sql`now()`,
        }),
      )
      .execute();
  }

  /** Decrypts and returns a secret value, or `undefined` if unset. */
  async get(key: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('_ion_secrets')
      .select('encrypted_value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row ? this.encryptor.decrypt(row.encrypted_value) : undefined;
  }

  /** Lists secret metadata only — never decrypted values. */
  async list(): Promise<SecretMetadata[]> {
    const rows = await this.db
      .selectFrom('_ion_secrets')
      .select(['key', 'description', 'created_at', 'updated_at'])
      .orderBy('key')
      .execute();
    return rows.map((r) => ({
      key: r.key,
      description: r.description,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Deletes a secret. Returns true if a row was removed. */
  async delete(key: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_secrets')
      .where('key', '=', key)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
