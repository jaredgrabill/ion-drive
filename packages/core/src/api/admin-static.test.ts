/**
 * Tests for the admin SPA static mount (Phase 14, Tier 1A) — resolution,
 * SPA fallback, cache headers, and the root redirect — against a synthetic
 * `dist/` directory and a bare Fastify instance (no database needed).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installAdminStatic, looksLikeAssetPath, resolveAdminDist } from './admin-static.js';

const INDEX_HTML = '<!doctype html><div id="root"></div>';

describe('looksLikeAssetPath', () => {
  it('treats dotted last segments as assets', () => {
    expect(looksLikeAssetPath('/admin/assets/app-abc.js')).toBe(true);
    expect(looksLikeAssetPath('/admin/favicon.ico')).toBe(true);
  });

  it('treats extension-less paths as client routes', () => {
    expect(looksLikeAssetPath('/admin/objects')).toBe(false);
    expect(looksLikeAssetPath('/admin/objects/contacts')).toBe(false);
    expect(looksLikeAssetPath('/admin')).toBe(false);
  });
});

describe('resolveAdminDist', () => {
  it('returns null for an explicit path without index.html', () => {
    expect(resolveAdminDist(tmpdir())).toBeNull();
  });

  it('returns the explicit path when index.html exists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ion-admin-'));
    writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
    expect(resolveAdminDist(dir)).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('installAdminStatic serving', () => {
  let dist: string;
  let server: FastifyInstance;

  beforeAll(async () => {
    dist = mkdtempSync(path.join(tmpdir(), 'ion-admin-dist-'));
    writeFileSync(path.join(dist, 'index.html'), INDEX_HTML);
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("ion");');

    server = Fastify();
    const mounted = await installAdminStatic(server, { distPath: dist });
    expect(mounted).toBe(true);
  });

  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves index.html at /admin/ with no-cache', async () => {
    const res = await server.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets with immutable caching', async () => {
    const res = await server.inject({ method: 'GET', url: '/admin/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await server.inject({ method: 'GET', url: '/admin/objects/contacts' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('404s missing asset-like paths with the flat envelope', async () => {
    const res = await server.inject({ method: 'GET', url: '/admin/assets/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not Found' });
  });

  it('404s non-GET requests under /admin', async () => {
    const res = await server.inject({ method: 'POST', url: '/admin/objects' });
    expect(res.statusCode).toBe(404);
  });

  it('redirects / to /admin/', async () => {
    const res = await server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/');
  });

  it('returns false (and mounts nothing) when the dist is absent', async () => {
    const bare = Fastify();
    const mounted = await installAdminStatic(bare, {
      distPath: path.join(tmpdir(), 'does-not-exist'),
    });
    expect(mounted).toBe(false);
    await bare.close();
  });
});
