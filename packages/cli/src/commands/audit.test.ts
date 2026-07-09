/**
 * Unit tests for the `ion-drive audit` report assembly (spec-06 AC5): the
 * pure {@link assembleAuditReport} against fake registries/config/ledgers —
 * advisory hits (incl. the fails-closed invalid range), yanked/deprecated
 * status, digest drift, ledger drift, the informational update line, the
 * unauditable buckets, and the stable `--json` shape.
 */

import { describe, expect, it } from 'vitest';
import type { InstalledBlock } from '../api-client.js';
import type { InstalledBlockRecord } from '../config.js';
import type { RegistryBlockDoc } from '../registry/registry-client.js';
import { type AuditDoc, assembleAuditReport } from './audit.js';

function record(overrides: Partial<InstalledBlockRecord> = {}): InstalledBlockRecord {
  return {
    name: 'crm',
    version: '0.2.0',
    digest: 'sha256:aaa',
    source: '@ion',
    sourceUrl: 'https://registry.test/crm/dist/0.2.0/block.json',
    installedAt: '2026-07-08T00:00:00Z',
    ...overrides,
  };
}

function doc(overrides: Partial<RegistryBlockDoc> = {}): RegistryBlockDoc {
  return {
    schemaVersion: 1,
    name: 'crm',
    latest: '0.2.0',
    versions: {
      '0.2.0': {
        artifactUrl: '../../crm/dist/0.2.0/block.json',
        digest: 'sha256:aaa',
        dependencies: {},
        requires: {},
        status: 'active',
      },
    },
    advisories: [],
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<InstalledBlock> = {}): InstalledBlock {
  return {
    name: 'crm',
    version: '0.2.0',
    title: 'CRM',
    status: 'installed',
    createdObjects: [],
    installedAt: '2026-07-08T00:00:00Z',
    artifactDigest: 'sha256:aaa',
    ...overrides,
  };
}

const docsFor = (d: AuditDoc) => new Map<string, AuditDoc>([['crm', d]]);

describe('assembleAuditReport', () => {
  it('is clean for a matching record/doc/ledger', () => {
    const report = assembleAuditReport([record()], docsFor(doc()), new Map([['crm', ledgerRow()]]));
    expect(report.clean).toBe(true);
    expect(report.blocks[0]?.findings).toEqual([]);
    expect(report.unauditable).toEqual([]);
    expect(report.notices).toEqual([]);
  });

  it('flags an advisory hit on the installed version (exit-1 kind)', () => {
    const report = assembleAuditReport(
      [record()],
      docsFor(
        doc({
          advisories: [
            {
              id: 'ION-2026-001',
              severity: 'high',
              affectedVersions: '<0.2.1',
              description: 'SQL injection in seeds',
              url: 'https://example.test/adv',
              createdAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    expect(report.clean).toBe(false);
    const finding = report.blocks[0]?.findings[0];
    expect(finding?.kind).toBe('advisory');
    expect(finding?.severity).toBe('critical');
    expect(finding?.detail).toContain('ION-2026-001');
  });

  it('does not flag an advisory whose range excludes the installed version', () => {
    const report = assembleAuditReport(
      [record()],
      docsFor(
        doc({
          advisories: [
            {
              id: 'ION-2026-002',
              severity: 'low',
              affectedVersions: '<0.2.0',
              description: 'old versions only',
              createdAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    expect(report.clean).toBe(true);
  });

  it('fails closed on an invalid affectedVersions range, with a notice', () => {
    const report = assembleAuditReport(
      [record()],
      docsFor(
        doc({
          advisories: [
            {
              id: 'ION-2026-003',
              severity: 'high',
              affectedVersions: 'not-a-range',
              description: 'range typo',
              createdAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    expect(report.clean).toBe(false);
    expect(report.blocks[0]?.findings[0]?.kind).toBe('advisory');
    expect(report.notices.join('\n')).toMatch(/invalid affectedVersions.*fails closed/);
  });

  it('flags a yanked install (critical) and a deprecated one (warning)', () => {
    const yanked = assembleAuditReport(
      [record()],
      docsFor(
        doc({
          versions: {
            '0.2.0': {
              artifactUrl: 'x',
              digest: 'sha256:aaa',
              dependencies: {},
              requires: {},
              status: 'yanked',
              statusReason: 'bad migration',
              yankedAt: '2026-07-08T00:00:00Z',
            },
          },
        }),
      ),
    );
    expect(yanked.clean).toBe(false);
    expect(yanked.blocks[0]?.findings[0]).toMatchObject({ kind: 'yanked', severity: 'critical' });

    const deprecated = assembleAuditReport(
      [record()],
      docsFor(
        doc({
          versions: {
            '0.2.0': {
              artifactUrl: 'x',
              digest: 'sha256:aaa',
              dependencies: {},
              requires: {},
              status: 'deprecated',
            },
          },
        }),
      ),
    );
    expect(deprecated.clean).toBe(false);
    expect(deprecated.blocks[0]?.findings[0]).toMatchObject({
      kind: 'deprecated',
      severity: 'warning',
    });
  });

  it('flags digest drift loudly when the registry mutated a released version', () => {
    const report = assembleAuditReport(
      [record({ digest: 'sha256:aaa' })],
      docsFor(
        doc({
          versions: {
            '0.2.0': {
              artifactUrl: 'x',
              digest: 'sha256:bbb',
              dependencies: {},
              requires: {},
              status: 'active',
            },
          },
        }),
      ),
    );
    expect(report.clean).toBe(false);
    const finding = report.blocks[0]?.findings[0];
    expect(finding?.kind).toBe('digest_drift');
    expect(finding?.detail).toMatch(/registry mutated a released version/);
  });

  it('skips digest drift for pre-spec-04 records (null digest)', () => {
    const report = assembleAuditReport(
      [record({ digest: null })],
      docsFor(
        doc({
          versions: {
            '0.2.0': {
              artifactUrl: 'x',
              digest: 'sha256:bbb',
              dependencies: {},
              requires: {},
              status: 'active',
            },
          },
        }),
      ),
    );
    expect(report.clean).toBe(true);
  });

  it('treats an installed version missing from the registry as digest drift', () => {
    const report = assembleAuditReport([record({ version: '0.1.0' })], docsFor(doc()));
    expect(report.clean).toBe(false);
    expect(report.blocks[0]?.findings[0]?.kind).toBe('digest_drift');
  });

  it('flags ledger drift (version and digest) and out-of-band removal', () => {
    const versionDrift = assembleAuditReport(
      [record()],
      docsFor(doc()),
      new Map([['crm', ledgerRow({ version: '0.3.0' })]]),
    );
    expect(versionDrift.clean).toBe(false);
    expect(versionDrift.blocks[0]?.findings[0]?.kind).toBe('ledger_drift');

    const digestDrift = assembleAuditReport(
      [record()],
      docsFor(doc()),
      new Map([['crm', ledgerRow({ artifactDigest: 'sha256:ccc' })]]),
    );
    expect(digestDrift.clean).toBe(false);

    const removed = assembleAuditReport([record()], docsFor(doc()), new Map());
    expect(removed.clean).toBe(false);
    expect(removed.blocks[0]?.findings[0]?.detail).toMatch(/not installed on the server/);
  });

  it('reports a newer active version as informational only', () => {
    const report = assembleAuditReport(
      [record()],
      docsFor(
        doc({
          latest: '0.3.0',
          versions: {
            '0.2.0': {
              artifactUrl: 'x',
              digest: 'sha256:aaa',
              dependencies: {},
              requires: {},
              status: 'active',
            },
            '0.3.0': {
              artifactUrl: 'y',
              digest: 'sha256:bbb',
              dependencies: {},
              requires: {},
              status: 'active',
            },
          },
        }),
      ),
    );
    expect(report.clean).toBe(true); // informational — never exit 1
    expect(report.blocks[0]?.findings[0]).toMatchObject({
      kind: 'update_available',
      severity: 'info',
    });
  });

  it('buckets local/URL installs as unauditable (informational)', () => {
    const report = assembleAuditReport(
      [
        record({ name: 'mine', source: 'local', digest: 'sha256:x' }),
        record({ name: 'oneoff', source: 'https://x.test/block.json' }),
      ],
      new Map(),
    );
    expect(report.clean).toBe(true);
    expect(report.unauditable.map((u) => u.name).sort()).toEqual(['mine', 'oneoff']);
  });

  it('buckets an unreachable registry as unauditable with a notice, not a failure', () => {
    const report = assembleAuditReport([record()], docsFor('unreachable'));
    expect(report.clean).toBe(true);
    expect(report.unauditable[0]?.reason).toMatch(/could not be fetched/);
    expect(report.notices[0]).toMatch(/unreachable/);
  });

  it('produces the stable --json shape', () => {
    const report = assembleAuditReport([record()], docsFor(doc()), new Map([['crm', ledgerRow()]]));
    expect(Object.keys(report).sort()).toEqual(['blocks', 'clean', 'notices', 'unauditable']);
    expect(report.blocks[0] && Object.keys(report.blocks[0]).sort()).toEqual([
      'findings',
      'name',
      'source',
      'version',
    ]);
  });
});
