/**
 * `ion-drive audit` — the ecosystem's Dependabot-lite (spec-06 §3).
 *
 * Reads the project's installed-block records (`ion.config.json.blocks[]` —
 * the config-as-lockfile, ADR-022) and checks each registry-sourced block
 * against its registry's current metadata:
 *
 *  - **Advisories** whose `affectedVersions` range matches the installed
 *    version (an invalid range **fails closed** — treated as affected, with a
 *    warning notice).
 *  - **Status**: the installed version is now `yanked` or `deprecated`.
 *  - **Digest drift**: the registry's digest for the installed version no
 *    longer equals the digest recorded at install time — a released version
 *    was mutated. Loud.
 *  - **Ledger drift** (best-effort server enrichment): the server's
 *    `_ion_blocks` ledger disagrees with the config record (version or
 *    artifact digest) — someone changed the server out-of-band. An
 *    unreachable server degrades to a config-only audit with one notice.
 *  - **Updates**: a newer `active` version exists (informational only).
 *
 * Local-path and direct-URL installs are listed as *unauditable* (no registry
 * can vouch for them) — informational, never a failure. An unreachable
 * registry likewise makes its blocks unauditable with a warning, not exit 1.
 *
 * Exit codes are CI-friendly: 0 clean, 1 when any advisory/yank/deprecation/
 * digest-drift/ledger-drift finding exists. `--json` prints the stable
 * `{ clean, blocks, unauditable, notices }` shape.
 */

import semver from 'semver';
import { ApiError, type InstalledBlock, IonApiClient } from '../api-client.js';
import { ConfigError, type InstalledBlockRecord, readConfig } from '../config.js';
import {
  type RegistryBlockDoc,
  RegistryError,
  fetchBlock,
  resolveRegistry,
} from '../registry/registry-client.js';
import { c, log, sym } from '../ui.js';

export interface AuditOptions {
  json?: boolean;
  /** Commander's `--no-cache` negation. */
  cache?: boolean;
}

/** Finding kinds. The first five fail the audit; `update_available` never does. */
export type AuditFindingKind =
  | 'advisory'
  | 'yanked'
  | 'deprecated'
  | 'digest_drift'
  | 'ledger_drift'
  | 'update_available';

export interface AuditFinding {
  kind: AuditFindingKind;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}

export interface AuditBlockReport {
  name: string;
  version: string;
  source: string;
  findings: AuditFinding[];
}

export interface UnauditableBlock {
  name: string;
  version: string;
  source: string;
  reason: string;
}

/** The stable `--json` shape. */
export interface AuditReport {
  clean: boolean;
  blocks: AuditBlockReport[];
  unauditable: UnauditableBlock[];
  notices: string[];
}

const FAILING_KINDS: ReadonlySet<AuditFindingKind> = new Set([
  'advisory',
  'yanked',
  'deprecated',
  'digest_drift',
  'ledger_drift',
]);

/** What the command feeds the pure assembler for one registry-sourced block. */
export type AuditDoc = RegistryBlockDoc | 'unreachable';

// ---------------------------------------------------------------------------
// Pure assembly (unit-tested against fake registries/config/ledgers)
// ---------------------------------------------------------------------------

/**
 * Pure: assembles the full audit report from the config records, the fetched
 * registry docs (`'unreachable'` marks a registry that could not be fetched),
 * and — when available — the server's ledger rows.
 */
