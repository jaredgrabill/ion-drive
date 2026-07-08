/**
 * Dependency resolver — expands a requested block ref into an install-ordered
 * plan (spec-03 §4).
 *
 * Pure planning over injected IO ({@link ResolverIO}) — unit-testable with
 * fake fetchers, no network. The algorithm, per the spec:
 *
 * 1. **Closure walk** (BFS from the root). Registry blocks are planned from
 *    their `blocks/<name>.json` version history — the mirrored `dependencies`
 *    mean **no artifact is fetched during planning**. The **same-registry
 *    rule**: a bare dep name resolves in the registry the *depending block*
 *    came from (never the consumer's default; a local/URL root's bare deps
 *    use the default — no source registry exists); `@ns/…` deps require
 *    `@ns` in the consumer's config. No silent cross-registry fallback, ever
 *    (the anti-dependency-confusion rule). Two registries supplying the same
 *    bare name in one plan is a hard error (blocks are singletons).
 * 2. **Range collection**: `name → [{range, requiredBy}]` across the closure;
 *    the CLI selector is one more entry, `requiredBy: "you"`.
 * 3. **Selection**: highest version with `status: "active"` (deprecated warns;
 *    yanked is excluded — except an exact selector matching a version already
 *    recorded in `ion.config.json.blocks[]`, the re-install path, warned
 *    loudly) satisfying **every** collected range (`semver.satisfies` per
 *    candidate — no range-intersection algebra). None ⇒ error listing every
 *    constraint with its requiredBy.
 * 4. **Installed pruning/conflicts**: an installed version satisfying all
 *    ranges is pruned to `satisfied` (a `--force` root is kept — reinstall);
 *    installed-but-violating is an error naming the `ion-drive update` fix
 *    (`--force` downgrades to a warning and proceeds).
 * 5. **Order**: topological sort, dependencies first; cycles fail fast.
 * 6. **Suggestions**: unknown names get a Levenshtein-≤2 "did you mean".
 *
 * `requires.core` is checked against the server's version → warning only
 * (the server enforces at install, spec-02).
 */

import semver from 'semver';
import type { InstalledBlockRecord, IonProjectConfig } from '../config.js';
import { type RegistryBlockDoc, resolveRegistryUrl } from './protocol.js';
import { type ParsedRef, splitBlockRef } from './ref.js';
import type { Manifest, ResolvedRegistry } from './registry-client.js';
import { dependencyRecordOf, resolveRegistry } from './registry-client.js';

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** The IO the resolver plans over — injected so tests run with fakes. */
export interface ResolverIO {
  fetchIndex(reg: ResolvedRegistry): Promise<{ blocks: Record<string, unknown> }>;
  fetchBlock(reg: ResolvedRegistry, name: string): Promise<{ doc: RegistryBlockDoc; url: string }>;
  getLocalOrUrlManifest(ref: Extract<ParsedRef, { kind: 'url' | 'local' }>): Promise<Manifest>;
}

/** One block to install, in plan order. */
export interface PlanItem {
  name: string;
  version: string;
  /** Where it comes from: `@ns`, `local`, or a direct URL. */
  source: string;
  /** Absolute artifact URL (registry and URL items). */
  sourceUrl?: string;
  /** Registry namespace (registry items) — the installer re-resolves it for auth. */
  registry?: string;
  /** The manifest, already in hand (local/URL items only). */
  manifest?: Manifest;
  isDependency: boolean;
  /** Status warnings for this block (deprecated, yanked re-install, …). */
  warnings: string[];
}

export interface InstallPlan {
  /** Blocks to install, dependencies first. */
  items: PlanItem[];
  /** Names skipped because the installed version satisfies every range. */
  satisfied: string[];
  /** Plan-level warnings (core-range skew, forced conflicts, …). */
  warnings: string[];
}

export interface ResolveOptions {
  config: IonProjectConfig;
  /** Installed blocks on the server: name → version. */
  installed: Map<string, string>;
  /** The local config's `blocks[]` (the yanked exact-reinstall exception, C9). */
  recordedBlocks: InstalledBlockRecord[];
  /** The server's core version (from `/health`) for `requires.core` warnings. */
  serverCoreVersion?: string;
  /** Proceed through installed-version conflicts; keep an installed root in the plan. */
  force?: boolean;
  io: ResolverIO;
  /** Env override for registry resolution (tests). */
  env?: Record<string, string | undefined>;
}

