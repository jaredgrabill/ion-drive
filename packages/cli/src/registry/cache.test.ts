/**
 * Unit tests for the per-registry disk cache: sha256 filenames, the 5-min
 * TTL, per-block entries, corrupt-file = miss, the one-shot legacy
 * single-file unlink, and the hard rule that auth material never reaches the
 * written bytes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CACHE_TTL_MS,
  cacheFilePath,
  readCachedBlock,
  readCachedIndex,
  resetLegacyUnlink,
  writeCachedBlock,
  writeCachedIndex,
} from './cache.js';

const REG_URL = 'https://reg.test/registry/index.json';

let root: string;
let cacheDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-cache-'));
  cacheDir = join(root, 'registry-cache');
  resetLegacyUnlink();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('registry cache', () => {
  it('names the file sha256(registryUrl).json', () => {
    const expected = `${createHash('sha256').update(REG_URL).digest('hex')}.json`;
    expect(cacheFilePath(REG_URL, cacheDir)).toBe(join(cacheDir, expected));
  });

  it('round-trips the index within the TTL and expires after it', () => {
    let clock = 1_000_000;
    const now = () => clock;
    writeCachedIndex(REG_URL, { schemaVersion: 1, name: 'X' }, { cacheDir, now });
    expect(readCachedIndex(REG_URL, { cacheDir, now })).toEqual({ schemaVersion: 1, name: 'X' });

    clock += CACHE_TTL_MS + 1;
    expect(readCachedIndex(REG_URL, { cacheDir, now })).toBeNull();
  });

  it('stores per-block entries with their own fetchedAt', () => {
    let clock = 0;
    const now = () => clock;
    writeCachedIndex(REG_URL, { name: 'X' }, { cacheDir, now });
    clock = CACHE_TTL_MS; // index now stale…
    writeCachedBlock(REG_URL, 'crm', { latest: '0.2.0' }, { cacheDir, now });
    clock = CACHE_TTL_MS + 1;
    expect(readCachedIndex(REG_URL, { cacheDir, now })).toBeNull();
    expect(readCachedBlock(REG_URL, 'crm', { cacheDir, now })).toEqual({ latest: '0.2.0' }); // …block fresh
    expect(readCachedBlock(REG_URL, 'unknown', { cacheDir, now })).toBeNull();
  });

  it('treats a corrupt cache file as a miss, then recovers on write', () => {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFilePath(REG_URL, cacheDir), 'not json{{{', 'utf8');
    expect(readCachedIndex(REG_URL, { cacheDir })).toBeNull();
    writeCachedIndex(REG_URL, { name: 'ok' }, { cacheDir });
    expect(readCachedIndex(REG_URL, { cacheDir })).toEqual({ name: 'ok' });
  });

  it('never serializes auth material — only the fetched documents', () => {
    // The cache API only accepts documents; simulate a full realistic write
    // and assert the token that authenticated the fetch is absent on disk.
    const token = 'super-secret-registry-token-1234567890';
    writeCachedIndex(REG_URL, { name: 'Private', blocks: {} }, { cacheDir });
    writeCachedBlock(REG_URL, 'billing', { latest: '1.0.0' }, { cacheDir });
    const bytes = readFileSync(cacheFilePath(REG_URL, cacheDir), 'utf8');
    expect(bytes).not.toContain(token);
    expect(bytes).not.toContain('authorization');
    expect(bytes).not.toContain('headers');
  });

  it('unlinks the legacy single-file cache on the first write (C3)', () => {
    const legacy = join(root, 'registry-cache.json'); // dirname(cacheDir)/registry-cache.json
    writeFileSync(legacy, '{"url":"old"}', 'utf8');
    writeCachedIndex(REG_URL, { name: 'X' }, { cacheDir });
    expect(existsSync(legacy)).toBe(false);
  });
});