export function assembleAuditReport(
  records: InstalledBlockRecord[],
  docs: Map<string, AuditDoc>,
  ledger?: Map<string, InstalledBlock>,
): AuditReport {
  const report: AuditReport = { clean: true, blocks: [], unauditable: [], notices: [] };

  for (const record of records) {
    // Local/URL sources have no registry expectation — informational only.
    if (!record.source.startsWith('@')) {
      report.unauditable.push({
        name: record.name,
        version: record.version,
        source: record.source,
        reason:
          record.source === 'local'
            ? 'installed from a local path — no registry can vouch for it'
            : 'installed from a direct URL — no registry can vouch for it',
      });
      continue;
    }

    const doc = docs.get(record.name);
    if (doc === undefined || doc === 'unreachable') {
      report.unauditable.push({
        name: record.name,
        version: record.version,
        source: record.source,
        reason: `registry ${record.source} could not be fetched — re-run when it is reachable`,
      });
      report.notices.push(
        `${record.name}: registry ${record.source} unreachable — its blocks were not audited`,
      );
      continue;
    }

    const findings = [
      ...advisoryFindings(record, doc, report.notices),
      ...statusFindings(record, doc),
      ...updateFindings(record, doc),
      ...ledgerFindings(record, ledger),
    ];
    report.blocks.push({
      name: record.name,
      version: record.version,
      source: record.source,
      findings,
    });
  }

  // Ledger drift also applies to local/URL installs — the server row must
  // still match what the config recorded.
  for (const entry of report.unauditable) {
    const record = records.find((r) => r.name === entry.name);
    if (!record) continue;
    const findings = ledgerFindings(record, ledger);
    if (findings.length > 0) {
      report.blocks.push({
        name: record.name,
        version: record.version,
        source: record.source,
        findings,
      });
    }
  }

  report.clean = report.blocks.every((block) =>
    block.findings.every((finding) => !FAILING_KINDS.has(finding.kind)),
  );
  return report;
}

/** Advisories matching the installed version; invalid ranges fail closed. */
function advisoryFindings(
  record: InstalledBlockRecord,
  doc: RegistryBlockDoc,
  notices: string[],
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const advisory of doc.advisories ?? []) {
    let affected: boolean;
    if (semver.validRange(advisory.affectedVersions) === null) {
      affected = true; // fails closed: an unparsable range never hides an advisory
      notices.push(
        `${record.name}: advisory ${advisory.id} has an invalid affectedVersions range ${JSON.stringify(advisory.affectedVersions)} — treating the installed version as affected (fails closed)`,
      );
    } else {
      affected = semver.satisfies(record.version, advisory.affectedVersions);
    }
    if (affected) {
      findings.push({
        kind: 'advisory',
        severity: 'critical',
        detail: `${advisory.id} (${advisory.severity}): ${advisory.description}${advisory.url ? ` — ${advisory.url}` : ''}`,
      });
    }
  }
  return findings;
}

/** Yanked/deprecated status + the digest-drift check for the installed version. */
function statusFindings(record: InstalledBlockRecord, doc: RegistryBlockDoc): AuditFinding[] {
  const entry = doc.versions[record.version];
  if (!entry) {
    return [
      {
        kind: 'digest_drift',
        severity: 'critical',
        detail: `installed version ${record.version} is no longer in the registry — the registry mutated a released version (or the block was taken down)`,
      },
    ];
  }
  const findings: AuditFinding[] = [];
  if (entry.status === 'yanked') {
    findings.push({
      kind: 'yanked',
      severity: 'critical',
      detail: `installed version ${record.version} was yanked${entry.statusReason ? `: ${entry.statusReason}` : ''}`,
    });
  } else if (entry.status === 'deprecated') {
    findings.push({
      kind: 'deprecated',
      severity: 'warning',
      detail: `installed version ${record.version} is deprecated${entry.statusReason ? `: ${entry.statusReason}` : ''}`,
    });
  }
  if (record.digest !== null && entry.digest !== record.digest) {
    findings.push({
      kind: 'digest_drift',
      severity: 'critical',
      detail: `the registry now serves a different digest for ${record.version} — the registry mutated a released version (recorded ${record.digest}, registry ${entry.digest})`,
    });
  }
  return findings;
}

/** Informational: a newer active version exists. */
function updateFindings(record: InstalledBlockRecord, doc: RegistryBlockDoc): AuditFinding[] {
  const newest = Object.entries(doc.versions)
    .filter(([version, entry]) => entry.status === 'active' && semver.valid(version) !== null)
    .map(([version]) => version)
    .sort(semver.rcompare)[0];
  if (!newest || semver.valid(record.version) === null || !semver.gt(newest, record.version)) {
    return [];
  }
  return [
    {
      kind: 'update_available',
      severity: 'info',
      detail: `newer active version ${newest} available (installed ${record.version})`,
    },
  ];
}

