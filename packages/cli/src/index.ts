#!/usr/bin/env node

/**
 * @module @ion-drive/cli
 *
 * Ion Drive CLI — the command-line tool for managing Ion Drive projects and
 * installing building blocks (shadcn-style distribution). Space-themed output
 * throughout (see `ui.ts`).
 *
 * Commands:
 *   init [dir]       Scaffold a user-owned framework project (Phase 14)
 *   list             List a registry's block catalog (--registry/--all)
 *   add <ref>        Vendor a block's code + install it (deps resolved)
 *   remove <block>   Uninstall a block (your vendored code stays yours)
 *   dev              Run the project's server.ts (or core's, in the monorepo)
 *   schema …         Snapshot pull/diff/push + drift doctor
 *   block …          Block-authoring toolchain (new/validate/pack/verify/publish)
 *   registry …       Configured registries (list/add/remove/ping) + the
 *                    registry-repo generator/admin loop (build/yank/deprecate)
 */

import { Command } from 'commander';
import { addCommand } from './commands/add.js';
import {
  blockNewCommand,
  blockPackCommand,
  blockPublishCommand,
  blockValidateCommand,
} from './commands/block.js';
import { devCommand } from './commands/dev.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import {
  registryAddCommand,
  registryBuildCommand,
  registryDeprecateCommand,
  registryListCommand,
  registryPingCommand,
  registryRemoveCommand,
  registryYankCommand,
} from './commands/registry.js';
import { removeCommand } from './commands/remove.js';
import {
  schemaDiffCommand,
  schemaDoctorCommand,
  schemaPullCommand,
  schemaPushCommand,
} from './commands/schema.js';
import { blockVerifyCommand } from './commands/verify.js';
import { banner, c, log, sym } from './ui.js';
import { CLI_VERSION } from './version-check.js';

const program = new Command();

program
  .name('ion-drive')
  .description('Ion Drive CLI — accelerated business software development')
  .version(CLI_VERSION)
  .addHelpText('beforeAll', banner())
  .configureOutput({
    outputError: (str, write) => write(`${sym.cross} ${c.danger(str.trim())}\n`),
  });

program
  .command('init')
  .argument('[directory]', 'Directory to scaffold into (default: current directory)')
  .description('Scaffold a user-owned Ion Drive project (server.ts, /blocks, env, compose)')
  .option('-s, --server-url <url>', 'Ion Drive server URL')
  .option('-k, --api-key <key>', 'API key (iond_…)')
  .option('-y, --yes', 'Skip prompts and accept defaults')
  .option('--config-only', 'Only write ion.config.json pointing at an existing server')
  .option('--skip-starter', 'Do not scaffold the ion/ client starter')
  .action((directory, options) =>
    initCommand(directory, {
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      yes: options.yes,
      configOnly: options.configOnly,
      starter: options.skipStarter ? false : undefined,
    }),
  );

program
  .command('list')
  .alias('ls')
  .description('List available building blocks (default registry unless --registry/--all)')
  .option('-r, --registry <@ns>', 'List a specific configured registry')
  .option('-a, --all', 'List every configured registry')
  .option('--no-cache', 'Bypass the registry metadata cache')
  .action((options) => listCommand(options));

program
  .command('add')
  .argument(
    '<ref>',
    'Block ref (crm, crm@^0.2.0, @acme/billing@1.x), a block.json URL, or a local block path',
  )
  .description('Install a building block and its dependencies')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('-d, --dry-run', 'Preview the changes without applying them')
  .option(
    '-f, --force',
    'Reinstall an installed block, proceed through installed-version range conflicts, and force-reinstall on the server (never bypasses digest verification)',
  )
  .option('--no-cache', 'Bypass the registry metadata cache')
  .option('--show-code', 'List each vendored file (path, bytes, sha256) before confirming')
  .option('--no-verify-provenance', 'Skip attestation checks (digest verification always runs)')
  .action((block, options) => addCommand(block, options));

program
  .command('remove')
  .alias('rm')
  .argument('<block>', 'Name of the building block to remove')
  .description('Uninstall a building block')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('--drop-data', 'Also drop tables that still contain rows')
  .action((block, options) => removeCommand(block, options));

program
  .command('dev')
  .description('Start the Ion Drive development server')
  .option('-p, --port <port>', 'Port to run the server on')
  .action((options) => devCommand(options));

const schema = program
  .command('schema')
  .description('Schema sync & drift tools (pull/diff/push/doctor)');

schema
  .command('pull')
  .description('Write the server schema snapshot to ion/schema.json')
  .action(() => schemaPullCommand());

schema
  .command('diff')
  .description('Show what applying the local snapshot would change')
  .option('--prune', 'Also plan removal of fields/relationships/objects absent from the snapshot')
  .action((options) => schemaDiffCommand(options));

schema
  .command('push')
  .description('Apply the local snapshot to the server (preview + confirm)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option(
    '--prune',
    'Also remove fields/relationships/objects absent from the snapshot (destructive)',
  )
  .option('-f, --force', 'Override block contract protection on modified fields/relationships')
  .action((options) => schemaPushCommand(options));

