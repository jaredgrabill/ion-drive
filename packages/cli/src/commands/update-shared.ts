/**
 * Shared machinery for `ion-drive diff` and `ion-drive update` (spec-07):
 *
 *  - {@link resolveUpdateTarget} — pick the target version from the block's
 *    recorded source registry (exact selector, semver range, or highest
 *    active non-prerelease) and run it through the spec-04 verify phase
 *    (digest gate + trust tier) exactly like `add`;
 *  - {@link codeFileStatuses} — the pure three-way per-file comparison
 *    (ledger snapshot × new artifact × user tree, all byte-compared);
 *  - {@link readVendoredTree} — the user's `blocks/<name>/**` bytes;
 *  - render helpers for the manifest delta, server previews, code table, and
 *    trailer, shared verbatim by both commands.
 *
 * The manifest delta itself comes from the SERVER (the dry-run upgrade
 * report's `delta`) — the CLI never imports core at runtime.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import type {
  InstalledBlock,
  IonApiClient,
  ManifestDeltaWire,
  UpgradePreviewWire,
} from '../api-client.js';
import { type IonProjectConfig, defaultRegistryNamespace } from '../config.js';
import type { CodeFileDelta } from '../project.js';
import {
  fetchBlock,
  isUrl,
  resolveRegistry,
  resolveRegistryUrl,
} from '../registry/registry-client.js';
import type { PlanItem } from '../registry/resolver.js';
import { tierBadge } from '../registry/verify.js';
import { c, sym } from '../ui.js';
import { type VerifiedItem, fetchAndVerifyPlan } from './add.js';

/** Thrown for update-flow problems the user can act on. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

/** A dependency-range implication of moving to the target version. */
export interface DependencyImplication {
  name: string;
  range: string;
  /** Undefined when the dependency is not installed at all. */
  installedVersion?: string;
}

/** Everything the diff/update flows need about the resolved target. */
export interface UpdateTarget {
  name: string;
  currentVersion: string;
  /** The server ledger row — its `manifest` snapshot is the diff baseline. */
  installed: InstalledBlock;
  /** The fetched, digest-verified target artifact + trust verdict. */
  verified: VerifiedItem;
  /** `requires.core` of the target, when the registry mirrors one. */
  requiresCore?: string;
  /** Dep ranges of the target that the installed set does not satisfy. */
  dependencyNotes: DependencyImplication[];
}

/**
 * Resolves `name[@selector]` to a verified target artifact from the block's
 * recorded source registry (spec-07 §1): exact versions must exist and be
 * active; ranges pick `semver.maxSatisfying` over active versions
 * (prereleases only when the selector demands them); no selector picks the
 * highest active non-prerelease. Local-path/URL installs are refused — their
 * update path is `ion-drive add <path-or-url> --force`.
 */
export async function resolveUpdateTarget(
  name: string,
  selector: string | undefined,
  config: IonProjectConfig,
  client: IonApiClient,
  opts: { verifyProvenance: boolean },
): Promise<UpdateTarget> {
  const installed = await client.getBlock(name);
  if (!installed.manifest) {
    throw new UpdateError(
      `The server's ledger row for "${name}" carries no manifest snapshot — update requires a server that records one (upgrade the server, or reinstall with \`ion-drive add ${name} --force\`).`,
    );
  }

  const namespace = sourceNamespaceFor(name, config, installed);
  const reg = resolveRegistry(namespace, config);
  // Always fresh — update decisions must never run on stale registry metadata.
  const { doc, url: blockUrl } = await fetchBlock(reg, name, { noCache: true });

  const version = selectTargetVersion(name, selector, doc.versions, doc.latest);
  const entry = doc.versions[version];
  if (!entry) throw new UpdateError(`Internal: no version entry for ${name}@${version}`); // unreachable

  const item: PlanItem = {
    name,
    version,
    source: namespace,
    registry: namespace,
    sourceUrl: resolveRegistryUrl(entry.artifactUrl, blockUrl),
    digest: entry.digest,
    size: entry.size,
    attestationUrl: entry.attestationUrl
      ? resolveRegistryUrl(entry.attestationUrl, blockUrl)
      : undefined,
    repository: doc.repository,
    publishedAt: entry.publishedAt,
    isDependency: false,
    warnings: [],
  };
  // The spec-04 verify phase, reused verbatim: digest hard gate + trust tier.
  const [verified] = await fetchAndVerifyPlan([item], config, {
    verifyProvenance: opts.verifyProvenance,
  });
  if (!verified) throw new UpdateError(`Internal: verify phase returned nothing for "${name}"`); // unreachable

  return {
    name,
    currentVersion: installed.version,
    installed,
    verified,
    requiresCore: typeof entry.requires?.core === 'string' ? entry.requires.core : undefined,
    dependencyNotes: await dependencyImplications(entry.dependencies, client),
  };
}

