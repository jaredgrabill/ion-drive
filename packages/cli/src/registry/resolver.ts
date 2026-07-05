/**
 * Dependency resolver — expands a requested block into an install-ordered plan.
 *
 * Mirrors how shadcn resolves `registryDependencies` recursively: starting from
 * the requested block, it walks each block's `dependencies`, fetches every
 * transitive manifest, and returns them **topologically sorted** (dependencies
 * before dependents). Blocks already installed on the target server are pruned
 * from the plan. Cycles and unresolvable dependencies fail fast with a clear
 * message.
 */

import { type Manifest, dependenciesOf, getManifest } from './registry-client.js';

export class ResolveError extends Error {}

export interface ResolvedPlan {
  /** Manifests to install, dependencies first. */
  order: Manifest[];
  /** Dependency block names skipped because they're already installed. */
  alreadyInstalled: string[];
}

/**
 * Builds an ordered install plan for `target`, fetching transitive deps.
 * @param target        block name or URL the user asked for
 * @param installedNames block names already present on the server
 */
export async function resolvePlan(
  target: string,
  installedNames: Set<string>,
): Promise<ResolvedPlan> {
  const manifests = new Map<string, Manifest>();
  const alreadyInstalled = new Set<string>();

  // Depth-first fetch of the dependency closure.
  const fetchClosure = async (ref: string, trail: string[]): Promise<void> => {
    const manifest = await getManifest(ref);
    const name = manifest.name;

    if (trail.includes(name)) {
      throw new ResolveError(`Circular dependency: ${[...trail, name].join(' → ')}`);
    }
    if (manifests.has(name)) return;
    manifests.set(name, manifest);

    for (const dep of dependenciesOf(manifest)) {
      if (installedNames.has(dep)) {
        alreadyInstalled.add(dep);
        continue;
      }
      await fetchClosure(dep, [...trail, name]);
    }
  };

  await fetchClosure(target, []);

  const order = topoSort(manifests, installedNames);
  return { order, alreadyInstalled: [...alreadyInstalled] };
}

/** Kahn-style topological sort: dependencies emitted before dependents. */
function topoSort(manifests: Map<string, Manifest>, installedNames: Set<string>): Manifest[] {
  const ordered: Manifest[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new ResolveError(`Circular dependency involving "${name}"`);
    }
    const manifest = manifests.get(name);
    if (!manifest) return; // external/already-installed dep — not part of the plan
    visiting.add(name);
    for (const dep of dependenciesOf(manifest)) {
      if (!installedNames.has(dep)) visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(manifest);
  };

  for (const name of manifests.keys()) visit(name);
  return ordered;
}
