/**
 * API Key Manager — issue and validate machine credentials.
 *
 * API keys let non-interactive clients (scripts, integrations, LLM agents)
 * authenticate without a session. Keys look like `iond_<prefix>_<secret>`; only
 * a SHA-256 hash is stored, so a leaked database never exposes usable keys. Keys
 * are high-entropy, so a fast hash is appropriate (unlike user passwords).
 *
 * A key may be bound to a `userId` (acts as that user) and/or a `roleId` (grants
 * that role's permissions) — RBAC resolves effective permissions from both.
 */

import { createHash, randomBytes } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { IonApiKey, SystemDatabase } from '../db/types.js';

export interface ApiKeyPrincipal {
  apiKeyId: string;
  userId: string | null;
  roleId: string | null;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  /** The full plaintext key — shown once, never stored. */
  key: string;
  prefix: string;
}

export interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  userId: string | null;
  roleId: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export class ApiKeyManager {
  constructor(private readonly db: Kysely<SystemDatabase>) {}

  /** Generates a new API key, storing only its hash. Returns the plaintext once. */
  async create(input: {
    name: string;
    userId?: string | null;
    roleId?: string | null;
    expiresAt?: Date | null;
  }): Promise<CreatedApiKey> {
    const prefix = randomBytes(4).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const key = `iond_${prefix}_${secret}`;

    const row = await this.db
      .insertInto('_ion_api_keys')
      .values({
        name: input.name,
        key_hash: hashKey(key),
        prefix,
        user_id: input.userId ?? null,
        role_id: input.roleId ?? null,
        expires_at: input.expiresAt ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { id: row.id, name: input.name, key, prefix };
  }

  /**
   * Validates a raw key. Returns the bound principal, or `null` if the key is
   * unknown or expired. Updates `last_used_at` on success.
   */
  async authenticate(rawKey: string): Promise<ApiKeyPrincipal | null> {
    if (!rawKey.startsWith('iond_')) return null;
    const row = await this.db
      .selectFrom('_ion_api_keys')
      .selectAll()
      .where('key_hash', '=', hashKey(rawKey))
      .executeTakeFirst();

    if (!row) return null;
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return null;

    await this.db
      .updateTable('_ion_api_keys')
      .set({ last_used_at: sql`now()` })
      .where('id', '=', row.id)
      .execute();

    return { apiKeyId: row.id, userId: row.user_id, roleId: row.role_id };
  }

  async list(): Promise<ApiKeyMetadata[]> {
    const rows = await this.db
      .selectFrom('_ion_api_keys')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toMetadata);
  }

  /** Revokes (deletes) a key. Returns true if a row was removed. */
  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('_ion_api_keys')
      .where('id', '=', id)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}

function toMetadata(row: IonApiKey): ApiKeyMetadata {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    userId: row.user_id,
    roleId: row.role_id,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
