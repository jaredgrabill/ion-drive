/**
 * Client-side block search — mirrors the CLI's `registry/search.ts` exactly:
 * case-insensitive substring over name/title/description/categories with a
 * stable field-weight ordering (name hits first, ties break by name), the
 * same across both paths (prebuilt search-index documents, or the fallback
 * over `index.json` summaries).
 */

import type { RegistryIndexDoc } from './reader.js';

/** The field a hit matched on — also its ordering weight (name wins). */
export type SearchMatchField = 'name' | 'title' | 'description' | 'categories';

const FIELD_WEIGHT: Record<SearchMatchField, number> = {
  name: 0,
  title: 1,
  description: 2,
  categories: 3,
};

/** A candidate document in the shape both paths normalize to. */
export interface SearchCandidate {
  name: string;
  title?: string;
  description?: string;
  categories?: string[];
  latest: string;
  /** Registry-asserted display hint (spec-01 §3) — never a computed tier. */
  trust?: string;
}

/** Lenient normalization of fetched search-index documents (unknowns tolerated). */
export function normalizeSearchDocuments(raw: unknown[]): SearchCandidate[] {
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

/** The fallback path: candidates straight from `index.json` summaries. */
export function candidatesFromIndex(index: RegistryIndexDoc): SearchCandidate[] {
  return Object.entries(index.blocks).map(([name, entry]) => ({
    name,
    title: entry.title,
    description: entry.description,
    categories: entry.categories,
    latest: entry.latest,
    trust: entry.trust,
  }));
}

/**
 * Case-insensitive substring match + stable field-weight ordering. An
 * empty/whitespace term returns every candidate (the browser shows the full
 * directory when the search box is empty), unlike the CLI which returns none
 * for its explicit `search <term>` command.
 */
export function matchAndRank(term: string, candidates: SearchCandidate[]): SearchCandidate[] {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return [...candidates].sort((a, b) => a.name.localeCompare(b.name));

  const hits: { candidate: SearchCandidate; matchedVia: SearchMatchField }[] = [];
  for (const candidate of candidates) {
    const matchedVia = matchField(needle, candidate);
    if (matchedVia !== null) hits.push({ candidate, matchedVia });
  }
  return hits
    .sort(
      (a, b) =>
        FIELD_WEIGHT[a.matchedVia] - FIELD_WEIGHT[b.matchedVia] ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .map((hit) => hit.candidate);
}

/** The highest-weight field containing the needle, or null for a non-match. */
function matchField(needle: string, candidate: SearchCandidate): SearchMatchField | null {
  if (candidate.name.toLowerCase().includes(needle)) return 'name';
  if (candidate.title?.toLowerCase().includes(needle)) return 'title';
  if (candidate.description?.toLowerCase().includes(needle)) return 'description';
  if (candidate.categories?.some((c) => c.toLowerCase().includes(needle))) return 'categories';
  return null;
}
