/**
 * Unit tests for the block dependency resolver, exercised against the real
 * bundled catalog (crm has no deps; invoicing depends on crm).
 */

import { describe, expect, it } from 'vitest';
import { resolvePlan } from './resolver.js';

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
    await expect(resolvePlan('does-not-exist', new Set())).rejects.toThrow(/Unknown block/);
  });
});