/** A dependency requirement collected during the walk. */
interface Requirement {
  range: string;
  requiredBy: string;
}

/** One queued closure-walk step: "resolve `name` in `namespace`". */
interface WalkRequest {
  name: string;
  namespace: string;
  requirement?: Requirement;
  /** True when this came from a *bare* dependency name (same-registry rule). */
  bare: boolean;
}

/** A registry block gathered by the closure walk. */
interface RegistryNode {
  namespace: string;
  reg: ResolvedRegistry;
  doc: RegistryBlockDoc;
  /** Absolute URL of `blocks/<name>.json` — what artifactUrls resolve against. */
  blockUrl: string;
}

/** Builds an ordered install plan for `ref` (an already-parsed CLI ref). */
export async function resolvePlan(ref: ParsedRef, opts: ResolveOptions): Promise<InstallPlan> {
  const walk = new ClosureWalk(opts);
  await walk.run(ref);
  return walk.finish(ref);
}

/** The resolver's working state — a class keeps the multi-step flow readable. */
class ClosureWalk {
  private readonly ranges = new Map<string, Requirement[]>();
  private readonly nodes = new Map<string, RegistryNode>();
  private rootName = '';
  private rootManifest?: { manifest: Manifest; source: string; sourceUrl?: string };
  private readonly planWarnings: string[] = [];

  constructor(private readonly opts: ResolveOptions) {}

  /** Step 1+2: BFS the closure, collecting ranges. */
  async run(ref: ParsedRef): Promise<void> {
    const queue = await this.seedQueue(ref);

    while (queue.length > 0) {
      const req = queue.shift();
      if (!req) break;
      if (req.requirement) this.addRange(req.name, req.requirement);

      // A dep naming the manifest root itself just constrains its version.
      if (this.rootManifest && req.name === this.rootName) continue;

      queue.push(...(await this.visitBlock(req)));
    }
  }

  /** Seeds the walk from the root ref (registry name vs local/URL manifest). */
  private async seedQueue(ref: ParsedRef): Promise<WalkRequest[]> {
    if (ref.kind === 'registry') {
      this.rootName = ref.name;
      return [
        {
          name: ref.name,
          namespace: ref.namespace ?? this.defaultNamespace(),
          requirement: ref.selector ? { range: ref.selector, requiredBy: 'you' } : undefined,
          bare: false,
        },
      ];
    }
    // Local/URL root: the manifest is in hand; its bare deps resolve in the
    // consumer's default registry (no source registry exists — C5).
    const manifest = await this.opts.io.getLocalOrUrlManifest(ref);
    this.rootName = manifest.name;
    this.rootManifest = {
      manifest,
      source: ref.kind === 'local' ? 'local' : ref.url,
      sourceUrl: ref.kind === 'url' ? ref.url : undefined,
    };
    return Object.entries(dependencyRecordOf(manifest)).map(([depRef, range]) =>
      this.depRequest(depRef, range, manifest.name, this.defaultNamespace()),
    );
  }

  /**
   * Fetches one registry block into the node map and returns its dependency
   * requests (empty when the name was already walked — after the singleton
   * collision check).
   */
  private async visitBlock(req: WalkRequest): Promise<WalkRequest[]> {
    const existing = this.nodes.get(req.name);
    const reg = resolveRegistry(req.namespace, this.opts.config, this.opts.env);
    if (existing) {
      if (existing.reg.url !== reg.url) {
        throw new ResolveError(
          `Block name collision: "${req.name}" is supplied by both ${existing.namespace} (${existing.reg.url}) and ${req.namespace} (${reg.url}). Blocks are singletons per server — pick one registry for "${req.name}".`,
        );
      }
      return []; // already walked; the new range was collected by the caller
    }

    const index = await this.opts.io.fetchIndex(reg);
    if (!(req.name in index.blocks)) {
      throw this.unknownBlockError(req, reg, Object.keys(index.blocks));
    }
    const { doc, url } = await this.opts.io.fetchBlock(reg, req.name);
    this.nodes.set(req.name, { namespace: req.namespace, reg, doc, blockUrl: url });

    // Candidate with the ranges known so far — just to read its mirrored
    // deps (spec step 1); the *final* pick re-runs with all ranges.
    const candidate = this.selectVersion(req.name, doc).version;
    const entry = doc.versions[candidate];
    return Object.entries(entry?.dependencies ?? {}).map(([depRef, range]) =>
      this.depRequest(depRef, range, req.name, req.namespace),
    );
  }

