/**
 * `ion-drive diff <name>` — the three-way block diff (spec-07 §2).
 *
 * Compares, in order:
 *  1. **Manifest delta** — computed by the SERVER's dry-run upgrade
 *     (`POST /blocks/install?upgrade=true&dryRun=true` → `report.delta` +
 *     schema previews), so the CLI renders exactly what an update would do;
 *  2. **Code file status** — the pure three-way byte comparison (ledger
 *     snapshot × new artifact × the user's `blocks/<name>/**` tree), with a
 *     unified upstream diff (old→new) for every `modified by you` file —
 *     shown, never written;
 *  3. **Trailer** — the target's trust badge + digest, its `requires.core`
 *     against the server, and dependency-range implications (reported, not
 *     applied — `update --with-deps` performs them).
 */

import { createTwoFilesPatch } from 'diff';
import { ApiError, IonApiClient } from '../api-client.js';
import { ConfigError, readConfig } from '../config.js';
import { RegistryError } from '../registry/registry-client.js';
import { IntegrityError } from '../registry/verify.js';
import { box, c, log } from '../ui.js';
import { warnOnVersionSkew } from '../version-check.js';
import { sourceFor } from './add.js';
import {
  UpdateError,
  type UpdateTarget,
  codeFileStatuses,
  emptyDelta,
  readVendoredTree,
  renderCodeTable,
  renderManifestDelta,
  renderPreviews,
  renderTrailer,
  resolveUpdateTarget,
} from './update-shared.js';

export interface DiffOptions {
  version?: string;
  json?: boolean;
  /** Commander's `--no-verify-provenance` negation. */
  verifyProvenance?: boolean;
}

export async function diffCommand(name: string, options: DiffOptions): Promise<void> {
  const config = readConfig();
  const client = new IonApiClient(config.serverUrl, config.apiKey);

  try {
    const health = await client.health();
    warnOnVersionSkew(health.version);
    const target = await resolveUpdateTarget(name, options.version, config, client, {
      verifyProvenance: options.verifyProvenance !== false,
    });
    await renderDiff(client, target, health.version, options);
  } catch (err) {
    failFriendly(err);
  }
}

/** The shared diff body — `update` calls this too before confirming. */
export async function renderDiff(
  client: IonApiClient,
  target: UpdateTarget,
  serverVersion: string,
  options: { json?: boolean },
): Promise<void> {
  const oldCode = (target.installed.manifest?.code ?? []) as { path: string; contents: string }[];
  const newCode = (target.verified.manifest.code ?? []) as { path: string; contents: string }[];
  const code = codeFileStatuses(oldCode, newCode, readVendoredTree(target.name));

  // Same version = nothing to diff server-side; local code drift still shows.
  // A failed server row never counts as up-to-date (AC4): let the server's
  // upgrade gates recompute against the preserved snapshot and answer.
  const upToDate =
    target.verified.item.version === target.currentVersion && target.installed.status !== 'failed';
  const report = upToDate
    ? undefined
    : await client.install(target.verified.manifest, {
        dryRun: true,
        upgrade: true,
        source: sourceFor(target.verified),
      });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          name: target.name,
          current: target.currentVersion,
          target: target.verified.item.version,
          upToDate,
          tier: target.verified.tier,
          digest: target.verified.computedDigest,
          requiresCore: target.requiresCore ?? null,
          dependencyNotes: target.dependencyNotes,
          delta: report?.delta ?? null,
          previews: report?.previews ?? [],
          code: code.map(({ path, status }) => ({ path, status })),
        },
        null,
        2,
      ),
    );
    return;
  }

  log.raw();
  if (upToDate) {
    log.info(
      `${c.bold(target.name)} is already at ${c.bold(target.currentVersion)} — nothing to update. Code drift vs the installed snapshot, if any, is listed below.`,
    );
  } else {
    console.log(
      box(
        `Manifest ${target.currentVersion} → ${target.verified.item.version}`,
        renderManifestDelta(
          report?.delta ?? emptyDelta(target.currentVersion, target.verified.item.version),
        ),
      ),
    );
    const previewLines = renderPreviews(report?.previews);
    if (previewLines.length > 0) {
      log.raw();
      console.log(box('Schema previews (server dry run)', previewLines));
    }
  }

  log.raw();
  console.log(box(`Code — blocks/${target.name}/`, renderCodeTable(code)));
  renderUpstreamDiffs(target, code);

  log.raw();
  for (const line of renderTrailer(target, serverVersion)) console.log(line);
}

/** Unified old→new diffs for the files the user modified (shown, not written). */
function renderUpstreamDiffs(
  target: UpdateTarget,
  code: ReturnType<typeof codeFileStatuses>,
): void {
  for (const file of code) {
    if (file.status !== 'modified-by-you' || file.newContents === undefined) continue;
    const patch = createTwoFilesPatch(
      file.path,
      file.path,
      file.oldContents ?? '',
      file.newContents,
      `installed ${target.currentVersion}`,
      `upstream ${target.verified.item.version}`,
    );
    log.raw();
    log.info(`upstream changes to ${c.cyan(file.path)} (yours is untouched):`);
    for (const line of patch.split('\n')) {
      const painted = line.startsWith('+')
        ? c.success(line)
        : line.startsWith('-')
          ? c.danger(line)
          : c.dim(line);
      console.log(`  ${painted}`);
    }
  }
}

/** Shared friendly-failure handler for the diff/update flows. */
export function failFriendly(err: unknown): void {
  if (
    err instanceof ApiError ||
    err instanceof RegistryError ||
    err instanceof UpdateError ||
    err instanceof ConfigError ||
    err instanceof IntegrityError
  ) {
    log.error(err.message);
    process.exitCode = 1;
    return;
  }
  throw err;
}
