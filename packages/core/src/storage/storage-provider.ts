/**
 * Storage port (Phase 15 groundwork).
 *
 * Ion Drive reads/writes file blobs through the {@link StorageProvider}
 * interface. The default is the filesystem-backed {@link LocalStorage}; an
 * S3-compatible plugin (`@ion-drive/plugin-storage-s3`) replaces it by
 * registering under the same token (see ADR-015). Objects are addressed by a
 * `/`-separated key (e.g. `avatars/42/photo.png`); providers store bytes only —
 * rich metadata (original filename, content type, owning record) belongs in a
 * data object next to the key, which is where the Phase 15 `file` field type
 * will keep it.
 */

import type { Readable } from 'node:stream';
import { serviceToken } from '../runtime/service-registry.js';

/** Options for {@link StorageProvider.put}. */
export interface StoragePutOptions {
  /**
   * MIME type of the object. Providers that support it (S3) persist this on
   * the object; the local provider ignores it (callers keep it in metadata).
   */
  contentType?: string;
}

/** Descriptive metadata for a stored object. */
export interface StorageObjectInfo {
  /** The object's key (normalized, `/`-separated). */
  key: string;
  /** Size in bytes. */
  size: number;
  /** MIME type, when the provider persists one. */
  contentType?: string;
  /** Last-modified timestamp, when the provider tracks one. */
  lastModified?: Date;
}

/** A retrieved object: its metadata plus a byte stream. */
export interface StorageObject {
  info: StorageObjectInfo;
  /** The object's contents. Consume or destroy it — it holds a resource. */
  body: Readable;
}

/** Options for {@link StorageProvider.list}. */
export interface StorageListOptions {
  /** Only return objects whose key starts with this prefix. */
  prefix?: string;
  /** Maximum number of objects to return (default 1000). */
  limit?: number;
}

/** Options for {@link StorageProvider.getSignedUrl}. */
export interface StorageSignedUrlOptions {
  /** How long the URL stays valid (default 900 = 15 minutes). */
  expiresInSeconds?: number;
}

/** A pluggable blob store addressed by `/`-separated keys. */
export interface StorageProvider {
  /** The provider's name (for diagnostics/logging). */
  readonly name: string;

  /** Stores an object, replacing any existing one at `key`. */
  put(
    key: string,
    data: Uint8Array | Readable,
    options?: StoragePutOptions,
  ): Promise<StorageObjectInfo>;

  /** Retrieves an object, or `undefined` if absent. */
  get(key: string): Promise<StorageObject | undefined>;

  /** Returns an object's metadata without its body, or `undefined` if absent. */
  head(key: string): Promise<StorageObjectInfo | undefined>;

  /** Removes an object. Returns whether it existed. */
  delete(key: string): Promise<boolean>;

  /** Lists objects, lexicographically by key. */
  list(options?: StorageListOptions): Promise<StorageObjectInfo[]>;

  /**
   * Returns a pre-signed URL for direct client download, when the backend
   * supports it (S3-family). Providers without native signing omit this;
   * callers fall back to streaming through the server.
   */
  getSignedUrl?(key: string, options?: StorageSignedUrlOptions): Promise<string>;
}

/** Thrown for invalid keys or storage-layer failures callers should surface. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Validates and normalizes an object key. Keys are `/`-separated paths of
 * safe segments — no absolute paths, no `.`/`..` traversal, no backslashes,
 * no whitespace or control characters — so a filesystem provider can never be
 * walked out of its root and keys embed cleanly in URLs. Returns the
 * normalized key (leading/trailing slashes stripped).
 */
export function normalizeStorageKey(key: string): string {
  const trimmed = key.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) throw new StorageError('Storage key must not be empty');
  if (trimmed.length > 1024) throw new StorageError('Storage key exceeds 1024 characters');
  if (trimmed.includes('\\') || hasUnsafeCharacters(trimmed)) {
    throw new StorageError(`Storage key contains illegal characters: "${key}"`);
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new StorageError(`Storage key contains an illegal path segment: "${key}"`);
    }
  }
  return trimmed;
}

/** Whether the string contains spaces or ASCII control characters. */
function hasUnsafeCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Registry token for the platform blob store. */
export const STORAGE_SERVICE = serviceToken<StorageProvider>('storage');
