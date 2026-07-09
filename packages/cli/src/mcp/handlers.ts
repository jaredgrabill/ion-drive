/**
 * Registry MCP tool handlers (spec-08 §4) — **transport-free**.
 *
 * Plain async `(args) → JSON` functions with zero MCP-SDK imports and zero
 * stdout writes, so they are unit-testable as straight function calls and
 * reusable behind any transport (`mcp/server.ts` wraps them for stdio). Four
 * tools give agents first-class registry access:
 *
 *  - `search_blocks` — {@link searchRegistry} (search index or fallback).
 *  - `get_block` — the per-block version history, plus the README inlined
 *    when the block doc advertises `readmeUrl` (resolved + URL-guarded).
 *  - `list_registries` — the same rows as `ion-drive registry list --json`
 *    (shared {@link gatherRegistryRows} helper).
 *  - `preview_install` — the SHARED `add` pipeline ({@link buildVerifiedPlan},
 *    spec-08 AC4): full resolve + spec-04 digest/attestation verification,
 *    returning the plan + trust verdicts. **No changes are ever made.**
 *    Documented divergence from `add`: an unreachable server degrades to an
 *    empty server state + a warning in the result (`add` fails hard).
 *
 * These tools choose blocks; the *platform's* MCP surface at `/api/v1/mcp`
 * works with a server's installed data — a coding agent uses both.
 */

import { IonApiClient } from '../api-client.js';
import { type RegistryListRow, gatherRegistryRows } from '../commands/registry.js';
import { type IonProjectConfig, readConfig } from '../config.js';
import {
  type VerifiedItem,
  buildVerifiedPlan,
  emptyServerState,
  gatherServerState,
} from '../registry/preview.js';
import {
  type ResolvedRegistry,
  fetchArtifact,
  fetchBlock,
  resolveRegistry,
  resolveRegistryUrl,
  withParams,
} from '../registry/registry-client.js';
import { type SearchResult, searchRegistry } from '../registry/search.js';
import type { SigstoreVerifier } from '../registry/sigstore-adapter.js';

/** Injectable dependencies — tests pass fakes; production uses the defaults. */
export interface RegistryMcpDeps {
  /** Project config; default {@link readConfig} (cwd's ion.config.json). */
  config?: IonProjectConfig;
  /** Fetch override threaded through every registry read. */
  fetchImpl?: typeof fetch;
  /** Server client for preview_install's installed-state; default from config. */
  client?: IonApiClient;
  /** Bypass registry metadata cache reads. */
  noCache?: boolean;
  /** Sigstore verifier override (tests). */
  verifier?: SigstoreVerifier;
}

/** `search_blocks` result — the {@link SearchResult} plus the echoed term. */
export interface SearchBlocksResult extends SearchResult {
  term: string;
}

/** `get_block` result — the raw block doc plus the inlined README when advertised. */
export interface GetBlockResult {
  registry: string;
  /** Absolute URL of the `blocks/<name>.json` document. */
  url: string;
  /** The per-block version history exactly as the registry serves it. */
  block: Record<string, unknown>;
  /** README markdown, inlined when the doc advertises `readmeUrl`. */
  readme?: string;
  warnings: string[];
}

/** One `preview_install` plan line: identity + provenance verdicts, no UI. */
export interface PreviewPlanItem {
  name: string;
  version: string;
  source: string;
  registry?: string;
  sourceUrl?: string;
  isDependency: boolean;
  /** The digest verified over the actual artifact bytes (spec-04). */
  digest: string;
  /** Client-computed trust tier — never the registry's display hint. */
  tier: string;
  attestationStatus: string;
  attestedBy?: { repository: string; commit?: string };
  warnings: string[];
}

export interface PreviewInstallResult {
  ref: string;
  plan: PreviewPlanItem[];
  /** Names skipped because the installed version satisfies every range. */
  satisfied: string[];
  warnings: string[];
  /** Always false — this tool never installs, vendors, or writes anything. */
  changesApplied: false;
}

