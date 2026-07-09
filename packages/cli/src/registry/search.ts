/**
 * Registry search (spec-08 §2) — the pure lookup behind `ion-drive search`
 * and the registry MCP's `search_blocks` tool.
 *
 * Two paths, one result shape:
 *
 *  - **Search index** — when the registry's `index.json` advertises
 *    `searchUrl` (spec-08 emission), the prebuilt
 *    `registry/search-index.json` is fetched (resolved per spec-01's
 *    relative-URL rules, permitted-URL-guarded, with the registry's auth
 *    headers/params) and lenient-parsed: `{ documents: [...] }` or a bare
 *    array both work, unknown fields pass through. Any fetch/parse failure
 *    **warns and falls back** — search never fails harder than the fallback.
 *  - **Index fallback** — substring match straight over `index.json`'s
 *    `blocks` summaries, so every protocol-v1 registry is searchable with
 *    zero extra requirements.
 *
 * Matching is case-insensitive substring over name/title/description/
 * categories with a stable field-weight ordering (name hits first, then
 * title, description, categories; ties break by name), so results are
 * deterministic across both paths.
 */

import {
  type FetchOptions,
  type ResolvedRegistry,
  fetchIndex,
  fetchSearchDocuments,
} from './registry-client.js';

/** The field a hit matched on — also its ordering weight (name wins). */
export type SearchMatchField = 'name' | 'title' | 'description' | 'categories';

const FIELD_WEIGHT: Record<SearchMatchField, number> = {
  name: 0,
  title: 1,
  description: 2,
  categories: 3,
};

/** One search hit, normalized across the search-index and fallback paths. */
export interface SearchHit {
  name: string;
  title?: string;
  description?: string;
  categories?: string[];
  latest: string;
  /** Registry-asserted display hint (spec-01 §3) — never a computed tier. */
  trust?: string;
  /** The namespace the hit came from (`@ion`, `@acme`, …). */
  registry: string;
  /** Which field matched (the highest-weight one when several did). */
  matchedVia: SearchMatchField;
}

export interface SearchResult {
  /** Namespace + index URL searched. */
  registry: string;
  url: string;
  /** Which path produced the hits. */
  source: 'search-index' | 'index';
  hits: SearchHit[];
  /** Notices (e.g. the search index was advertised but unusable). */
  warnings: string[];
}

/** A candidate document in the shape both paths normalize to. */
interface SearchCandidate {
  name: string;
  title?: string;
  description?: string;
  categories?: string[];
  latest: string;
  trust?: string;
}

/**
 * Searches one registry for `term`. Prefers the advertised search index;
 * warns + falls back to `index.json` substring matching when it is absent or
 * unusable. Case-insensitive; empty/whitespace terms match nothing.
 */
export async function searchRegistry(
  term: string,
  reg: ResolvedRegistry,
  opts: FetchOptions = {},
): Promise<SearchResult> {
  const warnings: string[] = [];
  const index = await fetchIndex(reg, opts);

  let candidates: SearchCandidate[] | null = null;
  let source: SearchResult['source'] = 'index';
  if (index.searchUrl !== undefined) {
    try {
      candidates = normalizeSearchDocuments(await fetchSearchDocuments(reg, index.searchUrl, opts));
      source = 'search-index';
    } catch (err) {
      warnings.push(
        `search index unusable (${(err as Error).message}) — falling back to the registry index`,
      );
    }
  }
  if (candidates === null) {
    candidates = Object.entries(index.blocks).map(([name, entry]) => ({
      name,
      title: entry.title,
      description: entry.description,
      categories: entry.categories,
      latest: entry.latest,
      trust: entry.trust,
    }));
    source = 'index';
  }

  return {
    registry: reg.namespace,
    url: reg.url,
    source,
    hits: matchAndRank(term, candidates, reg.namespace),
    warnings,
  };
}

/** Lenient normalization of fetched search-index documents (unknowns tolerated). */
function normalizeSearchDocuments(raw: unknown[]): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  for (const doc of raw) {
    if (typeof doc !== 'object' || doc === null) continue;
    const record = doc as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.latest !== 'string') continue;
    candidates.push({
      name: record.name,
      title: typeof record.title === 'string' ? record.title : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
      categories: Array.isArray(record.categories)
        ? record.categories.filter((c): c is string => typeof c === 'string')
        : undefined,
      latest: record.latest,
      trust: typeof record.trust === 'string' ? record.trust : undefined,
    });
  }
  return candidates;
}

/** Case-insensitive substring match + stable field-weight ordering. */
function matchAndRank(term: string, candidates: SearchCandidate[], registry: string): SearchHit[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const candidate of candidates) {
    const matchedVia = matchField(needle, candidate);
    if (matchedVia !== null) hits.push({ ...candidate, registry, matchedVia });
  }
  return hits.sort(
    (a, b) =>
      FIELD_WEIGHT[a.matchedVia] - FIELD_WEIGHT[b.matchedVia] || a.name.localeCompare(b.name),
  );
}

/** The highest-weight field containing the needle, or null for a non-match. */
function matchField(needle: string, candidate: SearchCandidate): SearchMatchField | null {
  if (candidate.name.toLowerCase().includes(needle)) return 'name';
  if (candidate.title?.toLowerCase().includes(needle)) return 'title';
  if (candidate.description?.toLowerCase().includes(needle)) return 'description';
  if (candidate.categories?.some((c) => c.toLowerCase().includes(needle))) return 'categories';
  return null;
}
