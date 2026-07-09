/**
 * Unit tests for the pure block-test evaluators (spec-06): the install-report
 * coverage matrix, the action-response classification rules, the block
 * footprint, and the orphan-doctor teeth ({@link evaluateDoctorReport} must
 * fail when an uninstall leaves a footprint table behind — AC2's second half).
 */

import { describe, expect, it } from 'vitest';
import type { DoctorReportWire, InstallReport } from '../api-client.js';
import type { Manifest } from '../registry/registry-client.js';
import {
  blockFootprint,
  classifyActionResponse,
  evaluateDoctorReport,
  evaluateInstallReport,
} from './assertions.js';

const emptyReport: InstallReport = {
  block: 'crm',
  version: '0.2.0',
  dryRun: false,
  objectsCreated: [],
  objectsSkipped: [],
  relationshipsCreated: [],
  recordsSeeded: {},
  tasksCreated: [],
  rolesCreated: [],
  rolesSkipped: [],
  warnings: [],
};

describe('evaluateInstallReport', () => {
  const manifest = {
    name: 'crm',
    objects: [{ name: 'leads' }, { name: 'deals' }],
    relationships: [{ name: 'company' }],
    tasks: [{ name: 'nightly' }],
    roles: [{ name: 'sales' }],
    actions: [{ name: 'convert_lead' }],
    hooks: [{ name: 'inbound' }],
    webhooks: [{ name: 'notify' }],
    subscriptions: [{ event: 'data.#', consumer: 'audit', handler: 'persist_event' }],
  } as unknown as Manifest;

  it('passes when everything declared is created or explainably skipped', () => {
    const result = evaluateInstallReport(manifest, {
      ...emptyReport,
      objectsCreated: ['leads'],
      objectsSkipped: ['deals'],
      relationshipsCreated: ['company'],
      tasksCreated: [],
      rolesCreated: ['sales'],
      actionsExposed: ['convert_lead'],
      hooksExposed: ['inbound'],
      webhooksCreated: { notify: 'whsec_x' },
      subscriptionsRegistered: ['audit ← data.#'],
      warnings: ['Task "nightly" already exists — skipped.'],
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.notices).toEqual(['Task "nightly" already exists — skipped.']);
  });

  it('fails naming each declared item the report does not account for', () => {
    const result = evaluateInstallReport(manifest, {
      ...emptyReport,
      objectsCreated: ['leads'],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/object "deals"/);
    expect(result.problems.join('\n')).toMatch(/relationship "company"/);
    expect(result.problems.join('\n')).toMatch(/action "convert_lead"/);
    expect(result.problems.join('\n')).toMatch(/webhook "notify"/);
    expect(result.problems.join('\n')).toMatch(/1 subscription\(s\)/);
  });

  it('accepts a webhook covered by webhooksSkipped', () => {
    const slim = { name: 'x', webhooks: [{ name: 'notify' }] } as unknown as Manifest;
    const result = evaluateInstallReport(slim, { ...emptyReport, webhooksSkipped: ['notify'] });
    expect(result.ok).toBe(true);
  });
});

describe('classifyActionResponse (the spec-06 reachability rules)', () => {
  it('passes any 2xx', () => {
    expect(classifyActionResponse('ping', false, undefined, 200, undefined).ok).toBe(true);
    expect(classifyActionResponse('ping', true, undefined, 201, undefined).ok).toBe(true);
  });

  it('passes a 400 only for the no-fixture {} probe', () => {
    expect(classifyActionResponse('ping', false, undefined, 400, 'invalid input').ok).toBe(true);
    expect(classifyActionResponse('ping', true, undefined, 400, 'invalid input').ok).toBe(false);
  });

  it('demands the exact status when a fixture sets expectStatus', () => {
    expect(classifyActionResponse('ping', true, 402, 402, undefined).ok).toBe(true);
    const miss = classifyActionResponse('ping', true, 200, 400, 'bad');
    expect(miss.ok).toBe(false);
    expect(miss.detail).toMatch(/expected 200, got 400/);
  });

  it('fails 404 (not wired) and 5xx (handler blew up), surfacing the message', () => {
    const notWired = classifyActionResponse('ping', false, undefined, 404, 'vendor its code');
    expect(notWired.ok).toBe(false);
    expect(notWired.detail).toMatch(/vendor its code/);
    expect(classifyActionResponse('ping', false, undefined, 500, 'boom').ok).toBe(false);
  });
});

describe('blockFootprint', () => {
  it('is the created objects plus many-to-many junction tables', () => {
    const manifest = {
      name: 'crm',
      relationships: [
        { name: 'tags', type: 'many_to_many', sourceObjectName: 'deals', targetObjectName: 'tags' },
        {
          name: 'company',
          type: 'many_to_one',
          sourceObjectName: 'deals',
          targetObjectName: 'companies',
        },
      ],
    } as unknown as Manifest;
    expect(blockFootprint(manifest, ['deals', 'tags'])).toEqual(
      new Set(['deals', 'tags', 'deals_tags']),
    );
  });
});

describe('evaluateDoctorReport (orphan teeth)', () => {
  const report = (findings: DoctorReportWire['findings']): DoctorReportWire => ({
    healthy: findings.length === 0,
    findings,
    ignored: [],
    checkedAt: '2026-07-08T00:00:00Z',
  });

  it('passes a clean report and ignores drift outside the footprint', () => {
    expect(evaluateDoctorReport(new Set(['leads']), report([])).ok).toBe(true);
    const outside = report([
      {
        kind: 'unmanaged_table',
        severity: 'warning',
        table: 'legacy_stuff',
        detail: 'not managed',
        ignoreKey: 'table:legacy_stuff',
      },
    ]);
    expect(evaluateDoctorReport(new Set(['leads']), outside).ok).toBe(true);
  });

  it('fails when an uninstall leaves a footprint table behind', () => {
    const orphan = report([
      {
        kind: 'unmanaged_table',
        severity: 'warning',
        table: 'deals_tags',
        detail: 'table exists but is not managed',
        ignoreKey: 'table:deals_tags',
      },
    ]);
    const result = evaluateDoctorReport(new Set(['deals', 'deals_tags']), orphan);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/unmanaged_table "deals_tags"/);
  });
});
