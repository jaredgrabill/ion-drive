/**
 * Directory (`/blocks`) — cards from `index.json` (title, description,
 * categories, latest, trust *hint* badge), a category filter, and client-side
 * search: the prebuilt `search-index.json` when the index advertises
 * `searchUrl` (spec-08), else substring over the index entries — the exact
 * CLI fallback. A block entry with nothing but the load-bearing fields still
 * renders as a name-only card.
 */

import { useEffect, useMemo, useState } from 'react';
import { TrustBadge } from './TrustBadge.js';
import { loadSearchDocuments } from './registry/client.js';
import type { RegistryIndexDoc } from './registry/reader.js';
import {
  type SearchCandidate,
  candidatesFromIndex,
  matchAndRank,
  normalizeSearchDocuments,
} from './registry/search.js';

interface DirectoryProps {
  index: RegistryIndexDoc;
  indexUrl: string;
  onNavigate: (path: string) => void;
}

export function Directory({ index, indexUrl, onNavigate }: DirectoryProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [searchDocs, setSearchDocs] = useState<SearchCandidate[] | null>(null);
  const [searchWarning, setSearchWarning] = useState<string | null>(null);

  useEffect(() => {
    if (index.searchUrl === undefined) return;
    let cancelled = false;
    loadSearchDocuments(index, indexUrl)
      .then((docs) => {
        if (!cancelled) setSearchDocs(normalizeSearchDocuments(docs));
      })
      .catch((err) => {
        if (!cancelled) {
          setSearchWarning(
            `search index unusable (${(err as Error).message}) — searching the registry index instead`,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [index, indexUrl]);

  const candidates = searchDocs ?? candidatesFromIndex(index);
  const categories = useMemo(
    () => [...new Set(candidates.flatMap((c) => c.categories ?? []))].sort(),
    [candidates],
  );

  let hits = matchAndRank(query, candidates);
  if (category !== null) hits = hits.filter((hit) => hit.categories?.includes(category));

  return (
    <>
      <div className="blocks-head">
        <p className="eyebrow">Block registry</p>
        <h2>{index.name}</h2>
        {index.description && <p>{index.description}</p>}
      </div>

      <div className="blocks-toolbar">
        <input
          type="search"
          placeholder="Search blocks…"
          aria-label="Search blocks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {categories.map((cat) => (
          <button
            key={cat}
            type="button"
            className="category-chip"
            aria-pressed={category === cat}
            onClick={() => setCategory(category === cat ? null : cat)}
          >
            {cat}
          </button>
        ))}
      </div>
      {searchWarning !== null && query.trim() !== '' && (
        <p className="trust-note">{searchWarning}</p>
      )}

      {hits.length === 0 ? (
        <div className="notice">
          <p>No blocks match. Clear the search or category filter to see the full directory.</p>
        </div>
      ) : (
        <div className="block-grid">
          {hits.map((hit) => (
            <button
              key={hit.name}
              type="button"
              className="block-card"
              onClick={() => onNavigate(`/blocks/${encodeURIComponent(hit.name)}`)}
            >
              <p className="block-name">
                <code>{hit.name}</code>
                {hit.title !== undefined && <span className="block-title">{hit.title}</span>}
                {hit.trust !== undefined && <TrustBadge trust={hit.trust} />}
              </p>
              {hit.description !== undefined && <p className="block-desc">{hit.description}</p>}
              <span className="block-meta">
                v{hit.latest}
                {hit.categories && hit.categories.length > 0 && ` · ${hit.categories.join(', ')}`}
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="trust-note">
        Trust badges are registry-asserted hints. Verify locally before installing:{' '}
        <code>ion-drive block verify &lt;name&gt;</code>. Third-party registries are listed in the{' '}
        <button type="button" className="linklike" onClick={() => onNavigate('/blocks/registries')}>
          registries directory
        </button>
        .
      </p>
    </>
  );
}
