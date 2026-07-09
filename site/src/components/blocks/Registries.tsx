/**
 * Registries directory (`/blocks/registries`) — renders `registries.json`
 * (from the index's `registriesUrl`, else its sibling) with the mandatory
 * "listed ≠ audited" disclaimer and the PR submission process. No usable
 * directory ⇒ a calm empty state, never an error.
 */

import { useEffect, useState } from 'react';
import { TrustBadge } from './TrustBadge.js';
import { loadRegistriesDirectory } from './registry/client.js';
import type { RegistriesDirectoryDoc, RegistryIndexDoc } from './registry/reader.js';

interface RegistriesProps {
  index: RegistryIndexDoc;
  indexUrl: string;
  onNavigate: (path: string) => void;
}

export function Registries({ index, indexUrl, onNavigate }: RegistriesProps) {
  const [directory, setDirectory] = useState<RegistriesDirectoryDoc | null | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    loadRegistriesDirectory(index, indexUrl).then((doc) => {
      if (!cancelled) setDirectory(doc);
    });
    return () => {
      cancelled = true;
    };
  }, [index, indexUrl]);

  return (
    <div>
      <p className="crumbs">
        <button type="button" onClick={() => onNavigate('/blocks/')}>
          blocks
        </button>{' '}
        / registries
      </p>
      <div className="blocks-head">
        <p className="eyebrow">Registries directory</p>
        <h2>Known block registries</h2>
        <p>
          Anyone can self-host a protocol-v1 registry. This directory lists the ones reviewed for
          listing — <strong>listed means "reviewed for listing", not "code audited"</strong>. Always
          verify what you install: <code>ion-drive block verify &lt;name&gt;</code>.
        </p>
      </div>

      {directory === 'loading' && <output>loading registries…</output>}

      {directory === null && (
        <div className="notice">
          <p>
            This registry publishes no registries directory. The official directory lives in the{' '}
            <a
              href="https://github.com/jaredgrabill/ion-drive-blocks"
              target="_blank"
              rel="noopener noreferrer"
            >
              ion-drive-blocks
            </a>{' '}
            repo.
          </p>
        </div>
      )}

      {directory !== null && directory !== 'loading' && (
        <div className="registry-list">
          {directory.registries.map((reg) => (
            <div key={reg.namespace} className="notice">
              <h3>
                <code>{reg.namespace}</code>{' '}
                {reg.trust !== undefined && <TrustBadge trust={reg.trust} />}
              </h3>
              {reg.description !== undefined && <p>{reg.description}</p>}
              {reg.owner !== undefined && <p>Owner: {reg.owner}</p>}
              <p className="digest">{reg.url}</p>
              {reg.repository !== undefined && (
                <p>
                  <a href={reg.repository} target="_blank" rel="noopener noreferrer">
                    repository
                  </a>
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="trust-note">
        Run your own registry? Get it listed by opening a pull request against{' '}
        <code>registries.json</code> in the{' '}
        <a
          href="https://github.com/jaredgrabill/ion-drive-blocks"
          target="_blank"
          rel="noopener noreferrer"
        >
          ion-drive-blocks
        </a>{' '}
        repo — listing review checks the registry serves valid protocol-v1 JSON, nothing more.
      </p>
    </div>
  );
}
