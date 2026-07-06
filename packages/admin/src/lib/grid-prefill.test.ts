/** Unit tests for the one-shot grid search prefill handoff. */

import { beforeEach, describe, expect, it } from 'vitest';
import { consumeGridSearchPrefill, setGridSearchPrefill } from './grid-prefill';

const KEY = 'ion-grid-prefill-search';

describe('grid search prefill', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips a term for the matching object', () => {
    setGridSearchPrefill('contacts', 'acme');
    expect(consumeGridSearchPrefill('contacts')).toBe('acme');
  });

  it('is one-shot — a second consume returns null', () => {
    setGridSearchPrefill('contacts', 'acme');
    consumeGridSearchPrefill('contacts');
    expect(consumeGridSearchPrefill('contacts')).toBeNull();
  });

  it('returns null for a different object and still clears the flag', () => {
    setGridSearchPrefill('contacts', 'acme');
    expect(consumeGridSearchPrefill('companies')).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    // The stale flag must not fire for the original object later either.
    expect(consumeGridSearchPrefill('contacts')).toBeNull();
  });

  it('returns null when nothing was stored', () => {
    expect(consumeGridSearchPrefill('contacts')).toBeNull();
  });

  it('tolerates malformed stored values', () => {
    sessionStorage.setItem(KEY, 'not json');
    expect(consumeGridSearchPrefill('contacts')).toBeNull();
    sessionStorage.setItem(KEY, JSON.stringify({ object: 'contacts', term: 42 }));
    expect(consumeGridSearchPrefill('contacts')).toBeNull();
    sessionStorage.setItem(KEY, JSON.stringify(null));
    expect(consumeGridSearchPrefill('contacts')).toBeNull();
  });
});
