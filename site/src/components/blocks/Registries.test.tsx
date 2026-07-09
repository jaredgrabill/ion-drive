/**
 * Registries directory tests: renders `registries.json` from the advertised
 * `registriesUrl` with the "listed ≠ audited" disclaimer + PR process, probes
 * the index's sibling when none is advertised, and shows a calm empty state
 * when neither exists.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_INDEX_URL, installFixtureFetch } from '../../test/fixture-fetch.js';
import { Registries } from './Registries.js';
import { type RegistryIndexDoc, parseIndexDoc } from './registry/reader.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');
const fixtureIndex = (): RegistryIndexDoc =>
  parseIndexDoc(
    JSON.parse(readFileSync(path.join(fixtureDir, 'registry/index.json'), 'utf8')),
    FIXTURE_INDEX_URL,
  );

afterEach(() => vi.unstubAllGlobals());

function renderRegistries(index: RegistryIndexDoc) {
  render(<Registries index={index} indexUrl={FIXTURE_INDEX_URL} onNavigate={vi.fn()} />);
}

describe('registries directory', () => {
  it('renders entries from the advertised registriesUrl with the disclaimer', async () => {
    installFixtureFetch();
    renderRegistries(fixtureIndex());

    expect(await screen.findByText('@ion')).toBeInTheDocument();
    expect(screen.getByText('@acme')).toBeInTheDocument();
    expect(
      screen.getByText(/listed means "reviewed for listing", not "code audited"/),
    ).toBeInTheDocument();
    // The PR submission process is described.
    expect(screen.getByText(/opening a pull request/)).toBeInTheDocument();
  });

  it('probes the sibling registries.json when none is advertised', async () => {
    const { registriesUrl: _dropped, ...rest } = fixtureIndex();
    const sibling = JSON.parse(readFileSync(path.join(fixtureDir, 'registries.json'), 'utf8'));
    installFixtureFetch({ '/registry/registries.json': { body: sibling } });
    renderRegistries(rest as RegistryIndexDoc);
    expect(await screen.findByText('@ion')).toBeInTheDocument();
  });

  it('shows the empty state when no directory is available', async () => {
    const { registriesUrl: _dropped, ...rest } = fixtureIndex();
    installFixtureFetch({ '/registry/registries.json': { status: 404 } });
    renderRegistries(rest as RegistryIndexDoc);
    expect(await screen.findByText(/publishes no registries directory/)).toBeInTheDocument();
  });
});
