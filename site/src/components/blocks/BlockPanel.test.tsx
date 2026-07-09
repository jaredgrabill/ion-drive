/**
 * Block panel tests: version table (descending order, truncated digest +
 * copy-full-digest button, status pills, struck yanked rows, attestation
 * link vs em-dash), advisories, dependency links, requires, install snippet,
 * the sanitized README render (script tags stripped), and the omitted-README
 * degradation for blocks without `readmeUrl`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_INDEX_URL, installFixtureFetch } from '../../test/fixture-fetch.js';
import { BlockPanel, compareVersionsDesc } from './BlockPanel.js';
import { type RegistryIndexDoc, parseIndexDoc } from './registry/reader.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');
const fixtureIndex = (): RegistryIndexDoc =>
  parseIndexDoc(
    JSON.parse(readFileSync(path.join(fixtureDir, 'registry/index.json'), 'utf8')),
    FIXTURE_INDEX_URL,
  );

afterEach(() => vi.unstubAllGlobals());

function renderPanel(name: string) {
  const onNavigate = vi.fn();
  render(
    <BlockPanel
      index={fixtureIndex()}
      indexUrl={FIXTURE_INDEX_URL}
      name={name}
      onNavigate={onNavigate}
    />,
  );
  return onNavigate;
}

describe('compareVersionsDesc', () => {
  it('orders semver-ish versions newest first', () => {
    expect(['0.1.0', '0.10.0', '0.2.0'].sort(compareVersionsDesc)).toEqual([
      '0.10.0',
      '0.2.0',
      '0.1.0',
    ]);
  });
});

describe('version table', () => {
  it('renders versions with truncated digests, statuses, and attestation links', async () => {
    installFixtureFetch();
    renderPanel('crm');

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1); // skip header
    expect(rows).toHaveLength(2);

    // Latest first, truncated digest shown.
    expect(rows[0]).toHaveTextContent('0.2.0');
    expect(rows[0]).toHaveTextContent('sha256:a5db8b9f1a2b…');
    expect(rows[0]).toHaveTextContent('active');
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: 'attestation' }),
    ).toBeInTheDocument();

    // Yanked row is struck, carries its reason, and shows the em-dash for
    // the absent attestation.
    expect(rows[1]).toHaveClass('struck');
    expect(rows[1]).toHaveTextContent('yanked — bad seed data');
    expect(within(rows[1] as HTMLElement).queryByRole('link', { name: 'attestation' })).toBeNull();
    expect(rows[1]).toHaveTextContent('—');
  });

  it('copies the FULL digest on click', async () => {
    installFixtureFetch();
    renderPanel('crm');
    // userEvent installs its own clipboard stub — read back through it.
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /copy digest for 0\.2\.0/i }));
    expect(await window.navigator.clipboard.readText()).toBe(
      'sha256:a5db8b9f1a2b3096105afc35789bc760363c5472a6abe49da8f20ee5d7477294',
    );
  });

  it('marks deprecated versions', async () => {
    installFixtureFetch();
    renderPanel('billing');
    expect(await screen.findByText(/deprecated — upgrade to 1\.1\.0/)).toBeInTheDocument();
  });
});

describe('advisories', () => {
  it('renders advisory id, severity, affected range, and link', async () => {
    installFixtureFetch();
    renderPanel('crm');
    const section = await screen.findByRole('region', { name: /security advisories/i });
    expect(section).toHaveTextContent('IONB-2026-0001');
    expect(section).toHaveTextContent('moderate');
    expect(section).toHaveTextContent('<0.2.0');
    expect(within(section).getByRole('link', { name: 'details' })).toBeInTheDocument();
  });

  it('omits the section when there are none', async () => {
    installFixtureFetch();
    renderPanel('billing');
    await screen.findByRole('table');
    expect(screen.queryByRole('region', { name: /security advisories/i })).toBeNull();
  });
});

describe('requirements + install snippet', () => {
  it('lists requires.core and dependency links', async () => {
    installFixtureFetch();
    const onNavigate = renderPanel('crm');
    expect(await screen.findByText(/@ion-drive\/core >=0\.2\.0 <1\.0\.0/)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'tiny' }));
    expect(onNavigate).toHaveBeenCalledWith('/blocks/tiny');
  });

  it('shows the install snippet with a copy affordance', async () => {
    installFixtureFetch();
    renderPanel('crm');
    expect(await screen.findByText('ion-drive add crm')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'copy' }));
    expect(await window.navigator.clipboard.readText()).toBe('ion-drive add crm');
  });
});

describe('README (spec-08 readmeUrl)', () => {
  it('renders the sanitized README — script tags stripped', async () => {
    installFixtureFetch();
    renderPanel('crm');
    const readme = await screen.findByRole('region', { name: 'README' }, { timeout: 5000 });
    await waitFor(() => expect(readme).toHaveTextContent('What it installs'));
    expect(readme.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    // External links open safely.
    const link = within(readme).getByRole('link', { name: 'Ion Drive' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits the README section when the block advertises none', async () => {
    installFixtureFetch();
    renderPanel('tiny');
    await screen.findByRole('table');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'README' })).toBeNull());
  });
});