  /** Steps 3–5: final selection, installed pruning, topo order. */
  finish(ref: ParsedRef): InstallPlan {
    const selections = new Map<string, { version: string; warnings: string[] }>();
    for (const [name, node] of this.nodes) selections.set(name, this.selectVersion(name, node.doc));

    this.checkRootManifestRanges();

    const satisfied: string[] = [];
    const pruned = new Set<string>();
    for (const name of [...this.nodes.keys(), ...(this.rootManifest ? [this.rootName] : [])]) {
      if (this.pruneInstalled(name, selections.get(name)?.version)) {
        satisfied.push(name);
        pruned.add(name);
      }
    }

    const order = this.topoSort();
    const items: PlanItem[] = [];
    for (const name of order) {
      if (pruned.has(name)) continue;
      items.push(this.buildItem(name, ref, selections.get(name)));
    }
    this.warnOnCoreRange(items, selections);
    return { items, satisfied, warnings: this.planWarnings };
  }

  // --- Walk helpers ----------------------------------------------------------

  private defaultNamespaceMemo?: string;

  private defaultNamespace(): string {
    if (!this.defaultNamespaceMemo) {
      // resolveRegistry(undefined) validates defaultRegistry exists; we only
      // need its namespace here (no headers/params yet).
      this.defaultNamespaceMemo = resolveRegistry(
        undefined,
        this.opts.config,
        this.opts.env,
      ).namespace;
    }
    return this.defaultNamespaceMemo;
  }

  /** Turns one `dependencies` entry into a queue request (same-registry rule). */
  private depRequest(
    depRef: string,
    range: string,
    requiredBy: string,
    ownNamespace: string,
  ): WalkRequest {
    const parts = splitBlockRef(depRef);
    if (!parts) {
      throw new ResolveError(
        `"${requiredBy}" declares an invalid dependency ref "${depRef}" (expected "name" or "@ns/name").`,
      );
    }
    return {
      name: parts.name,
      // Bare dep ⇒ the registry the depending block came from — never a
      // silent cross-registry fallback.
      namespace: parts.namespace ?? ownNamespace,
      requirement: { range, requiredBy },
      bare: parts.namespace === undefined,
    };
  }

  private addRange(name: string, requirement: Requirement): void {
    const list = this.ranges.get(name) ?? [];
    list.push(requirement);
    this.ranges.set(name, list);
  }

  /** The two flavors of "not in that registry": bare dep vs direct ask. */
  private unknownBlockError(
    req: WalkRequest,
    reg: ResolvedRegistry,
    available: string[],
  ): ResolveError {
    const suggestion = closestName(req.name, available);
    const didYouMean = suggestion ? ` Did you mean \`${suggestion}\`?` : '';
    if (req.bare && req.requirement) {
      // The same-registry rule's documented error: name the block, the
      // registry, and the fix — never fall back to another registry.
      return new ResolveError(
        `"${req.requirement.requiredBy}" depends on "${req.name}", which is not in ${req.namespace} (${reg.url}). Bare dependency names resolve only in the registry the depending block came from — add it explicitly first (\`ion-drive add @other/${req.name}\`) or ask the block author to publish "${req.name}" to ${req.namespace}.${didYouMean}`,
      );
    }
    const known = available.sort().join(', ') || '(registry is empty)';
    return new ResolveError(
      `Unknown block "${req.name}" in ${req.namespace} (${reg.url}).${didYouMean}${didYouMean ? '' : ` Available: ${known}`}`,
    );
  }

  // --- Selection ---------------------------------------------------------------

