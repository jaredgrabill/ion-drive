/**
 * Unit tests for `ion-drive block verify` (spec-04 §2): the verdict on
 * digest OK/FAIL, present-but-invalid attestation exiting non-zero (unlike
 * `add`), `--against-installed` divergence detection (AC4), and the `--json`
 * contract — over an injected fetchImpl + fake verifier + fake server client.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledBlock, IonApiClient } from '../api-client.js';
import type { IonProjectConfig } from '../config.js';
import { resetRegistryCache } from '../registry/registry-client.js';
import type { AttestationOutcome, SigstoreVerifier } from '../registry/sigstore-adapter.js';
import { GITHUB_ACTIONS_ISSUER, computeDigest } from '../registry/verify.js';
import { blockVerifyCommand } from './verify.js';

const REG_URL = 'https://reg.test/registry/index.json';
const BLOCK_URL = 'https://reg.test/registry/blocks/crm.json';
const ARTIFACT_URL = 'https://reg.test/crm/dist/0.2.0/block.json';
const BUNDLE_URL = 'https://reg.test/crm/dist/0.2.0/block.json.sigstore.json';
const REPO = 'https://github.com/acme/blocks';

const artifactBytes = new TextEncoder().encode(JSON.stringify({ name: 'crm', version: '0.2.0' }));
const artifactDigest = computeDigest(artifactBytes);
const artifactHex = artifactDigest.replace('sha256:', '');

const config: IonProjectConfig = {
  serverUrl: 'http://localhost:3000',
  blocks: [],
  registries: { '@reg': REG_URL },
  defaultRegistry: '@reg',
};

const index = {
  schemaVersion: 1,
  name: 'Fixture',
  generatedAt: '2026-07-08T00:00:00Z',
  blocks: { crm: { latest: '0.2.0', blockUrl: 'blocks/crm.json' } },
};

function blockDoc(digest: string, withBundle = false) {
  return {
    schemaVersion: 1,
    name: 'crm',
    repository: REPO,
    latest: '0.2.0',
    versions: {
      '0.2.0': {
        artifactUrl: '../../crm/dist/0.2.0/block.json',
        digest,
        publishedAt: '2026-07-01T00:00:00Z',
        attestationUrl: withBundle ? '../../crm/dist/0.2.0/block.json.sigstore.json' : undefined,
        dependencies: {},
        requires: {},
        status: 'active',
      },
    },
    advisories: [],
  };
}

function fetchFor(routes: Record<string, Uint8Array | object>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) return new Response('nope', { status: 404 });
    const payload: ConstructorParameters<typeof Response>[0] =
      body instanceof Uint8Array ? body : JSON.stringify(body);
    return new Response(payload, { status: 200 });
  }) as typeof fetch;
}

const okVerifier: SigstoreVerifier = {
  async verifyBundle(): Promise<AttestationOutcome> {
    return {
      kind: 'verified',
      facts: {
        subjectDigests: [artifactHex],
        issuer: GITHUB_ACTIONS_ISSUER,
        sourceRepository: REPO,
      },
    };
  },
};

const invalidVerifier: SigstoreVerifier = {
  async verifyBundle(): Promise<AttestationOutcome> {
    return { kind: 'invalid', reason: 'bad signature' };
  },
};

const cacheRoot = mkdtempSync(join(tmpdir(), 'ion-verify-'));
afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));

beforeEach(() => {
  resetRegistryCache();
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function deps(routes: Record<string, Uint8Array | object>, verifier?: SigstoreVerifier) {
  return { config, fetchImpl: fetchFor(routes), verifier, cacheDir: join(cacheRoot, 'cache') };
}

describe('block verify — registry refs', () => {
  it('passes (exit 0) when the digest matches', async () => {
    await blockVerifyCommand(
      'crm@0.2.0',
      {},
      deps({
        [REG_URL]: index,
        [BLOCK_URL]: blockDoc(artifactDigest),
        [ARTIFACT_URL]: artifactBytes,
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('fails (exit 1) on a digest mismatch', async () => {
    await blockVerifyCommand(
      'crm@0.2.0',
      {},
      deps({
        [REG_URL]: index,
        [BLOCK_URL]: blockDoc(`sha256:${'0'.repeat(64)}`),
        [ARTIFACT_URL]: artifactBytes,
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it('a present-but-invalid bundle exits non-zero (unlike add) (AC2)', async () => {
    await blockVerifyCommand(
      'crm@0.2.0',
      {},
      deps(
        {
          [REG_URL]: index,
          [BLOCK_URL]: blockDoc(artifactDigest, true),
          [ARTIFACT_URL]: artifactBytes,
          [BUNDLE_URL]: { any: 'bundle' },
        },
        invalidVerifier,
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  it('--json prints one JSON object with the verdict', async () => {
    await blockVerifyCommand(
      'crm',
      { json: true },
      deps(
        {
          [REG_URL]: index,
          [BLOCK_URL]: blockDoc(artifactDigest, true),
          [ARTIFACT_URL]: artifactBytes,
          [BUNDLE_URL]: { any: 'bundle' },
        },
        okVerifier,
      ),
    );
    const spy = vi.mocked(console.log);
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(payload.name).toBe('crm');
    expect(payload.version).toBe('0.2.0'); // no selector → latest
    expect(payload.digest).toEqual({
      computed: artifactDigest,
      expected: artifactDigest,
      ok: true,
    });
    expect(payload.attestation.status).toBe('ok');
    expect(payload.tier).toBe('verified');
    expect(payload.publishedAt).toBe('2026-07-01T00:00:00Z');
    expect(payload.repository).toBe(REPO);
    expect(payload.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects a range selector with the exact-version message', async () => {
    await blockVerifyCommand(
      'crm@^0.2.0',
      {},
      deps({ [REG_URL]: index, [BLOCK_URL]: blockDoc(artifactDigest) }),
    );
    expect(process.exitCode).toBe(1);
  });
});

describe('block verify --against-installed (AC4)', () => {
  const routes = {
    [REG_URL]: index,
    [BLOCK_URL]: blockDoc(artifactDigest),
    [ARTIFACT_URL]: artifactBytes,
  };

  function installed(digest: string | null): Pick<IonApiClient, 'getBlock'> {
    return {
      getBlock: async (): Promise<InstalledBlock> => ({
        name: 'crm',
        version: '0.2.0',
        title: 'CRM',
        status: 'installed',
        createdObjects: [],
        installedAt: '2026-07-08T00:00:00Z',
        artifactDigest: digest,
      }),
    };
  }

  it('detects a ledger/registry digest divergence and exits non-zero', async () => {
    await blockVerifyCommand(
      'crm',
      { againstInstalled: true, json: true },
      { ...deps(routes), client: installed(`sha256:${'f'.repeat(64)}`) },
    );
    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
    expect(payload.installed.ok).toBe(false);
    expect(payload.installed.ledgerDigest).toBe(`sha256:${'f'.repeat(64)}`);
    expect(payload.installed.registryDigest).toBe(artifactDigest);
  });

  it('matches when the ledger digest equals the registry digest', async () => {
    await blockVerifyCommand(
      'crm',
      { againstInstalled: true },
      { ...deps(routes), client: installed(artifactDigest) },
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('a pre-spec-04 install (null ledger digest) is reported but not failed', async () => {
    await blockVerifyCommand(
      'crm',
      { againstInstalled: true },
      { ...deps(routes), client: installed(null) },
    );
    expect(process.exitCode).toBeUndefined();
  });
});

describe('block verify — URL refs', () => {
  it('computes and prints the digest with no expectation', async () => {
    await blockVerifyCommand(
      'https://x.test/block.json',
      { json: true },
      deps({ 'https://x.test/block.json': artifactBytes }),
    );
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]));
    expect(payload.digest.computed).toBe(artifactDigest);
    expect(payload.digest.expected).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});
