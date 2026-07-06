/**
 * Project starter scaffolding for `ion-drive init`.
 *
 * The ultimate point of the CLI is to bootstrap a new project fast: install
 * building blocks on the server, then talk to them from application code. This
 * writes a tiny, ready-to-run TypeScript starter that wires up the
 * `@ion-drive/client` SDK and demonstrates the paged-search query DSL (text
 * search + property operators). Files are only written when missing — the
 * scaffold never clobbers a consumer's code.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { c, log, sym } from './ui.js';

/** Directory (relative to the project root) the starter is written into. */
const STARTER_DIR = 'ion';

const CLIENT_TS = `/**
 * Ion Drive client — a single shared instance for your app.
 *
 * Configure it with environment variables so the same code runs in dev and
 * production without edits.
 */
import { IonDriveClient } from '@ion-drive/client';

export const ion = new IonDriveClient({
  baseUrl: process.env.ION_DRIVE_URL ?? 'http://localhost:3000',
  apiKey: process.env.ION_DRIVE_API_KEY,
});
`;

const EXAMPLE_TS = `/**
 * Example: paged search over a data object.
 *
 * Combine a free-text \`search\` term with property filters (any operator:
 * eq, neq, gt, gte, lt, lte, like, ilike, in, nin, is_null, is_not_null),
 * sorting, and pagination. Swap "contacts" for one of your own objects — or
 * install the CRM block first with \`ion-drive add crm\`.
 */
import { ion } from './client.js';

async function main() {
  // Awaiting the fluent chain executes it (Supabase-style).
  const { data, pagination } = await ion
    .from('contacts')
    .select('id, full_name, email')
    .search('acme') // matches any text-like column
    .neq('status', 'archived') // property + operator
    .gt('created_at', '2020-10-10')
    .order('created_at', { ascending: false })
    .range(0, 19); // first 20 rows

  console.log(\`Found \${pagination.totalCount} match(es):\`);
  for (const row of data) console.log(row);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

const README_MD = `# Ion Drive starter

This folder was scaffolded by \`ion-drive init\`. It wires up the
[\`@ion-drive/client\`](https://github.com/jaredgrabill/ion-drive) SDK.

## Setup

\`\`\`bash
npm install @ion-drive/client
export ION_DRIVE_URL=http://localhost:3000
export ION_DRIVE_API_KEY=iond_...   # optional, if auth is enabled
\`\`\`

## Files

- \`client.ts\` — a shared \`IonDriveClient\` instance.
- \`example.ts\` — a paged-search demo (text search + property operators).

## Query cheatsheet

\`\`\`ts
import { ion } from './client.js';

// Fluent + awaitable (Supabase-style) — no terminal call needed:
const { data } = await ion.from('contacts')
  .select('id, full_name')
  .search('acme')
  .neq('status', 'archived')
  .in('tier', ['gold', 'platinum'])
  .gte('created_at', '2020-10-10')
  .order('created_at', { ascending: false })
  .range(0, 24);

// Single-row terminals:
const one = await ion.from('contacts').select().eq('id', id).single();
const maybe = await ion.from('contacts').select().eq('email', e).maybeSingle();

// Writes:
await ion.from('contacts').insert({ full_name: 'Ada' });
await ion.from('contacts').update(id, { status: 'archived' });
await ion.from('contacts').delete(id);

// Or build a raw query string for an existing fetch:
import { query } from '@ion-drive/client';
const qs = query().neq('name', 'John').gt('age', 21).toQueryString();
// => "name[neq]=John&age[gt]=21"
fetch(\`\${baseUrl}/api/v1/data/contacts?\${qs}\`);
\`\`\`
`;

interface StarterFile {
  path: string;
  contents: string;
}

const STARTER_FILES: StarterFile[] = [
  { path: 'client.ts', contents: CLIENT_TS },
  { path: 'example.ts', contents: EXAMPLE_TS },
  { path: 'README.md', contents: README_MD },
];

/**
 * Writes the starter files under `<dir>/ion/`, skipping any that already exist.
 * Returns the list of files actually created (relative paths).
 */
export function writeStarter(dir = process.cwd()): string[] {
  const root = join(resolve(dir), STARTER_DIR);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const created: string[] = [];
  for (const file of STARTER_FILES) {
    const target = join(root, file.path);
    if (existsSync(target)) continue;
    writeFileSync(target, file.contents, 'utf8');
    created.push(`${STARTER_DIR}/${file.path}`);
  }
  return created;
}

/** Prints a friendly summary of what the scaffold created. */
export function reportStarter(created: string[]): void {
  if (created.length === 0) {
    log.dim(`  ${sym.dot} Starter files already present — left untouched.`);
    return;
  }
  for (const path of created) {
    log.raw(`  ${sym.check} ${c.cyan(path)}`);
  }
  log.raw(`  ${c.meteor('Install the SDK:')} ${c.star('npm install @ion-drive/client')}`);
}