  /**
   * Highest version satisfying every collected range, honoring status rules.
   * With no ranges at all, the registry's `latest` wins (spec §2).
   */
  private selectVersion(
    name: string,
    doc: RegistryBlockDoc,
  ): { version: string; warnings: string[] } {
    const reqs = this.ranges.get(name) ?? [];
    const exactReinstall = this.exactReinstallVersion(name, doc);
    const candidates = Object.keys(doc.versions)
      .filter((v) => semver.valid(v) !== null)
      .filter((v) => doc.versions[v]?.status !== 'yanked' || v === exactReinstall)
      .sort(semver.rcompare);

    let pick: string | undefined;
    if (reqs.length === 0 && candidates.includes(doc.latest)) {
      pick = doc.latest;
    } else {
      pick = candidates.find((v) => reqs.every((r) => semver.satisfies(v, r.range)));
    }
    if (!pick) throw this.noSatisfyingVersionError(name, doc, reqs);

    const warnings: string[] = [];
    const entry = doc.versions[pick];
    if (entry?.status === 'deprecated') {
      warnings.push(
        `${name}@${pick} is deprecated${entry.statusReason ? `: ${entry.statusReason}` : ''}`,
      );
    }
    if (entry?.status === 'yanked') {
      warnings.push(
        `${name}@${pick} was YANKED${entry.statusReason ? ` (${entry.statusReason})` : ''} — re-installing only because it is recorded in ion.config.json`,
      );
    }
    return { version: pick, warnings };
  }

  /**
   * The yanked exception (spec-01 §5): an exact CLI selector for the root
   * that matches a version recorded in the *local* config's `blocks[]` (C9)
   * stays installable — existing deployments keep working.
   */
  private exactReinstallVersion(name: string, doc: RegistryBlockDoc): string | undefined {
    const reqs = this.ranges.get(name) ?? [];
    const exact = reqs.find(
      (r) => r.requiredBy === 'you' && semver.valid(r.range) !== null && r.range in doc.versions,
    )?.range;
    if (!exact) return undefined;
    const recorded = this.opts.recordedBlocks.some((b) => b.name === name && b.version === exact);
    return recorded ? exact : undefined;
  }

  private noSatisfyingVersionError(
    name: string,
    doc: RegistryBlockDoc,
    reqs: Requirement[],
  ): ResolveError {
    const constraints =
      reqs.length > 0
        ? reqs.map((r) => `  ${r.range} (required by ${r.requiredBy})`).join('\n')
        : '  (no installable versions)';
    const available = Object.entries(doc.versions)
      .map(([v, e]) => (e.status === 'active' ? v : `${v} (${e.status})`))
      .join(', ');
    return new ResolveError(
      `No version of "${name}" satisfies all constraints:\n${constraints}\nAvailable: ${available}`,
    );
  }

  // --- Installed pruning / conflicts --------------------------------------------

  /** Returns true when the installed version covers `name` (prune to satisfied). */
  private pruneInstalled(name: string, selectedVersion: string | undefined): boolean {
    const installedVersion = this.opts.installed.get(name);
    if (installedVersion === undefined) return false;

    const reqs = this.ranges.get(name) ?? [];
    const violated = reqs.find((r) => !semver.satisfies(installedVersion, r.range));
    if (!violated) {
      // Satisfies everything. A --force root is kept in the plan (reinstall).
      if (name === this.rootName && this.opts.force) {
        this.planWarnings.push(
          `${name} ${installedVersion} is already installed — reinstalling (--force)`,
        );
        return false;
      }
      return true;
    }

    const who = violated.requiredBy === 'you' ? 'you need' : `${violated.requiredBy} needs`;
    const message = `${name} ${installedVersion} is installed but ${who} ${violated.range} — run \`ion-drive update ${name}\``;
    if (!this.opts.force) throw new ResolveError(message);
    this.planWarnings.push(
      `${message} (--force: proceeding${selectedVersion ? ` with ${name}@${selectedVersion}` : ''})`,
    );
    return false;
  }

  /** A local/URL root's fixed version must satisfy any ranges deps put on it. */
  private checkRootManifestRanges(): void {
    if (!this.rootManifest) return;
    const version = String(this.rootManifest.manifest.version ?? '0.1.0');
    const reqs = this.ranges.get(this.rootName) ?? [];
    const violated = reqs.find(
      (r) => semver.valid(version) !== null && !semver.satisfies(version, r.range),
    );
    if (!violated) return;
    const message = `${this.rootName}@${version} does not satisfy ${violated.range} (required by ${violated.requiredBy})`;
    if (!this.opts.force) throw new ResolveError(message);
    this.planWarnings.push(`${message} (--force: proceeding)`);
  }

