/**
 * Directory tests: cards (incl. the name-only minimal card), trust badges,
 * category filter, and both search paths — the prebuilt search index when
 * `searchUrl` is advertised, the index-substring fallback when it is absent
 * or unusable (with the warning surfaced) — the exact CLI posture.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_INDEX_URL, installFixtureFetch } from '../../test/fixture-fetch.js';
import { Directory } from './Directory.js';
import { type RegistryIndexDoc, parseIndexDoc } from './registry/reader.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');
const fixtureIndex = (): RegistryIndexDoc =>
  parseIndexDoc(
    JSON.parse(readFileSync(path.join(fixtureDir, 'registry/index.json'), 'utf8')),
    FIXTURE_INDEX_URL,
  );

function renderDirectory(index = fixtureIndex()) {
  const onNavigate = vi.fn();
  render(<Directory index={index} indexUrl={FIXTURE_INDEX_URL} onNavigate={onNavigate} />);
  return onNavigate;
}

afterEach(() => vi.unstubAllGlobals());

describe('cards', () => {
  it('renders title, description, latest, categories, and the trust hint badge', async () => {
    installFixtureFetch();
    renderDirectory();
    const crm = await screen.findByRole('button', { name: /CRM/ });
    expect(crm).toHaveTextContent('stage-tracked sales pipeline');
    expect(crm).toHaveTextContent('v0.2.0');
    expect(crm).toHaveTextContent('sales, crm');
    expect(crm).toHaveTextContent('official');
  });

  it('renders a name-only card for an entry with only load-bearing fields', async () => {
    installFixtureFetch();
    renderDirectory();
    const tiny = await screen.findByRole('button', { name: /tiny/ });
    expect(tiny).toHaveTextContent('v1.0.0');
  });

  it('navigates to the block panel on click', async () => {
    installFixtureFetch();
    const onNavigate = renderDirectory();
    await userEvent.setup().click(await screen.findByRole('button', { name: /Billing/ }));
    expect(onNavigate).toHaveBeenCalledWith('/blocks/billing');
  });
});

describe('search — prebuilt index path (searchUrl advertised)', () => {
  it('substring-matches over name/title/description/categories', async () => {
    installFixtureFetch();
    renderDirectory();
    const user = userEvent.setup();
    const box = await screen.findByRole('searchbox');

    await user.type(box, 'pipeline'); // matches crm's description only
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /CRM/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Billing/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /tiny/ })).not.toBeInTheDocument();
    });
  });
});

describe('search — index fallback', () => {
  it('falls back to substring over index entries when no searchUrl is advertised', async () => {
    installFixtureFetch();
    const { searchUrl: _dropped, ...rest } = fixtureIndex();
    renderDirectory(rest as RegistryIndexDoc);
    const user = userEvent.setup();

    await user.type(await screen.findByRole('searchbox'), 'commerce'); // billing's category
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Billing/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /CRM/ })).not.toBeInTheDocument();
    });
  });

  it('warns and falls back when the advertised search index is unusable', async () => {
    installFixtureFetch({ '/registry/search-index.json': { status: 500 } });
    renderDirectory();
    const user = userEvent.setup();

    await user.type(await screen.findByRole('searchbox'), 'crm');
    expect(await screen.findByText(/search index unusable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CRM/ })).toBeInTheDocument();
  });
});

describe('category filter', () => {
  it('filters cards by the pressed category chip', async () => {
    installFixtureFetch();
    renderDirectory();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'commerce' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Billing/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /CRM/ })).not.toBeInTheDocument();
    });

    // Toggling off restores the full directory.
    await user.click(screen.getByRole('button', { name: 'commerce' }));
    expect(await screen.findByRole('button', { name: /CRM/ })).toBeInTheDocument();
  });
});

describe('trust copy', () => {
  it('points at local verification', async () => {
    installFixtureFetch();
    renderDirectory();
    expect(await screen.findByText(/ion-drive block verify/)).toBeInTheDocument();
  });
});
