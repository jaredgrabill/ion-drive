/**
 * Block panel (`/blocks/<name>`, client-routed) — everything a
 * `blocks/<name>.json` carries: version table (publishedAt, truncated digest
 * with copy button, status, attestation link when present), advisories,
 * dependencies (linked), `requires`, the install snippet, honest trust copy,
 * and the sanitized README when the registry advertises `readmeUrl`
 * (spec-08). Every optional field degrades to an omitted section; a fetch
 * failure is an in-panel error — the directory stays intact.
 */

import { useEffect, useState } from 'react';
import { Readme } from './Readme.js';
import { TrustBadge } from './TrustBadge.js';
import { loadBlock, loadReadme } from './registry/client.js';
import type {
  RegistryBlockDoc,
  RegistryIndexDoc,
  RegistryVersionEntry,
} from './registry/reader.js';

interface BlockPanelProps {
  index: RegistryIndexDoc;
  indexUrl: string;
  name: string;
  onNavigate: (path: string) => void;
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; doc: RegistryBlockDoc; blockUrl: string };

/** Loose semver-ish descending order for display (newest first). */
export function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split('-')[0]
      ?.split('.')
      .map((n) => Number.parseInt(n, 10) || 0) ?? [];
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

function truncateDigest(digest: string): string {
  const hex = digest.replace(/^sha256:/, '');
  return `sha256:${hex.slice(0, 12)}…`;
}

export function BlockPanel({ index, indexUrl, name, onNavigate }: BlockPanelProps) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [readme, setReadme] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setReadme(null);
    loadBlock(index, indexUrl, name)
      .then(async ({ doc, blockUrl }) => {
        if (cancelled) return;
        setState({ status: 'ready', doc, blockUrl });
        const md = await loadReadme(doc, blockUrl);
        if (!cancelled && md !== null) setReadme(md);
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', message: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [index, indexUrl, name]);

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => setCopied(label),
      () => setCopied(null),
    );
  };

  const crumbs = (
    <p className="crumbs">
      <button type="button" onClick={() => onNavigate('/blocks/')}>
        blocks
      </button>{' '}
      / {name}
    </p>
  );

  if (state.status === 'loading') {
    return (
      <div className="block-panel">
        {crumbs}
        <output>loading {name}…</output>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="block-panel">
        {crumbs}
        <div className="notice error" role="alert">
          <h3>Could not load “{name}”</h3>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  const { doc } = state;
  const entryTrust = index.blocks[name]?.trust;
  const versions = Object.entries(doc.versions).sort(([a], [b]) => compareVersionsDesc(a, b));
  const latestEntry: RegistryVersionEntry | undefined = doc.versions[doc.latest];
  const dependencies = Object.entries(latestEntry?.dependencies ?? {});
  const requiresCore =
    typeof latestEntry?.requires.core === 'string' ? latestEntry.requires.core : null;

  return (
    <div className="block-panel">
      {crumbs}
      <h2>
        <code>{doc.name}</code> {entryTrust !== undefined && <TrustBadge trust={entryTrust} />}
      </h2>
      {doc.description !== undefined && <p className="blocks-head">{doc.description}</p>}

      <div className="install-snippet">
        <code>ion-drive add {doc.name}</code>
        <button
          type="button"
          className="copy-btn"
          onClick={() => copy(`ion-drive add ${doc.name}`, 'install')}
        >
          {copied === 'install' ? 'copied' : 'copy'}
        </button>
      </div>

      <div className="table-scroll">
        <table className="version-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>Digest</th>
              <th>Status</th>
              <th>Attestation</th>
            </tr>
          </thead>
          <tbody>
            {versions.map(([version, entry]) => (
              <tr key={version} className={entry.status === 'yanked' ? 'struck' : ''}>
                <td>
                  <code>{version}</code>
                  {version === doc.latest && <span className="status-pill"> · latest</span>}
                </td>
                <td>{entry.publishedAt !== undefined ? entry.publishedAt.slice(0, 10) : '—'}</td>
                <td>
                  <span className="digest">{truncateDigest(entry.digest)}</span>
                  <button
                    type="button"
                    className="copy-btn"
                    aria-label={`Copy digest for ${version}`}
                    onClick={() => copy(entry.digest, `digest-${version}`)}
                  >
                    {copied === `digest-${version}` ? 'copied' : 'copy'}
                  </button>
                </td>
                <td>
                  <span className="status-pill" data-status={entry.status}>
                    {entry.status}
                    {entry.statusReason !== undefined ? ` — ${entry.statusReason}` : ''}
                  </span>
                </td>
                <td>
                  {entry.attestationUrl !== undefined ? (
                    <a href={entry.attestationUrl} target="_blank" rel="noopener noreferrer">
                      attestation
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {doc.advisories.length > 0 && (
        <section aria-label="Security advisories">
          <h3>Advisories</h3>
          {doc.advisories.map((advisory) => (
            <div key={advisory.id} className="advisory">
              <span className="sev">{advisory.severity}</span>
              <strong>{advisory.id}</strong> · affects {advisory.affectedVersions} —{' '}
              {advisory.description}{' '}
              {advisory.url !== undefined && (
                <a href={advisory.url} target="_blank" rel="noopener noreferrer">
                  details
                </a>
              )}
            </div>
          ))}
        </section>
      )}

      {(dependencies.length > 0 || requiresCore !== null) && (
        <section aria-label="Requirements">
          <h3>Requires</h3>
          <ul className="starlist">
            {requiresCore !== null && (
              <li>
                <code>@ion-drive/core {requiresCore}</code>
              </li>
            )}
            {dependencies.map(([dep, range]) => (
              <li key={dep}>
                <button
                  type="button"
                  className="linklike"
                  onClick={() => onNavigate(`/blocks/${encodeURIComponent(dep)}`)}
                >
                  {dep}
                </button>{' '}
                <code>{range}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {doc.repository !== undefined && (
        <p>
          Source:{' '}
          <a href={doc.repository} target="_blank" rel="noopener noreferrer">
            {doc.repository}
          </a>
        </p>
      )}

      <p className="trust-note">
        Digests and trust marks shown here are registry-asserted. Verify the artifact locally —{' '}
        <code>ion-drive block verify {doc.name}</code> — before installing;{' '}
        <code>ion-drive add</code> verifies automatically.
      </p>

      {readme !== null && (
        <section className="readme" aria-label="README">
          <Readme markdown={readme} />
        </section>
      )}
    </div>
  );
}
