/**
 * `ion-drive schema <pull|diff|push|doctor>` — Git-friendly schema sync and
 * drift diagnosis (Phase 10 / ADR-017 rule 3).
 *
 * - `pull`   writes the server's declarative snapshot to `ion/schema.json`
 * - `diff`   shows what applying the local snapshot would change (server-side dry run)
 * - `push`   previews then applies the local snapshot through the validated pipeline
 * - `doctor` reports drift between the live Postgres catalog and Ion metadata,
 *            with `--adopt table[.column]` / `--ignore key` actions
 *
 * The snapshot file is the promotion vehicle: commit it, then `push` it against
 * staging/production — PocketBase-style environment promotion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ora from 'ora';
import prompts from 'prompts';
import {
  ApiError,
  type DoctorFindingWire,
  IonApiClient,
  type SchemaSnapshotWire,
  type SnapshotChange,
} from '../api-client.js';
import { readConfig } from '../config.js';
import { c, log, orbitSpinner, sym } from '../ui.js';

export const SNAPSHOT_PATH = join('ion', 'schema.json');

function client(): IonApiClient {
  const config = readConfig();
  return new IonApiClient(config.serverUrl, config.apiKey);
}

async function checkHealth(api: IonApiClient): Promise<boolean> {
  try {
    await api.health();
    return true;
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return false;
  }
}

function readLocalSnapshot(): SchemaSnapshotWire | null {
  if (!existsSync(SNAPSHOT_PATH)) {
    log.error(`No snapshot at ${SNAPSHOT_PATH} — run ${c.bold('ion-drive schema pull')} first.`);
    process.exitCode = 1;
    return null;
  }
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as SchemaSnapshotWire;
}

const CHANGE_GLYPH: Record<string, string> = {
  create_object: c.success('+'),
  add_field: c.success('+'),
  add_relationship: c.success('+'),
  modify_field: c.warn('~'),
  remove_field: c.danger('-'),
  delete_object: c.danger('-'),
};

function printChanges(changes: SnapshotChange[]): void {
  for (const change of changes) {
    log.raw(`  ${CHANGE_GLYPH[change.kind] ?? sym.dot} ${change.summary}`);
  }
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

export async function schemaPullCommand(): Promise<void> {
  const api = client();
  if (!(await checkHealth(api))) return;

  const spinner = ora({ text: 'Pulling schema snapshot…', spinner: orbitSpinner }).start();
  try {
    const snapshot = await api.pullSnapshot();
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    const count = snapshot.objects.length;
    spinner.stopAndPersist({
      symbol: sym.check,
      text: `Snapshot of ${c.bold(String(count))} object(s) written to ${c.cyan(SNAPSHOT_PATH)}`,
    });
    log.dim('    Commit it to version your schema; push it to promote environments.');
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger('pull failed') });
    log.error((err as Error).message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export async function schemaDiffCommand(options: { prune?: boolean }): Promise<void> {
  const api = client();
  if (!(await checkHealth(api))) return;
  const snapshot = readLocalSnapshot();
  if (!snapshot) return;

  const spinner = ora({ text: 'Diffing against the server…', spinner: orbitSpinner }).start();
  try {
    const { changes } = await api.diffSnapshot(snapshot, { prune: options.prune });
    spinner.stop();
    if (changes.length === 0) {
      log.success('Server schema matches the local snapshot. Nothing to apply.');
      return;
    }
    log.heading(`Schema diff — ${changes.length} change(s)`);
    printChanges(changes);
    log.raw();
    log.dim(`    Apply with ${c.bold('ion-drive schema push')}.`);
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger('diff failed') });
    log.error((err as Error).message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

export interface SchemaPushOptions {
  yes?: boolean;
  prune?: boolean;
  force?: boolean;
}

export async function schemaPushCommand(options: SchemaPushOptions): Promise<void> {
  const api = client();
  if (!(await checkHealth(api))) return;
  const snapshot = readLocalSnapshot();
  if (!snapshot) return;

  // Preview first — pushing is always preview-then-confirm.
  const { changes } = await api.diffSnapshot(snapshot, { prune: options.prune });
  if (changes.length === 0) {
    log.success('Server schema already matches the snapshot. Nothing to do.');
    return;
  }

  log.heading(`Schema push — ${changes.length} change(s)`);
  printChanges(changes);
  log.raw();

  const destructive = changes.filter(
    (ch) => ch.kind === 'remove_field' || ch.kind === 'delete_object',
  );
  if (destructive.length > 0) {
    log.warn(`${destructive.length} change(s) are destructive (data will be dropped).`);
  }

  if (!options.yes) {
    const { go } = await prompts({
      type: 'confirm',
      name: 'go',
      message: `Apply ${changes.length} change(s) to the server?`,
      initial: !destructive.length,
    });
    if (!go) {
      log.warn('Aborted.');
      return;
    }
  }

  const spinner = ora({ text: 'Applying snapshot…', spinner: orbitSpinner }).start();
  try {
    const result = await api.pushSnapshot(snapshot, { prune: options.prune, force: options.force });
    spinner.stopAndPersist({
      symbol: sym.check,
      text: `Applied ${c.bold(String(result.applied))} change(s). ${sym.rocket}`,
    });
  } catch (err) {
    spinner.stopAndPersist({ symbol: sym.cross, text: c.danger('push failed') });
    if (err instanceof ApiError) {
      log.error(err.message);
      log.dim('    Fix the reported issues (or re-run with --force for block-managed fields).');
    } else {
      log.error((err as Error).message);
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface SchemaDoctorOptions {
  adopt?: string;
  ignore?: string;
}

const SEVERITY_GLYPH: Record<DoctorFindingWire['severity'], string> = {
  info: sym.info,
  warning: sym.warn,
  critical: sym.cross,
};

export async function schemaDoctorCommand(options: SchemaDoctorOptions): Promise<void> {
  const api = client();
  if (!(await checkHealth(api))) return;

  try {
    if (options.adopt) {
      const [table, column] = options.adopt.split('.', 2);
      await api.adopt(table ?? options.adopt, column);
      log.success(`Adopted ${c.bold(options.adopt)} into managed metadata.`);
    }
    if (options.ignore) {
      await api.ignoreFinding(options.ignore);
      log.success(`Ignoring ${c.bold(options.ignore)} from now on.`);
    }

    const report = await api.doctor();
    if (report.healthy) {
      log.success('No schema drift detected. Database and metadata agree. ✨');
      if (report.ignored.length > 0) {
        log.dim(`    (${report.ignored.length} finding(s) on the ignore list)`);
      }
      return;
    }

    log.heading(`Schema doctor — ${report.findings.length} finding(s)`);
    for (const finding of report.findings) {
      log.raw(
        `  ${SEVERITY_GLYPH[finding.severity]} ${c.bold(finding.table)}${finding.column ? c.cyan(`.${finding.column}`) : ''} ${c.dim(`[${finding.kind}]`)}`,
      );
      log.raw(`      ${finding.detail}`);
      if (finding.suggestedType) {
        log.dim(
          `      adopt: ion-drive schema doctor --adopt ${finding.ignoreKey} (as ${finding.suggestedType})`,
        );
      }
      log.dim(`      ignore: ion-drive schema doctor --ignore ${finding.ignoreKey}`);
    }
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
  }
}
