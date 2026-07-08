/**
 * Project-first loader for `@ion-drive/core`'s authoritative parsers (spec-05).
 *
 * The CLI ships with no runtime dependency on core, but two commands want
 * core's strict Zod validation when it is resolvable:
 *
 *  - `block validate` — optional: falls back to structural checks with a
 *    warning when core is absent.
 *  - `registry build` / `block publish` — **mandatory**: a registry generator
 *    that can't run the strict parsers must refuse rather than emit unchecked
 *    JSON (the publisher is where strictness lives — spec-01/spec-05).
 *
 * Resolution is tried from the *current project* first (so a
 * globally-installed CLI picks up the project's own core install), then from
 * the CLI's own dependency tree (the monorepo / `npm i -g @ion-drive/core`
 * case). Extracted from `commands/block.ts` and widened to the registry
 * parsers for spec-05.
 */

/** The slice of core the CLI's validators use when it's installed nearby. */
export interface CoreValidatorModule {
  /** Strict manifest-v1 parser (throws `BlockManifestError` with issues). */
  parseManifest: (input: unknown) => { name: string };
  /** Strict registry-protocol-v1 parsers (throw `RegistryParseError`). */
  parseRegistryIndex: (input: unknown) => unknown;
  parseRegistryBlock: (input: unknown) => unknown;
  parseRegistriesDirectory: (input: unknown) => unknown;
}

/** The actionable "install core" pointer for callers that *require* core. */
export const CORE_REQUIRED_MESSAGE =
  'Could not load @ion-drive/core — `registry build` validates with its strict parsers. ' +
  'Install it (`npm i -g @ion-drive/core`) or run inside an Ion Drive project.';

/**
 * Loads core's authoritative parsers when available; `null` when core is not
 * resolvable from either the current project or the CLI's own tree.
 */
export async function loadCoreValidator(): Promise<CoreValidatorModule | null> {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  try {
    const projectRequire = createRequire(join(process.cwd(), 'package.json'));
    const resolved = projectRequire.resolve('@ion-drive/core');
    return (await import(pathToFileURL(resolved).href)) as unknown as CoreValidatorModule;
  } catch {
    /* fall through to the CLI's own tree */
  }
  try {
    return (await import('@ion-drive/core')) as unknown as CoreValidatorModule;
  } catch {
    return null;
  }
}
