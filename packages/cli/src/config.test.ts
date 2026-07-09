/**
 * Unit tests for the spec-03 config revision: the registries map + built-in
 * `@ion`, `ION_DRIVE_REGISTRY` override, `${VAR}` expansion (fail-fast,
 * named), migration + secret-hygiene warnings, and the enriched `blocks[]`
 * install record (recordInstalled/recordRemoved).
 */

import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_REGISTRIES,
  ConfigError,
  type IonProjectConfig,
  configWarnings,
  defaultRegistryNamespace,
  effectiveRegistries,
  expandEnvPlaceholders,
  recordInstalled,
  recordRemoved,
} from './config.js';

const base: IonProjectConfig = { serverUrl: 'http://localhost:3000', blocks: [] };

describe('effectiveRegistries', () => {
  it('includes the built-in @ion when registries is absent', () => {
    const registries = effectiveRegistries(base, {});
    expect(registries['@ion']?.url).toBe(BUILT_IN_REGISTRIES['@ion']);
    expect(registries['@ion']).toEqual({
      url: BUILT_IN_REGISTRIES['@ion'],
      headers: {},
      params: {},
    });
  });

  it('lets a declared @ion override the built-in URL', () => {
    const cfg = { ...base, registries: { '@ion': 'https://mirror.test/index.json' } };
    expect(effectiveRegistries(cfg, {})['@ion']?.url).toBe('https://mirror.test/index.json');
  });

  it('normalizes string and object entries', () => {
    const cfg = {
      ...base,
      registries: {
        '@a': 'https://a.test/index.json',
        '@b': {
          url: 'https://b.test/index.json',
          headers: { authorization: 'Bearer ${T}' },
          params: { token: '${T}' },
        },
      },
    };
    const registries = effectiveRegistries(cfg, {});
    expect(registries['@a']).toEqual({ url: 'https://a.test/index.json', headers: {}, params: {} });
    expect(registries['@b']).toEqual({
      url: 'https://b.test/index.json',
      headers: { authorization: 'Bearer ${T}' },
      params: { token: '${T}' },
    });
  });

  it('applies ION_DRIVE_REGISTRY to the default registry URL only', () => {
    const cfg = {
      ...base,
      registries: { '@acme': 'https://acme.test/index.json' },
      defaultRegistry: '@acme',
    };
    const registries = effectiveRegistries(cfg, {
      ION_DRIVE_REGISTRY: 'https://override.test/index.json',
    });
    expect(registries['@acme']?.url).toBe('https://override.test/index.json');
    expect(registries['@ion']?.url).toBe(BUILT_IN_REGISTRIES['@ion']); // untouched
  });
});

describe('defaultRegistryNamespace', () => {
  it('defaults to @ion', () => {
    expect(defaultRegistryNamespace(base)).toBe('@ion');
  });

  it('errors when defaultRegistry names an unconfigured namespace', () => {
    expect(() => defaultRegistryNamespace({ ...base, defaultRegistry: '@nope' })).toThrow(
      ConfigError,
    );
    expect(() => defaultRegistryNamespace({ ...base, defaultRegistry: '@nope' })).toThrow(
      /add @nope to registries/,
    );
  });
});

describe('expandEnvPlaceholders', () => {
  it('replaces ${VAR} from the environment', () => {
    expect(expandEnvPlaceholders('Bearer ${TOKEN}', { TOKEN: 'abc' }, '@acme')).toBe('Bearer abc');
  });

  it('fails fast with the variable name and registry when unset', () => {
    expect(() => expandEnvPlaceholders('Bearer ${ACME_REGISTRY_TOKEN}', {}, '@acme')).toThrow(
      /ACME_REGISTRY_TOKEN is not set.*@acme/,
    );
  });

  it('leaves plain values untouched', () => {
    expect(expandEnvPlaceholders('no placeholders', {}, '@acme')).toBe('no placeholders');
  });
});

describe('configWarnings', () => {
  it('warns once about the dropped legacy registryUrl field', () => {
    const warnings = configWarnings({ registryUrl: 'https://old.test/index.json' });
    expect(warnings).toEqual([
      '`registryUrl` is no longer read — declare it under `registries` and set `defaultRegistry`',
    ]);
  });

  it('warns about literal-looking secrets in headers/params', () => {
    const warnings = configWarnings({
      registries: {
        '@acme': {
          url: 'https://acme.test/index.json',
          // Any 20+ char literal token trips the warning; deliberately NOT
          // shaped like a real provider key so secret scanners never flag it.
          headers: { authorization: 'Bearer fake-literal-token-long-enough-to-warn' },
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('use `${ENV_VAR}` — this file gets committed');
  });

  it('does not warn about ${VAR} placeholders or plain string entries', () => {
    expect(
      configWarnings({
        registries: {
          '@a': 'https://a.test/index.json',
          '@b': {
            url: 'https://b.test/index.json',
            headers: { authorization: 'Bearer ${ACME_REGISTRY_TOKEN_WITH_LONG_NAME}' },
          },
        },
      }),
    ).toEqual([]);
  });
});

describe('install records', () => {
  it('recordInstalled writes the enriched record and stamps installedAt', () => {
    const next = recordInstalled(base, {
      name: 'crm',
      version: '0.2.0',
      digest: null,
      source: '@ion',
      sourceUrl: 'https://registry.iondrive.dev/crm/dist/0.2.0/block.json',
    });
    expect(next.blocks).toHaveLength(1);
    const record = next.blocks[0];
    expect(record).toMatchObject({
      name: 'crm',
      version: '0.2.0',
      digest: null,
      source: '@ion',
      sourceUrl: 'https://registry.iondrive.dev/crm/dist/0.2.0/block.json',
    });
    expect(Date.parse(record?.installedAt ?? '')).not.toBeNaN();
  });

  it('recordInstalled replaces an existing record for the same name', () => {
    const first = recordInstalled(base, {
      name: 'crm',
      version: '0.1.0',
      digest: null,
      source: 'local',
    });
    const second = recordInstalled(first, {
      name: 'crm',
      version: '0.2.0',
      digest: null,
      source: '@ion',
    });
    expect(second.blocks).toHaveLength(1);
    expect(second.blocks[0]?.version).toBe('0.2.0');
  });

  it('recordRemoved deletes the record (AC7 — audit trusts this)', () => {
    const withBlock = recordInstalled(base, {
      name: 'crm',
      version: '0.2.0',
      digest: null,
      source: '@ion',
    });
    expect(recordRemoved(withBlock, 'crm').blocks).toEqual([]);
  });
});
