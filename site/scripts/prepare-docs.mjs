/**
 * Docs curation pipeline (spec-10 §1) — copies the repo's *public* docs subset
 * into the Starlight content directory before every build/dev/typecheck.
 *
 * Why a copy step instead of a loader over `../docs`: the curation rules
 * (allowlist, H1→frontmatter, link rewriting with build-failing checks) need a
 * deterministic, testable transform — and the copied tree is plain gitignored
 * build output, so the repo's `docs/` stays the single canonical source.
 *
 * The include ALLOWLIST is explicit: `getting-started.md`, `concepts/**`,
 * `api/**`, `deployment/**`. Everything else — `research/`, `specs/`, the
 * phase implementation plans, `roadmap.md` — is contributor/agent working
 * knowledge, deliberately unpublished (ADR-023 amendment: the public docs
 * surface carries the user-facing docs only).
 *
 * Transform per file:
 *  1. The first `# H1` becomes Starlight `title:` frontmatter and is stripped
 *     from the body (a file without one fails with `DocsCurationError`).
 *  2. Relative `.md` links are rewritten to root-relative site routes
 *     (`concepts/events.md#x` → `/docs/concepts/events/#x`), fragments kept.
 *     A relative link to an excluded or missing target fails the build with a
 *     `DocsLinkError` naming source and target. Absolute URLs pass through.
 *
 * Pure functions are exported for unit tests; the CLI entry at the bottom
 * wipes + regenerates `site/src/content/docs/docs/` (idempotent).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A curated file is missing its `# H1` (Starlight needs a title). */
export class DocsCurationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DocsCurationError';
  }
}

/** A relative link points at an excluded or missing doc — the build must fail. */
export class DocsLinkError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DocsLinkError';
  }
}

/**
 * Whether a docs-relative path (posix separators) is on the publish allowlist.
 * @param {string} relPath
 * @returns {boolean}
 */
export function isAllowlisted(relPath) {
  if (!relPath.endsWith('.md')) return false;
  if (relPath === 'getting-started.md') return true;
  return ['concepts/', 'api/', 'deployment/'].some((prefix) => relPath.startsWith(prefix));
}

/**
 * The site route a curated doc renders at (`api/querying.md` → `/docs/api/querying/`).
 * Always posix, always trailing-slash (Starlight's default trailing behavior).
 * @param {string} relPath
 * @returns {string}
 */
export function routeForDoc(relPath) {
  return `/docs/${relPath.replace(/\.md$/, '')}/`;
}

/**
 * Splits a doc into its `# H1` title and the body without it.
 * @param {string} markdown
 * @param {string} sourcePath - for the error message
 * @returns {{ title: string, body: string }}
 * @throws {DocsCurationError}
 */
export function extractTitle(markdown, sourcePath) {
  const match = markdown.match(/^# (.+)\r?\n?/m);
  if (!match || typeof match.index !== 'number') {
    throw new DocsCurationError(`${sourcePath}: no "# H1" found to use as the page title`);
  }
  const body = markdown.slice(0, match.index) + markdown.slice(match.index + match[0].length);
  return { title: match[1].trim(), body: body.replace(/^\s*\n/, '') };
}

/**
 * Rewrites relative `.md` links in one doc to root-relative site routes,
 * preserving `#fragments`. Absolute (`http…`), root-relative, `mailto:` and
 * pure-fragment links pass through untouched.
 *
 * @param {string} markdown
 * @param {string} sourceRelPath - docs-relative posix path of the file being rewritten
 * @param {(relPath: string) => boolean} isIncluded - allowlisted AND exists in the source tree
 * @returns {string}
 * @throws {DocsLinkError} when a relative link's target is excluded or missing
 */
export function rewriteLinks(markdown, sourceRelPath, isIncluded) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole; // absolute / root / fragment
    const hashIndex = target.indexOf('#');
    const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : target.slice(hashIndex);
    if (!pathPart.endsWith('.md')) return whole; // non-doc relative link (none exist today)
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourceRelPath), pathPart),
    );
    if (resolved.startsWith('..') || !isIncluded(resolved)) {
      throw new DocsLinkError(
        `${sourceRelPath}: link target "${target}" is excluded from the published docs or missing — link to an included doc or use an absolute GitHub URL`,
      );
    }
    return `](${routeForDoc(resolved)}${fragment})`;
  });
}

/**
 * Renders the Starlight frontmatter + transformed body for one doc.
 * @param {string} markdown - raw source markdown
 * @param {string} sourceRelPath
 * @param {(relPath: string) => boolean} isIncluded
 * @returns {string}
 */
export function curateDoc(markdown, sourceRelPath, isIncluded) {
  const { title, body } = extractTitle(markdown, sourceRelPath);
  const rewritten = rewriteLinks(body, sourceRelPath, isIncluded);
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${rewritten}`;
}

/**
 * Recursively lists docs-relative posix paths of all `.md` files under a dir.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listMarkdown(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listMarkdown(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/**
 * The full pipeline: wipe `outDir`, copy + transform every allowlisted doc
 * from `srcDir`. Idempotent — safe to run before every build/dev/typecheck.
 *
 * @param {string} srcDir - the repo's `docs/` directory
 * @param {string} outDir - e.g. `site/src/content/docs/docs`
 * @returns {{ files: string[] }} docs-relative paths that were published
 * @throws {DocsCurationError | DocsLinkError}
 */
export function curateDocs(srcDir, outDir) {
  if (!existsSync(srcDir))
    throw new DocsCurationError(`docs source directory not found: ${srcDir}`);
  const included = listMarkdown(srcDir).filter(isAllowlisted).sort();
  const includedSet = new Set(included);
  const isIncluded = (/** @type {string} */ relPath) => includedSet.has(relPath);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const relPath of included) {
    const raw = readFileSync(path.join(srcDir, relPath), 'utf8');
    const curated = curateDoc(raw, relPath, isIncluded);
    const dest = path.join(outDir, relPath);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, curated, 'utf8');
  }
  return { files: included };
}

// --- CLI entry ---------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(scriptDir, '../../docs');
  const outDir = path.resolve(scriptDir, '../src/content/docs/docs');
  const { files } = curateDocs(srcDir, outDir);
  console.log(
    `prepare-docs: published ${files.length} docs into ${path.relative(process.cwd(), outDir)}`,
  );
}
