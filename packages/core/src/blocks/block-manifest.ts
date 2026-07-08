/**
 * Block manifest parsing + static validation (Phase 6).
 *
 * {@link parseManifest} is the single entry point that turns an untrusted value
 * (a bundled export, a local `block.json`, or a POSTed body) into a validated
 * {@link BlockManifest}. It runs the Zod schema and then a handful of
 * cross-field checks the schema can't express (duplicate object/field names,
 * seed keys referencing unknown objects, relationship endpoints). Anything that
 * fails throws a {@link BlockManifestError} with a readable, aggregated message.
 *
 * Deeper checks that need live database state (does a referenced object already
 * exist? would seeding collide?) belong to the installer, not here.
 */

import type { z } from 'zod';
import { type BlockManifest, blockManifestSchema, splitBlockRef } from './block-types.js';

export class BlockManifestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'BlockManifestError';
  }
}

/**
 * Validates and normalises a raw manifest value.
 * @throws {BlockManifestError} if the value is structurally or semantically invalid.
 */
export function parseManifest(input: unknown): BlockManifest {
  rejectLegacyShape(input);
  const parsed = blockManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw new BlockManifestError(`Invalid block manifest: ${issues.join('; ')}`, issues);
  }

  const manifest = parsed.data;
  const issues = checkConsistency(manifest);
  if (issues.length > 0) {
    throw new BlockManifestError(
      `Invalid block manifest "${manifest.name}": ${issues.join('; ')}`,
      issues,
    );
  }

  return manifest;
}

/**
 * Pre-Zod gate for the retired pre-v1 manifest shape (spec-02 clean break):
 * `dependencies` as an array of bare names is rejected with a pointer at the
 * v1 record form instead of a generic Zod "expected object" type error.
 */
function rejectLegacyShape(input: unknown): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return; // let Zod report
  if (Array.isArray((input as Record<string, unknown>).dependencies)) {
    const issue =
      'dependencies is the legacy array form — manifest v1 uses a name → semver-range record, e.g. {"crm": "^0.2.0"}';
    throw new BlockManifestError(`Invalid block manifest: ${issue}`, [issue]);
  }
}

/** Cross-field checks the Zod schema cannot express on its own. */
function checkConsistency(manifest: BlockManifest): string[] {
  const issues: string[] = [];
  const objectNames = new Set<string>();

  for (const obj of manifest.objects) {
    if (objectNames.has(obj.name)) {
      issues.push(`duplicate object "${obj.name}"`);
    }
    objectNames.add(obj.name);

    const fieldNames = new Set<string>();
    for (const field of obj.fields) {
      if (fieldNames.has(field.name)) {
        issues.push(`object "${obj.name}" has duplicate field "${field.name}"`);
      }
      fieldNames.add(field.name);
    }
  }

  // Seed keys must reference objects this block defines.
  for (const key of Object.keys(manifest.seed)) {
    if (!objectNames.has(key)) {
      issues.push(`seed data references unknown object "${key}"`);
    }
  }

  issues.push(...checkDependencyRefs(manifest));

  // Actions, hooks, and code file paths must be unique within the block.
  issues.push(
    ...checkDuplicates(
      'action',
      manifest.actions.map((a) => a.name),
    ),
  );
  issues.push(
    ...checkDuplicates(
      'hook',
      manifest.hooks.map((h) => h.name),
    ),
  );
  issues.push(
    ...checkDuplicates(
      'code file',
      manifest.code.map((f) => f.path),
    ),
  );

  return issues;
}

/**
 * Dependency-ref checks (spec-02): no self-dependency — bare (`crm`) or
 * namespaced (`@ns/crm`) — because blocks are singletons per server, so a
 * namespaced ref to the block's own name is the same block from a different
 * source; and no bare name referenced twice under different namespace forms
 * (`crm` + `@ion/crm`), which would make the source ambiguous.
 */
function checkDependencyRefs(manifest: BlockManifest): string[] {
  const issues: string[] = [];
  const seenRefs = new Map<string, string>();
  for (const ref of Object.keys(manifest.dependencies)) {
    const bare = splitBlockRef(ref)?.name ?? ref;
    if (bare === manifest.name) {
      issues.push(
        `dependency "${ref}": a block cannot depend on itself (blocks are singletons per server)`,
      );
    }
    const prior = seenRefs.get(bare);
    if (prior !== undefined) {
      issues.push(
        `dependencies "${prior}" and "${ref}" both name block "${bare}" (ambiguous source)`,
      );
    }
    seenRefs.set(bare, ref);
  }
  return issues;
}

/** Flags repeated names in a manifest list (`duplicate action "x"`). */
function checkDuplicates(kind: string, names: string[]): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const name of names) {
    if (seen.has(name)) issues.push(`duplicate ${kind} "${name}"`);
    seen.add(name);
  }
  return issues;
}

/** Turns a ZodError into a flat list of `path: message` strings. */
function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
