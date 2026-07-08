/**
 * Filesystem storage — the default {@link StorageProvider}.
 *
 * Objects live as plain files under a root directory (`ION_STORAGE_DIR`,
 * default `.ion-storage/`), with the object key as the relative path. Keys are
 * validated by {@link normalizeStorageKey} before touching the filesystem, so
 * traversal out of the root is impossible. Writes go to a temp file in the
 * same directory and are renamed into place, so readers never observe a
 * half-written object. Content types are not persisted (filesystems have no
 * such attribute) — callers keep MIME metadata alongside the key.
 *
 * Suitable for single-node deployments; the S3 plugin replaces it when blobs
 * must be shared across instances or served via signed URLs.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type StorageListOptions,
  type StorageObject,
  type StorageObjectInfo,
  type StorageProvider,
  type StoragePutOptions,
  normalizeStorageKey,
} from './storage-provider.js';

const DEFAULT_LIST_LIMIT = 1000;

export class LocalStorage implements StorageProvider {
  readonly name = 'local';

  /** @param rootDir Directory holding all objects (created lazily on first write). */
  constructor(private readonly rootDir: string) {}

  async put(
    key: string,
    data: Uint8Array | Readable,
    _options?: StoragePutOptions,
  ): Promise<StorageObjectInfo> {
    const normalized = normalizeStorageKey(key);
    const target = this.pathFor(normalized);
    await mkdir(dirname(target), { recursive: true });

    // Write-then-rename so a concurrent read never sees a partial object.
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
      if (data instanceof Readable) {
        await pipeline(data, createWriteStream(temp));
      } else {
        await writeFile(temp, data);
      }
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }

    const stats = await stat(target);
    return { key: normalized, size: stats.size, lastModified: stats.mtime };
  }

  async get(key: string): Promise<StorageObject | undefined> {
    const info = await this.head(key);
    if (!info) return undefined;
    return { info, body: createReadStream(this.pathFor(info.key)) };
  }

  async head(key: string): Promise<StorageObjectInfo | undefined> {
    const normalized = normalizeStorageKey(key);
    try {
      const stats = await stat(this.pathFor(normalized));
      if (!stats.isFile()) return undefined;
      return { key: normalized, size: stats.size, lastModified: stats.mtime };
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<boolean> {
    const normalized = normalizeStorageKey(key);
    try {
      await rm(this.pathFor(normalized));
      return true;
    } catch {
      return false;
    }
  }

  async list(options?: StorageListOptions): Promise<StorageObjectInfo[]> {
    const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
    // S3-style semantics: a raw string prefix match on the key. The prefix
    // never touches the filesystem, so it needs no traversal validation.
    const prefix = options?.prefix?.replace(/^\/+/, '') ?? '';
    const results: StorageObjectInfo[] = [];

    let entries: string[];
    try {
      entries = await this.walk(this.rootDir);
    } catch {
      return []; // root not created yet — nothing stored
    }

    entries.sort();
    for (const key of entries) {
      if (prefix && !key.startsWith(prefix)) continue;
      if (results.length >= limit) break;
      const info = await this.head(key);
      if (info) results.push(info);
    }
    return results;
  }

  /** Absolute filesystem path for a normalized key. */
  private pathFor(normalizedKey: string): string {
    return join(this.rootDir, ...normalizedKey.split('/'));
  }

  /** Recursively collects object keys (relative paths, `/`-separated). */
  private async walk(dir: string): Promise<string[]> {
    const found: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.includes('.tmp-')) continue; // crash-orphaned partial write
      const absolute = join(entry.parentPath, entry.name);
      const key = relative(this.rootDir, absolute).split(sep).join(posix.sep);
      found.push(key);
    }
    return found;
  }
}