/** The registry namespace the target resolves in (the recorded source). */
function sourceNamespaceFor(
  name: string,
  config: IonProjectConfig,
  installed: InstalledBlock,
): string {
  const recorded =
    config.blocks.find((b) => b.name === name)?.source ?? installed.sourceRegistry ?? undefined;
  if (recorded === 'local' || (recorded !== undefined && isUrl(recorded))) {
    throw new UpdateError(
      `"${name}" was installed from ${recorded === 'local' ? 'a local path' : 'a direct URL'} — there is no registry to update from. Re-install the new version with \`ion-drive add ${recorded === 'local' ? '<path>' : recorded} --force\`.`,
    );
  }
  if (recorded?.startsWith('@')) return recorded;
  return defaultRegistryNamespace(config);
}

/** Version selection over the active entries (spec-07 §1). */
export function selectTargetVersion(
  name: string,
  selector: string | undefined,
  versions: Record<string, { status: string; statusReason?: string }>,
  latest: string,
): string {
  const active = Object.keys(versions)
    .filter((v) => semver.valid(v) !== null)
    .filter((v) => versions[v]?.status === 'active')
    .sort(semver.rcompare);

  if (selector !== undefined && semver.valid(selector) !== null) {
    return pickExactVersion(name, selector, versions, active);
  }
  if (selector !== undefined) return pickRangeVersion(name, selector, active);

  const stable = active.filter((v) => semver.prerelease(v) === null);
  const pick = stable[0] ?? (active.includes(latest) ? latest : undefined);
  if (!pick) {
    throw new UpdateError(`"${name}" has no active non-prerelease versions to update to.`);
  }
  return pick;
}

/** An exact selector must name an ACTIVE version (status named otherwise). */
function pickExactVersion(
  name: string,
  selector: string,
  versions: Record<string, { status: string; statusReason?: string }>,
  active: string[],
): string {
  if (active.includes(selector)) return selector;
  const entry = versions[selector];
  const known = active.join(', ') || '(none)';
  throw new UpdateError(
    entry
      ? `${name}@${selector} is ${entry.status}${entry.statusReason ? ` (${entry.statusReason})` : ''} — pick an active version. Active: ${known}`
      : `${name} has no version ${selector}. Active: ${known}`,
  );
}

/** Range selectors pick maxSatisfying (prereleases only when the range names one). */
function pickRangeVersion(name: string, selector: string, active: string[]): string {
  if (semver.validRange(selector) === null) {
    throw new UpdateError(`"${selector}" is not a version or semver range.`);
  }
  const pick = semver.maxSatisfying(active, selector);
  if (!pick) {
    throw new UpdateError(
      `No active version of "${name}" satisfies ${selector}. Active: ${active.join(', ') || '(none)'}`,
    );
  }
  return pick;
}

