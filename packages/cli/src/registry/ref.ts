/**
 * Block-ref grammar for CLI arguments (spec-03 §2).
 *
 * ```
 * ref        := [namespace "/"] name [ "@" selector ]
 * namespace  := "@" [a-z][a-z0-9-]*
 * name       := [a-z][a-z0-9_-]*
 * selector   := exact semver ("0.2.0") | semver range ("^0.2.0", "1.x", ">=1 <2")
 * ```
 *
 * Plus the unchanged non-registry forms: any `http(s)://…/block.json` URL and
 * any local path (the block-dev loop). Classification order matters:
 * URLs first, then local paths — but a ref starting with `@` is **never** a
 * local path (`@acme/billing` must not be probed on disk), and Windows
 * backslash paths keep working (spec-03 AC8).
 *
 * The namespace/name regex is a **vendored copy of core's `splitBlockRef`**
 * (`packages/core/src/blocks/block-types.ts`) so the CLI does not need core as
 * a runtime dependency; a parity unit test (`ref.test.ts`) imports core's
 * implementation and asserts the two never drift. Keep the regexes
 * byte-identical to core's.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import semver from 'semver';

/** Thrown for input the ref grammar rejects — the message shows the grammar. */
export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

/** A classified CLI block ref. */
export type ParsedRef =
  | { kind: 'registry'; namespace?: string; name: string; selector?: string }
  | { kind: 'url'; url: string }
  | { kind: 'local'; path: string };

/**
 * Vendored copy of core's ref regex (`splitBlockRef` in `block-types.ts`).
 * Byte-identical by contract — parity-tested against `@ion-drive/core`.
 */
const BLOCK_REF_RE = /^(?:(@[a-z][a-z0-9-]*)\/)?([a-z][a-z0-9_-]*)$/;

/**
 * Splits `crm` / `@acme/billing` into namespace + name; `null` for anything
 * the grammar rejects. Mirrors core's `splitBlockRef` exactly.
 */
export function splitBlockRef(ref: string): { namespace?: string; name: string } | null {
  const match = BLOCK_REF_RE.exec(ref);
  if (!match) return null;
  const namespace = match[1];
  const name = match[2];
  if (name === undefined) return null; // unreachable — the regex guarantees group 2
  return namespace === undefined ? { name } : { namespace, name };
}

/** True when `ref` looks like a remote registry/artifact URL rather than a name. */
export function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** True when `ref` points at a local block directory (the block-dev loop). */
export function isLocalPath(ref: string): boolean {
  if (ref.startsWith('@')) return false; // `@acme/billing` is never a path
  if (ref.startsWith('.') || isAbsolute(ref) || ref.includes(sep) || ref.includes('/')) {
    return existsSync(join(resolve(ref), 'block.json'));
  }
  return false;
}

const GRAMMAR_HINT =
  'expected a block ref like "crm", "crm@^0.2.0", or "@acme/billing@1.x" — ' +
  'a https://…/block.json URL, or a local block directory';

/**
 * Parses a CLI block argument into a {@link ParsedRef}.
 *
 * - `http(s)://…` ⇒ `url`.
 * - A path-looking ref (not starting with `@`) with a `block.json` ⇒ `local`.
 * - Otherwise the registry grammar: the `@selector` split searches from index
 *   1 for bare names (so a would-be leading `@` never matches) and takes the
 *   **last** `@` after the `/` for namespaced refs (`@ns/name@sel`).
 *
 * @throws {RefError} for anything none of the three forms accept.
 */
export function parseRef(input: string): ParsedRef {
  const ref = input.trim();
  if (ref.length === 0) throw new RefError(`Empty block ref — ${GRAMMAR_HINT}.`);
  if (isUrl(ref)) return { kind: 'url', url: ref };
  if (isLocalPath(ref)) return { kind: 'local', path: ref };

  // A ref that *looks* like a path but had no block.json is a path mistake,
  // not a grammar mistake — say so instead of dumping the grammar.
  const pathLike =
    !ref.startsWith('@') && (ref.startsWith('.') || isAbsolute(ref) || ref.includes(sep));
  if (pathLike) {
    throw new RefError(`No block.json found at ${resolve(ref)} — is this a block directory?`);
  }

  const { namePart, selector } = splitSelector(ref);
  const parts = splitBlockRef(namePart);
  if (!parts) throw new RefError(`Invalid block ref "${input}" — ${GRAMMAR_HINT}.`);

  if (selector !== undefined) {
    if (selector.length === 0 || semver.validRange(selector, { loose: false }) === null) {
      throw new RefError(
        `Invalid version selector "${selector}" in "${input}" — expected an exact semver version ("0.2.0") or range ("^0.2.0", "1.x", ">=1 <2").`,
      );
    }
    return { kind: 'registry', namespace: parts.namespace, name: parts.name, selector };
  }
  return { kind: 'registry', namespace: parts.namespace, name: parts.name };
}

/**
 * Splits the optional `@selector` off a registry ref. Bare names use the
 * `indexOf('@', 1)` trick; namespaced refs split on the last `@` after the
 * `/` (the namespace's leading `@` never matches either way).
 */
function splitSelector(ref: string): { namePart: string; selector?: string } {
  if (ref.startsWith('@')) {
    const slash = ref.indexOf('/');
    const at = ref.lastIndexOf('@');
    if (slash !== -1 && at > slash) {
      return { namePart: ref.slice(0, at), selector: ref.slice(at + 1) };
    }
    return { namePart: ref };
  }
  const at = ref.indexOf('@', 1);
  if (at === -1) return { namePart: ref };
  return { namePart: ref.slice(0, at), selector: ref.slice(at + 1) };
}