schema
  .command('doctor')
  .description('Diagnose drift between the live database and Ion Drive metadata')
  .option('--adopt <key>', 'Adopt an unmanaged table or table.column into metadata')
  .option('--ignore <key>', 'Silence a finding (persisted allowlist)')
  .action((options) => schemaDoctorCommand(options));

const block = program
  .command('block')
  .description('Block-authoring toolchain (repo scaffold, validate, pack, publish, verify)');

block
  .command('new')
  .argument('<name>', 'Block name (scaffolds ./block-<name>)')
  .description('Scaffold a new block repo (block.json + code/ + CI)')
  .action((name) => blockNewCommand(name));

block
  .command('validate')
  .argument('[dir]', 'Block repo directory (default: current)')
  .description('Validate block.json (platform Zod schema + code checks)')
  .action((dir) => blockValidateCommand(dir));

block
  .command('pack')
  .argument('[dir]', 'Block repo directory (default: current)')
  .description('Emit dist/block.json with code/ embedded (the registry artifact)')
  .action((dir) => blockPackCommand(dir));

block
  .command('publish')
  .argument('[dir]', 'Block repo directory (default: current)')
  .description('Publish a block to a git-hosted registry repo (clone → build → PR or push)')
  .option('--registry-repo <repo>', 'Target registry repo (owner/repo, git URL, or local path)')
  .option('--pr', 'Open a pull request (default)')
  .option('--direct', 'Push straight to the default branch instead of opening a PR')
  .option('-d, --dry-run', 'Stop after the temp-dir registry build, printing the plan')
  .option('--json', 'Plain JSON output')
  .action((dir, options) =>
    blockPublishCommand(dir, {
      registryRepo: options.registryRepo,
      pr: options.pr,
      direct: options.direct,
      dryRun: options.dryRun,
      json: options.json,
    }),
  );

block
  .command('verify')
  .argument('<ref>', 'Registry ref (crm, crm@0.2.0, @acme/billing@1.0.0), URL, or local path')
  .description('Verify a published block: digest, attestation, trust tier (spec-04)')
  .option('--against-installed', "Also compare the server ledger's digest with the registry's")
  .option('--json', 'Plain JSON output')
  .action((ref, options) =>
    blockVerifyCommand(ref, { againstInstalled: options.againstInstalled, json: options.json }),
  );

const registry = program
  .command('registry')
  .description('Manage configured block registries (spec-03) and registry repos (spec-05)');

registry
  .command('build')
  .argument('[dir]', 'Registry repo directory (default: current)')
  .description('Generate registry JSON: pack new versions, regenerate blocks/*.json + index.json')
  .option('--check', 'CI drift guard: run everything, write nothing, fail on any would-be change')
  .option('--block <name>', 'Limit packing/regeneration to one block')
  .option('--json', 'Plain JSON output (includes packed[] for the publish workflow)')
  .action((dir, options) =>
    registryBuildCommand(dir, { check: options.check, block: options.block, json: options.json }),
  );

registry
  .command('yank')
  .argument('<ref>', 'Released version to yank, as <name>@<version>')
  .description('Mark a released version yanked in the local registry checkout')
  .option('--reason <text>', 'Human context recorded as statusReason')
  .option('--json', 'Plain JSON output')
  .action((ref, options) => registryYankCommand(ref, options));

registry
  .command('deprecate')
  .argument('<ref>', 'Released version to deprecate, as <name>@<version>')
  .description('Mark a released version deprecated in the local registry checkout')
  .option('--reason <text>', 'Human context recorded as statusReason')
  .option('--json', 'Plain JSON output')
  .action((ref, options) => registryDeprecateCommand(ref, options));

registry
  .command('list')
  .description('Show configured registries with block counts and staleness')
  .option('--json', 'Plain JSON output')
  .option('--no-cache', 'Bypass the registry metadata cache')
  .action((options) => registryListCommand(options));

registry
  .command('add')
  .argument('<namespace>', 'Registry namespace, e.g. @acme')
  .argument('[url]', "URL of the registry's index.json")
  .description('Validate a registry and add it to ion.config.json')
  .option('--json', 'Plain JSON output')
  .action((namespace, url, options) => registryAddCommand(namespace, url, options));

registry
  .command('remove')
  .alias('rm')
  .argument('<namespace>', 'Registry namespace, e.g. @acme')
  .description('Remove a configured registry (refuses while installed blocks came from it)')
  .option('-f, --force', 'Remove even while installed blocks reference it')
  .option('--json', 'Plain JSON output')
  .action((namespace, options) => registryRemoveCommand(namespace, options));

registry
  .command('ping')
  .argument('[namespace]', 'Registry namespace (default: the default registry)')
  .description('Fetch + validate a registry index fresh, reporting latency')
  .option('--json', 'Plain JSON output')
  .action((namespace, options) => registryPingCommand(namespace, options));

program.parseAsync().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
