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
 *   list             List blocks available in the registry
 *   add <block>      Vendor a block's code + install it (deps resolved)
 *   remove <block>   Uninstall a block (your vendored code stays yours)
 *   dev              Run the project's server.ts (or core's, in the monorepo)
 *   schema …         Snapshot pull/diff/push + drift doctor
 *   block …          Block-authoring toolchain (new/validate/pack)
 */

import { Command } from 'commander';
import { addCommand } from './commands/add.js';
import { blockNewCommand, blockPackCommand, blockValidateCommand } from './commands/block.js';
import { devCommand } from './commands/dev.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { removeCommand } from './commands/remove.js';
import {
  schemaDiffCommand,
  schemaDoctorCommand,
  schemaPullCommand,
  schemaPushCommand,
} from './commands/schema.js';
import { banner, c, log, sym } from './ui.js';

const program = new Command();

program
  .name('ion-drive')
  .description('Ion Drive CLI — accelerated business software development')
  .version('0.1.0')
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
  .description('List available building blocks')
  .action(() => listCommand());

program
  .command('add')
  .argument('<block>', 'Block name (crm, crm@0.2.0), a block.json URL, or a local block path')
  .description('Install a building block and its dependencies')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('-d, --dry-run', 'Preview the changes without applying them')
  .option('-f, --force', 'Reinstall even if already installed')
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
  .option('--prune', 'Also plan removal of fields/objects absent from the snapshot')
  .action((options) => schemaDiffCommand(options));

schema
  .command('push')
  .description('Apply the local snapshot to the server (preview + confirm)')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .option('--prune', 'Also remove fields/objects absent from the snapshot (destructive)')
  .option('-f, --force', 'Override block contract protection on modified fields')
  .action((options) => schemaPushCommand(options));

schema
  .command('doctor')
  .description('Diagnose drift between the live database and Ion Drive metadata')
  .option('--adopt <key>', 'Adopt an unmanaged table or table.column into metadata')
  .option('--ignore <key>', 'Silence a finding (persisted allowlist)')
  .action((options) => schemaDoctorCommand(options));

const block = program
  .command('block')
  .description('Block-authoring toolchain (repo scaffold, validate, pack)');

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

program.parseAsync().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
