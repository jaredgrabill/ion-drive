/**
 * Docs curation pipeline tests (spec-10 AC2): allowlist behavior, H1→title
 * extraction, relative-link rewriting with fragments, the named
 * DocsLinkError/DocsCurationError failures, and end-to-end idempotency on a
 * temp tree.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DocsCurationError,
  DocsLinkError,
  curateDoc,
  curateDocs,
  extractTitle,
  isAllowlisted,
  rewriteLinks,
  routeForDoc,
} from './prepare-docs.mjs';

describe('isAllowlisted', () => {
  it('includes getting-started + concepts/api/deployment, excludes the rest', () => {
    expect(isAllowlisted('getting-started.md')).toBe(true);
    expect(isAllowlisted('concepts/events.md')).toBe(true);
    expect(isAllowlisted('api/querying.md')).toBe(true);
    expect(isAllowlisted('deployment/docker.md')).toBe(true);
    // research/, specs, phase plans, roadmap are deliberately unpublished.
    expect(isAllowlisted('research/architecture-decisions.md')).toBe(false);
    expect(isAllowlisted('roadmap.md')).toBe(false);
    expect(isAllowlisted('implementation_plan.md')).toBe(false);
    expect(isAllowlisted('phase_14_implementation_plan.md')).toBe(false);
    expect(isAllowlisted('concepts/diagram.png')).toBe(false);
  });
});

describe('extractTitle', () => {
  it('lifts the first H1 into the title and strips it from the body', () => {
    const { title, body } = extractTitle('# Getting Started\n\nHello.\n', 'getting-started.md');
    expect(title).toBe('Getting Started');
    expect(body).toBe('Hello.\n');
  });

  it('throws a named DocsCurationError when no H1 exists', () => {
    expect(() => extractTitle('no heading here', 'x.md')).toThrow(DocsCurationError);
    expect(() => extractTitle('no heading here', 'x.md')).toThrow(/x\.md.*# H1/);
  });
});

describe('routeForDoc', () => {
  it('maps docs-relative paths to /docs routes', () => {
    expect(routeForDoc('getting-started.md')).toBe('/docs/getting-started/');
    expect(routeForDoc('api/querying.md')).toBe('/docs/api/querying/');
  });
});

describe('rewriteLinks', () => {
  const included = (rel: string) =>
    ['getting-started.md', 'api/querying.md', 'concepts/events.md'].includes(rel);

  it('rewrites relative .md links to root-relative routes, fragments preserved', () => {
    expect(rewriteLinks('see [q](api/querying.md)', 'getting-started.md', included)).toBe(
      'see [q](/docs/api/querying/)',
    );
    expect(
      rewriteLinks('see [q](querying.md#free-text-search)', 'api/graphql.md', () => true),
    ).toBe('see [q](/docs/api/querying/#free-text-search)');
    expect(rewriteLinks('see [e](../concepts/events.md#x)', 'api/rest.md', included)).toBe(
      'see [e](/docs/concepts/events/#x)',
    );
  });

  it('passes through absolute, root-relative, mailto and fragment-only links', () => {
    const md = '[a](https://github.com/x/y.md) [b](/docs/api/rest/) [c](#anchor) [d](mailto:x@y.z)';
    expect(rewriteLinks(md, 'getting-started.md', included)).toBe(md);
  });

  it('throws a named DocsLinkError for excluded targets, naming source and target', () => {
    const run = () =>
      rewriteLinks('[adr](../research/architecture-decisions.md)', 'api/graphql.md', included);
    expect(run).toThrow(DocsLinkError);
    expect(run).toThrow(/api\/graphql\.md.*research\/architecture-decisions\.md/);
  });

  it('throws for missing targets too', () => {
    expect(() => rewriteLinks('[x](api/nope.md)', 'getting-started.md', included)).toThrow(
      DocsLinkError,
    );
  });
});

describe('curateDoc', () => {
  it('produces frontmatter + rewritten body', () => {
    const out = curateDoc(
      '# T "quoted"\n\n[q](api/querying.md)\n',
      'getting-started.md',
      () => true,
    );
    expect(out).toBe('---\ntitle: "T \\"quoted\\""\n---\n\n[q](/docs/api/querying/)\n');
  });
});

describe('curateDocs (end to end)', () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('copies only the allowlist, transforms files, and is idempotent', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'prep-docs-'));
    const src = path.join(tmp, 'docs');
    mkdirSync(path.join(src, 'concepts'), { recursive: true });
    mkdirSync(path.join(src, 'research'), { recursive: true });
    writeFileSync(path.join(src, 'getting-started.md'), '# Start\n\n[e](concepts/events.md)\n');
    writeFileSync(path.join(src, 'concepts', 'events.md'), '# Events\n\nBody.\n');
    writeFileSync(path.join(src, 'research', 'secret.md'), '# Secret\n');
    writeFileSync(path.join(src, 'roadmap.md'), '# Roadmap\n');

    const out = path.join(tmp, 'out');
    const first = curateDocs(src, out);
    expect(first.files).toEqual(['concepts/events.md', 'getting-started.md']);
    expect(readFileSync(path.join(out, 'getting-started.md'), 'utf8')).toContain(
      '[e](/docs/concepts/events/)',
    );
    // Excluded trees are absent from the output.
    expect(() => readFileSync(path.join(out, 'research', 'secret.md'))).toThrow();
    expect(() => readFileSync(path.join(out, 'roadmap.md'))).toThrow();

    // Idempotent: a second run over the same inputs yields the same output.
    const second = curateDocs(src, out);
    expect(second.files).toEqual(first.files);
    expect(readFileSync(path.join(out, 'getting-started.md'), 'utf8')).toContain('title: "Start"');
  });

  it('fails the whole run when any doc links to an excluded target', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'prep-docs-'));
    const src = path.join(tmp, 'docs');
    mkdirSync(path.join(src, 'api'), { recursive: true });
    writeFileSync(path.join(src, 'api', 'bad.md'), '# Bad\n\n[x](../research/adr.md)\n');
    expect(() => curateDocs(src, path.join(tmp, 'out'))).toThrow(DocsLinkError);
  });
});
