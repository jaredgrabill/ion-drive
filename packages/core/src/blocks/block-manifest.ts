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
import { type BlockManifest, blockManifestSchema } from './block-types.js';

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

  // A block may not depend on itself.
  if (manifest.dependencies.includes(manifest.name)) {
    issues.push('a block cannot depend on itself');
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
