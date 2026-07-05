#!/usr/bin/env node

/**
 * @module @ionshift/ion-drive-cli
 *
 * Ion Drive CLI — the command-line tool for managing Ion Drive projects and
 * installing building blocks (shadcn-style distribution). Space-themed output
 * throughout (see `ui.ts`).
 *
 * Commands:
 *   init             Scaffold ion.config.json (server URL + API key)
 *   list             List available building blocks
 *   add <block>      Resolve dependencies and install a block into the server
 *   remove <block>   Uninstall a block
 *   dev              Start the development server
 */

import { Command } from 'commander';
import { addCommand } from './commands/add.js';
import { devCommand } from './commands/dev.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { removeCommand } from './commands/remove.js';
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
  .description('Scaffold ion.config.json (and an optional client starter) for this project')
  .option('-s, --server-url <url>', 'Ion Drive server URL')
  .option('-k, --api-key <key>', 'API key (iond_…)')
  .option('-y, --yes', 'Skip prompts and accept defaults')
  .option('--starter', 'Scaffold a @ionshift/ion-drive-client TypeScript starter under ion/')
  .option('--skip-starter', 'Do not scaffold the client starter')
  .action((options) =>
    initCommand({
      serverUrl: options.serverUrl,
      apiKey: options.apiKey,
      yes: options.yes,
      starter: options.skipStarter ? false : options.starter,
    }),
  );

program
  .command('list')
  .alias('ls')
  .description('List available building blocks')
  .action(() => listCommand());

program
  .command('add')
  .argument('<block>', 'Block name (e.g. crm) or a registry URL')
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

program.parseAsync().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