/** Server-mode: the ledger row must match the config record. */
function ledgerFindings(
  record: InstalledBlockRecord,
  ledger: Map<string, InstalledBlock> | undefined,
): AuditFinding[] {
  if (!ledger) return [];
  const row = ledger.get(record.name);
  if (!row) {
    return [
      {
        kind: 'ledger_drift',
        severity: 'critical',
        detail:
          'recorded in ion.config.json but not installed on the server (removed out-of-band?)',
      },
    ];
  }
  const findings: AuditFinding[] = [];
  if (row.version !== record.version) {
    findings.push({
      kind: 'ledger_drift',
      severity: 'critical',
      detail: `server ledger has v${row.version} but ion.config.json recorded v${record.version} (changed out-of-band?)`,
    });
  }
  const ledgerDigest = row.artifactDigest ?? null;
  if (ledgerDigest !== null && record.digest !== null && ledgerDigest !== record.digest) {
    findings.push({
      kind: 'ledger_drift',
      severity: 'critical',
      detail: `server ledger digest ${ledgerDigest} ≠ recorded ${record.digest} (different bytes were installed out-of-band?)`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The command shell
// ---------------------------------------------------------------------------

export async function auditCommand(options: AuditOptions = {}): Promise<void> {
  try {
    await runAudit(options);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RegistryError || err instanceof ApiError) {
      if (options.json) console.log(JSON.stringify({ error: err.message }, null, 2));
      else log.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function runAudit(options: AuditOptions): Promise<void> {
  const config = readConfig();
  const records = config.blocks;
  const extraNotices: string[] = [];

  // Best-effort server enrichment: unreachable ⇒ one notice, config-only.
  let ledger: Map<string, InstalledBlock> | undefined;
  try {
    const client = new IonApiClient(config.serverUrl, config.apiKey);
    ledger = new Map(
      (await client.listInstalled())
        .filter((b) => b.status === 'installed')
        .map((b) => [b.name, b] as const),
    );
  } catch (err) {
    extraNotices.push(
      `server ${config.serverUrl} unreachable (${(err as Error).message}) — config-only audit (no ledger-drift checks)`,
    );
  }

  // Fetch each registry-sourced block's current doc (cache honored by default).
  const noCache = options.cache === false;
  const docs = new Map<string, AuditDoc>();
  for (const record of records) {
    if (!record.source.startsWith('@')) continue;
    try {
      const reg = resolveRegistry(record.source, config);
      const { doc } = await fetchBlock(reg, record.name, { noCache });
      docs.set(record.name, doc);
    } catch {
      docs.set(record.name, 'unreachable');
    }
  }

  const report = assembleAuditReport(records, docs, ledger);
  report.notices.push(...extraNotices);

  render(report, records.length, options);
  if (!report.clean) process.exitCode = 1;
}

function render(report: AuditReport, recordCount: number, options: AuditOptions): void {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  log.raw();
  if (recordCount === 0) {
    log.info('No blocks recorded in ion.config.json — nothing to audit.');
    return;
  }
  for (const block of report.blocks) renderBlock(block);
  for (const entry of report.unauditable) {
    log.raw(
      `${sym.dot} ${c.bold(entry.name)}${c.meteor(`@${entry.version}`)} ${c.meteor(`· ${entry.source} · unauditable — ${entry.reason}`)}`,
    );
  }
  for (const notice of report.notices) log.warn(notice);
  log.raw();
  if (report.clean) log.success('Audit clean.');
  else log.error('Audit found problems — see above.');
}

/** One audited block: verdict glyph + its findings, severity-painted. */
function renderBlock(block: AuditBlockReport): void {
  const failing = block.findings.some((f) => FAILING_KINDS.has(f.kind));
  const glyph = failing ? sym.cross : sym.check;
  log.raw(
    `${glyph} ${c.bold(block.name)}${c.meteor(`@${block.version}`)} ${c.meteor(`· ${block.source}`)}`,
  );
  for (const finding of block.findings) {
    log.raw(
      `    ${sym.dot} ${severityPaint(finding.severity)(`[${finding.kind}]`)} ${finding.detail}`,
    );
  }
}

function severityPaint(severity: AuditFinding['severity']): (text: string) => string {
  if (severity === 'critical') return c.danger;
  if (severity === 'warning') return c.warn;
  return c.meteor;
}