/** Dep ranges of the target that the installed blocks do not satisfy. */
async function dependencyImplications(
  dependencies: Record<string, string>,
  client: IonApiClient,
): Promise<DependencyImplication[]> {
  const entries = Object.entries(dependencies);
  if (entries.length === 0) return [];
  const installed = new Map(
    (await client.listInstalled())
      .filter((b) => b.status === 'installed')
      .map((b) => [b.name, b.version] as const),
  );
  const notes: DependencyImplication[] = [];
  for (const [depRef, range] of entries) {
    const bare = depRef.includes('/') ? (depRef.split('/')[1] ?? depRef) : depRef;
    const version = installed.get(bare);
    if (version === undefined || !semver.satisfies(version, range)) {
      notes.push({ name: bare, range, installedVersion: version });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// The three-way code comparison (pure)
// ---------------------------------------------------------------------------

/**
 * Computes the spec-07 per-file status over old ∪ new ∪ tree, byte-compared:
 *
 * | status            | condition                                              |
 * |-------------------|--------------------------------------------------------|
 * | unchanged         | new == old == tree (or tree already == new)            |
 * | update-available  | new ≠ old, tree == old — safe overwrite                |
 * | modified-by-you   | tree ≠ old (incl. deleted) — `.new` beside, never over |
 * | added-upstream    | in new only — will be created                          |
 * | removed-upstream  | in old only — reported, never deleted                  |
 * | yours             | in tree only — untouched                               |
 *
 * The `tree == old` test uses the LEDGER SNAPSHOT's bytes — exactly why the
 * snapshot exists (no hashes-in-files or mtime tricks).
 */
export function codeFileStatuses(
  oldCode: { path: string; contents: string }[],
  newCode: { path: string; contents: string }[],
  tree: Map<string, string>,
): CodeFileDelta[] {
  const oldMap = new Map(oldCode.map((f) => [f.path, f.contents]));
  const newMap = new Map(newCode.map((f) => [f.path, f.contents]));
  const paths = [...new Set([...oldMap.keys(), ...newMap.keys(), ...tree.keys()])].sort();

  return paths.map((path) => {
    const oldContents = oldMap.get(path);
    const newContents = newMap.get(path);
    const treeContents = tree.get(path);
    return {
      path,
      status: statusFor(oldContents, newContents, treeContents),
      oldContents,
      newContents,
    };
  });
}

/** One path's verdict from its three optional byte strings. */
function statusFor(
  oldC: string | undefined,
  newC: string | undefined,
  treeC: string | undefined,
): CodeFileDelta['status'] {
  if (oldC === undefined && newC === undefined) return 'yours';
  if (newC === undefined) return 'removed-upstream';
  if (oldC === undefined) {
    // New upstream file. If the user already has identical bytes there is
    // nothing to do; different bytes are theirs — never overwritten.
    if (treeC === undefined) return 'added-upstream';
    return treeC === newC ? 'unchanged' : 'modified-by-you';
  }
  // Present in both versions.
  if (treeC === newC) return 'unchanged'; // already at the target bytes
  if (treeC === oldC) return newC === oldC ? 'unchanged' : 'update-available';
  return 'modified-by-you'; // edited or deleted by the user
}

/**
 * Reads the user's `blocks/<name>/**` into a path → contents map
 * (project-relative inside the block folder, `/`-separated). `.new` files
 * from a previous update are excluded — they are merge artifacts, not code.
 */
export function readVendoredTree(blockName: string, dir = process.cwd()): Map<string, string> {
  const root = resolve(dir, 'blocks', blockName);
  const files = new Map<string, string>();
  if (!existsSync(root)) return files;
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (!entry.endsWith('.new')) {
        files.set(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  return files;
}

// ---------------------------------------------------------------------------
// Rendering (shared by diff + update)
// ---------------------------------------------------------------------------

/** An all-empty delta (fallback when an old server sends no `report.delta`). */
export function emptyDelta(from: string, to: string): ManifestDeltaWire {
  return {
    from,
    to,
    objects: { added: [], removed: [] },
    fields: [],
    relationships: { added: [], removed: [] },
    tasks: [],
    roles: [],
    subscriptions: { added: [], removed: [], changed: [] },
    webhooks: { added: [], removed: [], changed: [] },
    actions: { added: [], removed: [] },
    hooks: { added: [], removed: [] },
    seedChanged: false,
    code: { added: [], removed: [], changed: [] },
    hasChanges: false,
  };
}

/** Colored `additive`/`modifying`/`destructive` tag. */
function kindTag(kind: string): string {
  if (kind === 'destructive') return c.danger('destructive');
  if (kind === 'modifying') return c.warn('modifying');
  return c.success('additive');
}

/** One `  + label · kind` line. */
function deltaLine(label: string, kind: string, note = ''): string {
  const marker =
    kind === 'destructive' ? c.danger('-') : kind === 'modifying' ? c.warn('~') : c.success('+');
  return `  ${marker} ${label} ${c.meteor('·')} ${kindTag(kind)}${note ? ` ${c.dim(note)}` : ''}`;
}

/** Renders the server-computed manifest delta as classified lines. */
export function renderManifestDelta(delta: ManifestDeltaWire): string[] {
  const lines = [...renderSchemaDeltaLines(delta), ...renderRuntimeDeltaLines(delta)];
  if (delta.seedChanged) {
    lines.push(`  ${sym.warn} ${c.warn('seed data changed — never re-applied on upgrade')}`);
  }
  if (lines.length === 0) lines.push(c.dim('  (no manifest changes)'));
  return lines;
}

/** Object/field/relationship/task/role delta lines. */
function renderSchemaDeltaLines(delta: ManifestDeltaWire): string[] {
  const lines: string[] = [];
  for (const name of delta.objects.added) lines.push(deltaLine(`object ${name}`, 'additive'));
  for (const name of delta.objects.removed) lines.push(deltaLine(`object ${name}`, 'destructive'));
  for (const f of delta.fields) {
    const note =
      f.kind === 'modifying'
        ? `(${(f.changedKeys ?? []).join(', ')}${f.presentationOnly ? ' — presentation-only' : ''})`
        : '';
    lines.push(deltaLine(`field ${f.objectName}.${f.fieldName}`, f.kind, note));
  }
  for (const name of delta.relationships.added) {
    lines.push(deltaLine(`relationship ${name}`, 'additive'));
  }
  for (const name of delta.relationships.removed) {
    lines.push(deltaLine(`relationship ${name}`, 'destructive'));
  }
  for (const t of delta.tasks) lines.push(deltaLine(`task ${t.name}`, t.kind));
  for (const r of delta.roles) {
    lines.push(deltaLine(`role ${r.name}`, r.kind, '(roles are never modified in place)'));
  }
  return lines;
}

/** Subscription/webhook/action/hook delta lines (runtime wiring). */
function renderRuntimeDeltaLines(delta: ManifestDeltaWire): string[] {
  const lines: string[] = [];
  for (const s of delta.subscriptions.added) {
    lines.push(deltaLine(`subscription ${s}`, 'additive', '(re-synced)'));
  }
  for (const s of delta.subscriptions.changed) {
    lines.push(deltaLine(`subscription ${s}`, 'modifying', '(re-synced)'));
  }
  for (const s of delta.subscriptions.removed) {
    lines.push(deltaLine(`subscription ${s}`, 'destructive', '(unsubscribed — runtime wiring)'));
  }
  for (const w of delta.webhooks.added) lines.push(deltaLine(`webhook ${w}`, 'additive'));
  for (const w of delta.webhooks.changed) {
    lines.push(deltaLine(`webhook ${w}`, 'modifying', '(updated in place, secret preserved)'));
  }
  for (const w of delta.webhooks.removed) {
    lines.push(deltaLine(`webhook ${w}`, 'destructive', '(removed — runtime wiring)'));
  }
  for (const a of delta.actions.added) lines.push(deltaLine(`action ${a}`, 'additive'));
  for (const a of delta.actions.removed) lines.push(deltaLine(`action ${a}`, 'destructive'));
  for (const h of delta.hooks.added) lines.push(deltaLine(`hook ${h}`, 'additive'));
  for (const h of delta.hooks.removed) lines.push(deltaLine(`hook ${h}`, 'destructive'));
  return lines;
}

/** Renders the dry-run upgrade's schema previews (SQL + warnings/errors). */
export function renderPreviews(previews: UpgradePreviewWire[] | undefined): string[] {
  const lines: string[] = [];
  for (const p of previews ?? []) {
    lines.push(`  ${c.cyan(p.target)}`);
    for (const sql of p.sqlStatements) lines.push(`    ${c.dim(sql)}`);
    for (const w of p.warnings) lines.push(`    ${sym.warn} ${c.warn(w)}`);
    for (const e of p.errors) lines.push(`    ${sym.cross} ${c.danger(e)}`);
  }
  return lines;
}

/** Human label per code status (spec-07 table wording). */
export const CODE_STATUS_LABELS: Record<CodeFileDelta['status'], string> = {
  unchanged: 'unchanged',
  'update-available': 'update available',
  'modified-by-you': 'modified by you',
  'added-upstream': 'added upstream',
  'removed-upstream': 'removed upstream',
  yours: 'yours',
};

/** Renders the per-file code table (unchanged files summarized). */
export function renderCodeTable(deltas: CodeFileDelta[]): string[] {
  const lines: string[] = [];
  const interesting = deltas.filter((d) => d.status !== 'unchanged');
  for (const d of interesting) {
    const label = CODE_STATUS_LABELS[d.status];
    const painted =
      d.status === 'modified-by-you' || d.status === 'removed-upstream'
        ? c.warn(label)
        : d.status === 'yours'
          ? c.dim(label)
          : c.success(label);
    lines.push(`  ${sym.dot} ${c.cyan(d.path)} ${c.meteor('·')} ${painted}`);
  }
  const unchanged = deltas.length - interesting.length;
  if (unchanged > 0) lines.push(c.dim(`  (${unchanged} file(s) unchanged)`));
  if (deltas.length === 0) lines.push(c.dim('  (no vendored code)'));
  return lines;
}

/** The diff trailer: badge + digest, core-range check, dep implications. */
export function renderTrailer(target: UpdateTarget, serverVersion: string): string[] {
  const v = target.verified;
  const badge = tierBadge(v.tier, v.item.repository);
  const lines = [
    `${c.bold(target.name)}@${v.item.version} ${c.meteor('·')} ${badge} ${c.meteor('·')} ${c.dim(v.computedDigest.slice(0, 'sha256:'.length + 12))}…`,
  ];
  if (target.requiresCore) {
    const ok = semver.satisfies(serverVersion, target.requiresCore);
    lines.push(
      ok
        ? c.dim(`  requires core ${target.requiresCore} — server ${serverVersion} satisfies it`)
        : `  ${sym.warn} ${c.warn(`requires core ${target.requiresCore} but the server is ${serverVersion} — the server will enforce this`)}`,
    );
  }
  for (const dep of target.dependencyNotes) {
    const state = dep.installedVersion
      ? `${dep.installedVersion} installed, needs ${dep.range}`
      : `not installed, needs ${dep.range}`;
    lines.push(
      `  ${sym.warn} ${c.warn(`dependency ${dep.name}: ${state} — run: ion-drive update ${dep.name}`)}`,
    );
  }
  return lines;
}
