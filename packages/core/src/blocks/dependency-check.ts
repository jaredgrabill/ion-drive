/**
 * Pure dependency-range evaluation for block installs (ADR-022 / spec-02).
 *
 * A manifest's `dependencies` is a block-ref → semver-range record; the
 * `_ion_blocks` ledger keys installed blocks by bare name + version.
 * {@link evaluateDependencies} compares the two: a namespaced ref
 * (`@acme/crm`) matches the ledger's bare `crm` — a namespace is a *source*,
 * not an identity, and blocks are singletons per server — `"*"` is the
 * unconstrained escape hatch, and an installed version that isn't valid
 * semver (a pre-v1 ledger row) can never satisfy a real range. Deliberately
 * pure (no store access) so it unit-tests without a database; the
 * {@link BlockEngine} feeds it `BlockStore.listInstalledVersions()`.
 */

import semver from 'semver';
import { splitBlockRef } from './block-types.js';

/** One dependency installed at a version outside the declared range. */
export interface OutOfRangeDependency {
  /** Bare block name, as the ledger keys it. */
  name: string;
  /** The version currently installed (may be non-semver in pre-v1 ledgers). */
  installedVersion: string;
  /** The declared semver range `installedVersion` fails. */
  range: string;
}

/** Result of checking a manifest's dependency record against the ledger. */
export interface DependencyEvaluation {
  /** Refs (as declared, so namespaced forms survive) with no installed block. */
  missing: string[];
  /** Installed dependencies whose version fails the declared range. */
  outOfRange: OutOfRangeDependency[];
}

/**
 * Bare block names referenced by a dependencies record (`@ns/crm` → `crm`).
 * A ref the grammar rejects (only reachable from unvalidated ledger
 * snapshots) falls through unchanged rather than being dropped.
 */
export function dependencyNames(deps: Record<string, string>): string[] {
  return Object.keys(deps).map((ref) => splitBlockRef(ref)?.name ?? ref);
}

/**
 * Evaluates a manifest's `dependencies` against the installed-block ledger.
 * Missing blocks and out-of-range versions are reported separately because
 * they map to different install errors (`dependency` vs `dependency_version`,
 * both 422).
 */
export function evaluateDependencies(
  deps: Record<string, string>,
  installed: Map<string, string>,
): DependencyEvaluation {
  const missing: string[] = [];
  const outOfRange: OutOfRangeDependency[] = [];

  for (const [ref, range] of Object.entries(deps)) {
    const name = splitBlockRef(ref)?.name ?? ref;
    const installedVersion = installed.get(name);
    if (installedVersion === undefined) {
      missing.push(ref);
      continue;
    }
    // `*` means "any installed version" — satisfied even when the ledger holds
    // a non-semver version string, preserving the pre-spec-02 unconstrained
    // behaviour for blocks that opt out of ranges.
    if (range.trim() === '*') continue;
    // `semver.satisfies` returns false (never throws) for a non-semver
    // installed version, so pre-v1 ledger rows count as out-of-range here.
    if (!semver.satisfies(installedVersion, range)) {
      outOfRange.push({ name, installedVersion, range });
    }
  }

  return { missing, outOfRange };
}
