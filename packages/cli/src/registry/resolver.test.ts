/**
 * Unit tests for the block dependency resolver, exercised against a mocked
 * registry (crm has no deps; invoicing depends on crm) — the bundled catalog
 * retired with the Phase 14 registry model.
 */

import { describe, expect, it, vi } from 'vitest';
import { RegistryError } from './registry-client.js';
import { resolvePlan } from './resolver.js';

vi.mock('./registry-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry-client.js')>();
  const catalog: Record<string, { name: string; dependencies?: string[] }> = {
    crm: { name: 'crm' },
    invoicing: { name: 'invoicing', dependencies: ['crm'] },
    loop_a: { name: 'loop_a', dependencies: ['loop_b'] },
    loop_b: { name: 'loop_b', dependencies: ['loop_a'] },
  };
  return {
    ...actual,
    getManifest: vi.fn(async (ref: string) => {
      const manifest = catalog[ref];
      if (!manifest) throw new actual.RegistryError(`Unknown block "${ref}". Available: (mock)`);
      return manifest;
    }),
  };
});

const names = (plan: { order: { name: string }[] }) => plan.order.map((m) => m.name);

describe('resolvePlan', () => {
  it('resolves a dependency-free block to a single-item plan', async () => {
    const plan = await resolvePlan('crm', new Set());
    expect(names(plan)).toEqual(['crm']);
    expect(plan.alreadyInstalled).toEqual([]);
  });

  it('orders dependencies before dependents', async () => {
    const plan = await resolvePlan('invoicing', new Set());
    expect(names(plan)).toEqual(['crm', 'invoicing']);
  });

  it('prunes dependencies already installed on the server', async () => {
    const plan = await resolvePlan('invoicing', new Set(['crm']));
    expect(names(plan)).toEqual(['invoicing']);
    expect(plan.alreadyInstalled).toEqual(['crm']);
  });

  it('throws a helpful error for an unknown block', async () => {
    await expect(resolvePlan('does-not-exist', new Set())).rejects.toThrow(RegistryError);
  });

  it('fails fast on dependency cycles', async () => {
    await expect(resolvePlan('loop_a', new Set())).rejects.toThrow(/Circular dependency/);
  });
});