/** The transport-free handler set (see module JSDoc). */
export interface RegistryMcpHandlers {
  search_blocks(args: { term: string; registry?: string }): Promise<SearchBlocksResult>;
  get_block(args: { name: string; registry?: string }): Promise<GetBlockResult>;
  list_registries(): Promise<RegistryListRow[]>;
  preview_install(args: { ref: string }): Promise<PreviewInstallResult>;
}

/** Projects a verify-phase item into the wire shape (shared with the parity test). */
export function projectVerifiedItem(v: VerifiedItem): PreviewPlanItem {
  return {
    name: v.item.name,
    version: v.item.version,
    source: v.item.source,
    registry: v.item.registry,
    sourceUrl: v.item.sourceUrl,
    isDependency: v.item.isDependency,
    digest: v.computedDigest,
    tier: v.tier,
    attestationStatus: v.attestationStatus,
    attestedBy: v.attestedBy,
    warnings: [...v.item.warnings, ...v.warnings],
  };
}

/** Builds the four handlers over the injected (or default) dependencies. */
export function createRegistryMcpHandlers(deps: RegistryMcpDeps = {}): RegistryMcpHandlers {
  const config = deps.config ?? readConfig();
  const fetchOpts = { noCache: deps.noCache, fetchImpl: deps.fetchImpl };

  return {
    async search_blocks({ term, registry }) {
      const reg = resolveRegistry(registry, config);
      const result = await searchRegistry(term, reg, fetchOpts);
      return { term, ...result };
    },

    async get_block({ name, registry }) {
      const reg = resolveRegistry(registry, config);
      const { doc, url } = await fetchBlock(reg, name, fetchOpts);
      const warnings: string[] = [];
      const readme = await fetchReadme(reg, doc.readmeUrl, url, deps.fetchImpl, warnings);
      return {
        registry: reg.namespace,
        url,
        block: doc as unknown as Record<string, unknown>,
        ...(readme !== undefined ? { readme } : {}),
        warnings,
      };
    },

    async list_registries() {
      return gatherRegistryRows(config, { noCache: deps.noCache, fetchImpl: deps.fetchImpl });
    },

    async preview_install({ ref }) {
      const warnings: string[] = [];
      const client = deps.client ?? new IonApiClient(config.serverUrl, config.apiKey);
      let serverState: Awaited<ReturnType<typeof gatherServerState>>;
      try {
        serverState = await gatherServerState(client, config);
      } catch (err) {
        // Divergence from `add` (which fails hard): a preview without a
        // reachable server is still useful — plan as if nothing is installed.
        serverState = emptyServerState(config);
        warnings.push(
          `server at ${config.serverUrl} is unreachable — previewing without installed-block state (${(err as Error).message})`,
        );
      }

      const { plan, verified } = await buildVerifiedPlan(ref, config, {
        serverState,
        noCache: deps.noCache,
        fetchImpl: deps.fetchImpl,
        verifier: deps.verifier,
      });
      return {
        ref,
        plan: verified.map(projectVerifiedItem),
        satisfied: plan.satisfied,
        warnings: [...warnings, ...plan.warnings],
        changesApplied: false,
      };
    },
  };
}

/**
 * Fetches the block's README when `readmeUrl` is advertised: resolved
 * against the block file (spec-01 §2), permitted-URL-guarded, auth carried —
 * all via {@link fetchArtifact}. Failure is a warning, never a tool error
 * (the block data already answered the question).
 */
async function fetchReadme(
  reg: ResolvedRegistry,
  readmeUrl: string | undefined,
  blockUrl: string,
  fetchImpl: typeof fetch | undefined,
  warnings: string[],
): Promise<string | undefined> {
  if (readmeUrl === undefined) return undefined;
  const url = resolveRegistryUrl(readmeUrl, blockUrl);
  try {
    const { bytes } = await fetchArtifact(withParams(url, reg.params), reg.headers, { fetchImpl });
    return new TextDecoder().decode(bytes);
  } catch (err) {
    warnings.push(`readme advertised but unreadable: ${(err as Error).message}`);
    return undefined;
  }
}
