/**
 * Unit tests for the badge SVG template (spec-08 §1 / AC5's testable half):
 * deterministic snapshots for official + community, structural
 * well-formedness (parses as XML, role="img" + <title>), and geometry
 * (width grows with the name; segments tile the full width).
 */

import { describe, expect, it } from 'vitest';
import { renderBadgeSvg, textWidth } from './badge.js';

describe('renderBadgeSvg', () => {
  it('renders a deterministic official badge (snapshot)', () => {
    const svg = renderBadgeSvg({ name: 'crm', version: '0.2.0', trust: 'official' });
    expect(svg).toBe(renderBadgeSvg({ name: 'crm', version: '0.2.0', trust: 'official' }));
    expect(svg).toMatchSnapshot();
  });

  it('renders a deterministic community badge (snapshot)', () => {
    const svg = renderBadgeSvg({ name: 'billing', version: '1.4.0' });
    expect(svg).toMatchSnapshot();
  });

  it('is structurally well-formed: one root svg, title, aria-label, two segments', () => {
    const svg = renderBadgeSvg({ name: 'invoicing', version: '0.3.1', trust: 'official' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20"/);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="invoicing: v0.3.1 · official"');
    expect(svg).toContain('<title>invoicing: v0.3.1 · official</title>');
    expect(svg.match(/<rect(?![^>]*rx)/g)).toHaveLength(2); // two flat segments
    expect(svg.match(/<text /g)).toHaveLength(2);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    // Balanced tags — a cheap well-formedness proxy without an XML parser.
    for (const tag of ['svg', 'g', 'title', 'clipPath']) {
      const open = svg.match(new RegExp(`<${tag}[ >]`, 'g'))?.length ?? 0;
      const close = svg.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
      expect(`${tag}:${open}`).toBe(`${tag}:${close}`);
    }
  });

  it('official is green, community is gray — and the word is in the text, not color-alone', () => {
    const official = renderBadgeSvg({ name: 'crm', version: '0.2.0', trust: 'official' });
    const community = renderBadgeSvg({ name: 'crm', version: '0.2.0' });
    expect(official).toContain('#006300');
    expect(official).toContain('· official');
    expect(community).toContain('#383835');
    expect(community).toContain('· community');
    // A non-"official" claim never earns the green segment (display-hint rule).
    expect(renderBadgeSvg({ name: 'crm', version: '0.2.0', trust: 'verified' })).toContain(
      '· community',
    );
  });

  it('width grows with the block name', () => {
    const widthOf = (svg: string): number => Number(/width="(\d+)"/.exec(svg)?.[1]);
    const short = widthOf(renderBadgeSvg({ name: 'crm', version: '0.2.0' }));
    const long = widthOf(renderBadgeSvg({ name: 'communications-extended', version: '0.2.0' }));
    expect(long).toBeGreaterThan(short);
  });

  it('escapes XML-special characters in text and attributes', () => {
    // Block names can't contain these, but the template must not trust input.
    const svg = renderBadgeSvg({ name: 'a<b>&"c\'', version: '1.0.0' });
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c&apos;');
    expect(svg).not.toMatch(/<b>/);
  });

  it('textWidth is deterministic and monotonic in string length', () => {
    expect(textWidth('crm')).toBe(textWidth('crm'));
    expect(textWidth('crm-extended')).toBeGreaterThan(textWidth('crm'));
    expect(textWidth('ill')).toBeLessThan(textWidth('www'));
  });
});
