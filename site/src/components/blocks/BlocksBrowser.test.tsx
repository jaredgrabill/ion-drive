/**
 * Island-level degradation-matrix + routing tests (spec-10 AC3): index
 * unreachable ⇒ full offline notice; legacy index ⇒ the exact spec-01
 * message; future schemaVersion ⇒ unsupported message; happy path renders the
 * directory; the pushState router walks directory → panel → registries; a
 * block-doc failure stays in-panel with the directory reachable.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { FIXTURE_INDEX_URL, installFixtureFetch } from '../../test/fixture-fetch.js';
import { BlocksBrowser, parseRoute } from './BlocksBrowser.js';
import { LEGACY_INDEX_MESSAGE } from './registry/reader.js';

function renderAt(path: string) {
  window.history.pushState(null, '', path);
  return render(<BlocksBrowser registryUrl={FIXTURE_INDEX_URL} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState(null, '', '/');
});

describe('parseRoute', () => {
  it('maps /blocks paths and rejects everything else', () => {
    expect(parseRoute('/blocks')).toEqual({ kind: 'directory' });
    expect(parseRoute('/blocks/')).toEqual({ kind: 'directory' });
    expect(parseRoute('/blocks/registries')).toEqual({ kind: 'registries' });
    expect(parseRoute('/blocks/crm')).toEqual({ kind: 'block', name: 'crm' });
    expect(parseRoute('/blocks/crm/')).toEqual({ kind: 'block', name: 'crm' });
    expect(parseRoute('/')).toBeNull();
    expect(parseRoute('/docs/getting-started/')).toBeNull();
  });
});

describe('index failure modes', () => {
  it('shows the full offline notice when the registry is unreachable', async () => {
    installFixtureFetch({ '/registry/index.json': 'offline' });
    renderAt('/blocks/');
    expect(await screen.findByRole('alert')).toHaveTextContent(/registry unreachable/i);
    // The rest of the site stays reachable — the notice links into the docs.
    expect(screen.getByRole('link', { name: /docs/i })).toHaveAttribute(
      'href',
      '/docs/getting-started/',
    );
  });

  it('surfaces the exact legacy-index message', async () => {
    installFixtureFetch({
      '/registry/index.json': { body: { blocks: { crm: { latest: '0.1.0' } } } },
    });
    renderAt('/blocks/');
    expect(await screen.findByRole('alert')).toHaveTextContent(LEGACY_INDEX_MESSAGE);
  });

  it('surfaces the unsupported-format message for a future schemaVersion', async () => {
    installFixtureFetch({
      '/registry/index.json': {
        body: { schemaVersion: 2, name: 'X', generatedAt: 'now', blocks: {} },
      },
    });
    renderAt('/blocks/');
    expect(await screen.findByRole('alert')).toHaveTextContent(/unsupported format/);
    expect(screen.getByRole('alert')).toHaveTextContent(/schemaVersion 2/);
  });
});

describe('routing', () => {
  it('renders the directory, opens a block panel, and returns', async () => {
    installFixtureFetch();
    const user = userEvent.setup();
    renderAt('/blocks/');

    await user.click(await screen.findByRole('button', { name: /CRM/ }));
    expect(window.location.pathname).toBe('/blocks/crm');
    // findAllByText: the install command also appears in the async-rendered
    // README, so a single-element query is a race (flaked in CI 2026-07-14).
    expect((await screen.findAllByText(/ion-drive add crm/)).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'blocks' }));
    expect(window.location.pathname).toBe('/blocks/');
    expect(await screen.findByRole('heading', { name: 'Fixture Registry' })).toBeInTheDocument();
  });

  it('reaches the registries directory', async () => {
    installFixtureFetch();
    renderAt('/blocks/registries');
    expect(
      await screen.findByText(/listed means "reviewed for listing", not "code audited"/),
    ).toBeInTheDocument();
  });

  it('keeps a block-doc failure in-panel; the directory stays intact', async () => {
    installFixtureFetch({ '/registry/blocks/crm.json': { status: 500 } });
    const user = userEvent.setup();
    renderAt('/blocks/crm');
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i);

    await user.click(screen.getByRole('button', { name: 'blocks' }));
    expect(await screen.findByRole('heading', { name: 'Fixture Registry' })).toBeInTheDocument();
  });

  it('renders nothing when mounted on a non-/blocks path (the 404 fallback)', () => {
    installFixtureFetch();
    const { container } = renderAt('/some/other/page');
    expect(container).toBeEmptyDOMElement();
  });
});
