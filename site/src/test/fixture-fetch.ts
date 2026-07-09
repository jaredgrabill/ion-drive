/**
 * Test helper — a `fetch` stub that serves the protocol-v1 fixture registry
 * tree from `src/test/fixtures/` at `http://localhost:8765/…`, exactly the
 * URL space the live fixture server uses for the manual review pass.
 * Per-test overrides inject failures ('offline'), non-200s, or replacement
 * JSON bodies for individual paths.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export const FIXTURE_ORIGIN = 'http://localhost:8765';
export const FIXTURE_INDEX_URL = `${FIXTURE_ORIGIN}/registry/index.json`;

const FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export type FixtureOverride = 'offline' | { status: number } | { body: unknown };

function makeResponse(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/**
 * Installs the stub via `vi.stubGlobal`. Paths are origin-relative
 * (`/registry/index.json`). Restore with `vi.unstubAllGlobals()`.
 */
export function installFixtureFetch(overrides: Record<string, FixtureOverride> = {}): void {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const parsed = new URL(url);
    const override = overrides[parsed.pathname];
    if (override === 'offline') throw new TypeError('fetch failed');
    if (override !== undefined && 'status' in override) return makeResponse(override.status, '');
    if (override !== undefined && 'body' in override) {
      return makeResponse(200, JSON.stringify(override.body));
    }
    const file = path.join(FIXTURE_ROOT, ...parsed.pathname.split('/').filter(Boolean));
    try {
      return makeResponse(200, readFileSync(file, 'utf8'));
    } catch {
      return makeResponse(404, '');
    }
  });
  vi.stubGlobal('fetch', stub);
}