  // --- Ordering + item construction ----------------------------------------------

  /** Dependencies before dependents; cycles fail fast with the chain. */
  private topoSort(): string[] {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const depsOf = (name: string): string[] => {
      if (name === this.rootName && this.rootManifest) {
        return Object.keys(dependencyRecordOf(this.rootManifest.manifest))
          .map((ref) => splitBlockRef(ref)?.name)
          .filter((n): n is string => n !== undefined);
      }
      const node = this.nodes.get(name);
      if (!node) return [];
      const version = this.selectVersion(name, node.doc).version;
      return Object.keys(node.doc.versions[version]?.dependencies ?? {})
        .map((ref) => splitBlockRef(ref)?.name)
        .filter((n): n is string => n !== undefined);
    };

    const visit = (name: string, trail: string[]): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new ResolveError(`Circular dependency: ${[...trail, name].join(' → ')}`);
      }
      if (!this.nodes.has(name) && !(this.rootManifest && name === this.rootName)) return;
      visiting.add(name);
      for (const dep of depsOf(name)) visit(dep, [...trail, name]);
      visiting.delete(name);
      visited.add(name);
      ordered.push(name);
    };

    for (const name of this.nodes.keys()) visit(name, []);
    if (this.rootManifest) visit(this.rootName, []);
    return ordered;
  }

  private buildItem(
    name: string,
    ref: ParsedRef,
    selection: { version: string; warnings: string[] } | undefined,
  ): PlanItem {
    if (this.rootManifest && name === this.rootName) {
      return {
        name,
        version: String(this.rootManifest.manifest.version ?? '0.1.0'),
        source: this.rootManifest.source,
        sourceUrl: this.rootManifest.sourceUrl,
        manifest: this.rootManifest.manifest,
        isDependency: false,
        warnings: [],
      };
    }
    const node = this.nodes.get(name);
    if (!node || !selection) throw new ResolveError(`Internal: no plan node for "${name}"`); // unreachable
    const entry = node.doc.versions[selection.version];
    if (!entry) throw new ResolveError(`Internal: no version entry for "${name}"`); // unreachable
    return {
      name,
      version: selection.version,
      source: node.namespace,
      registry: node.namespace,
      // Artifact URLs resolve against the block file they appear in (spec-01 §2).
      sourceUrl: resolveRegistryUrl(entry.artifactUrl, node.blockUrl),
      isDependency: !(ref.kind === 'registry' && ref.name === name),
      warnings: selection.warnings,
    };
  }

  /** `requires.core` skew is a warning during planning; the server enforces. */
  private warnOnCoreRange(
    items: PlanItem[],
    selections: Map<string, { version: string; warnings: string[] }>,
  ): void {
    const server = this.opts.serverCoreVersion;
    if (!server || semver.valid(semver.coerce(server) ?? '') === null) return;
    for (const item of items) {
      const core = this.coreRangeOf(item, selections);
      if (core && !semver.satisfies(server, core)) {
        this.planWarnings.push(
          `${item.name}@${item.version} requires core ${core} but the server is ${server} — the server will enforce this at install`,
        );
      }
    }
  }

  private coreRangeOf(
    item: PlanItem,
    selections: Map<string, { version: string; warnings: string[] }>,
  ): string | undefined {
    if (item.manifest) {
      const requires = item.manifest.requires as { core?: string } | undefined;
      return typeof requires?.core === 'string' ? requires.core : undefined;
    }
    const node = this.nodes.get(item.name);
    const version = selections.get(item.name)?.version;
    const core = version ? node?.doc.versions[version]?.requires?.core : undefined;
    return typeof core === 'string' ? core : undefined;
  }
}

// --- Levenshtein "did you mean" -------------------------------------------------

/** The closest known name within edit distance 2, if any. */
export function closestName(input: string, known: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of known) {
    const distance = levenshtein(input, name);
    if (distance <= 2 && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

/** Classic two-row Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((prev[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    prev = current;
  }
  return prev[b.length] ?? Number.MAX_SAFE_INTEGER;
}
